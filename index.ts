import express from "express";
import { x402Facilitator, FacilitatorSettleResultContext } from "@x402/core/facilitator";
import type {
  PaymentRequirements,
  PaymentPayload,
  VerifyResponse,
  SettleResponse,
} from "@x402/core/types";
import { ExactEvmScheme } from "@x402/evm/exact/facilitator";
import { ExactEvmSchemeV1 as ExactEvmSchemeV1Facilitator } from "@x402/evm/exact/v1/facilitator";
import type { Address, Authorization } from "viem";

// Import config
import { PORT, FACILITATOR_PRIVATE_KEY, REDIS_URL } from "./src/config/env";

// Import utils
import { createFacilitatorSigners } from "./src/utils/signers";

// Import services
import { registerAgent } from "./src/services/registerService";
import { giveFeedback, getReputationSummary } from "./src/services/reputationService";
import { createRedisStore } from "./src/services/redisStore";

// Import metrics
import {
  register as metricsRegister,
  settlementCounter,
  registrationCounter,
  feedbackCounter,
  settlementDuration,
  verifyCounter,
  verifyDuration,
} from "./src/services/metrics";

// ============================================================================
// Configuration & Initialization
// ============================================================================

const { evmAccount, baseSepoliaSigner, baseMainnetSigner } = createFacilitatorSigners(
  FACILITATOR_PRIVATE_KEY as `0x${string}`,
);
console.log("facilitator address:", evmAccount.address);

const facilitator = new x402Facilitator();

// Register v2 networks - separate registration for each chain
// @ts-ignore
facilitator.register(["eip155:84532"], new ExactEvmScheme(baseSepoliaSigner));
// @ts-ignore
facilitator.register(["eip155:8453"], new ExactEvmScheme(baseMainnetSigner));

// Register v1 networks - separate registration for each chain
// @ts-ignore
facilitator.registerV1(["base-sepolia"] as any, new ExactEvmSchemeV1Facilitator(baseSepoliaSigner));
// @ts-ignore
facilitator.registerV1(["base"] as any, new ExactEvmSchemeV1Facilitator(baseMainnetSigner));

// ============================================================================
// Data Stores
// ============================================================================

const agentAddressStore = createRedisStore<string>(REDIS_URL);

// ============================================================================
// Extension Setup
// ============================================================================
facilitator.registerExtension("erc-8004").onAfterSettle(async context => {
  const endTimer = settlementDuration.startTimer();
  const network = context.paymentPayload.accepted?.network || "unknown";

  try {
    await register(context);
    settlementCounter.inc({ network, status: "success" });
  } catch (error) {
    settlementCounter.inc({ network, status: "error" });
    console.error("Extension error:", error);
  } finally {
    endTimer({ network });
  }
});

const register = async (context: FacilitatorSettleResultContext) => {
  const paymentPayload = context.paymentPayload;
  const extensions = paymentPayload.extensions;

  const registeryInfo = extensions?.["erc-8004"] as
    | {
        registerAuth?: Authorization;
        tokenURI?: string;
        metadata?: { key: string; value: string }[];
      }
    | undefined;
  if (!registeryInfo) {
    return;
  }

  const agentAddress = (paymentPayload.accepted.payTo as Address).toLowerCase();
  const agentId = await agentAddressStore.get(agentAddress);
  if (agentId) {
    console.log(`✅ Agent ${agentId} already registered, skipping registration`);
    return;
  }

  const registerAuth = registeryInfo.registerAuth;

  try {
    const deserializedAuthorization = {
      chainId: BigInt((registerAuth as any).chainId),
      address: (registerAuth as any).address as Address,
      nonce: BigInt((registerAuth as any).nonce),
      yParity: (registerAuth as any).yParity as 0 | 1,
      r: (registerAuth as any).r as `0x${string}`,
      s: (registerAuth as any).s as `0x${string}`,
    } as unknown as Authorization;

    const result = await registerAgent({
      agentAddress: agentAddress as Address,
      authorization: deserializedAuthorization,
      tokenURI: registeryInfo.tokenURI,
      metadata: registeryInfo.metadata,
      network: paymentPayload.accepted?.network,
    });

    if (!result.success) {
      registrationCounter.inc({
        network: paymentPayload.accepted?.network || "unknown",
        status: "failure",
      });
      return;
    }

    if (result.agentId) {
      await agentAddressStore.set(agentAddress.toLowerCase(), result.agentId);
      console.log(
        `📝 Stored v2 agentAddress (${agentAddress}) -> agentId (${result.agentId}) mapping`,
      );
      registrationCounter.inc({
        network: paymentPayload.accepted?.network || "unknown",
        status: "success",
      });
    }
  } catch (error) {
    console.error(`❌ Failed to register agent: ${error}`);
    registrationCounter.inc({
      network: paymentPayload.accepted?.network || "unknown",
      status: "error",
    });
    return;
  }
};

const app = express();
app.use(express.json());

// ============================================================================
// Routes
// ============================================================================

/**
 * POST /verify
 * Verify a payment against requirements
 */
app.post("/verify", async (req, res) => {
  const endTimer = verifyDuration.startTimer();

  try {
    const { paymentPayload, paymentRequirements } = req.body as {
      paymentPayload: PaymentPayload;
      paymentRequirements: PaymentRequirements;
    };

    if (!paymentPayload || !paymentRequirements) {
      verifyCounter.inc({ status: "invalid_request" });
      endTimer();
      return res.status(400).json({
        error: "Missing paymentPayload or paymentRequirements",
      });
    }

    const response: VerifyResponse = await facilitator.verify(paymentPayload, paymentRequirements);

    verifyCounter.inc({ status: response.isValid ? "success" : "failure" });
    endTimer();

    return res.json(response);
  } catch (error) {
    console.error("Verify error:", error);
    verifyCounter.inc({ status: "error" });
    endTimer();
    res.status(500).json({
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
});

/**
 * POST /settle
 * Settle a payment on-chain
 *
 * Note: Verification validation and cleanup are handled by lifecycle hooks
 */
app.post("/settle", async (req, res) => {
  try {
    const { paymentPayload, paymentRequirements } = req.body as {
      paymentPayload: PaymentPayload;
      paymentRequirements: PaymentRequirements;
    };

    if (!paymentPayload || !paymentRequirements) {
      return res.status(400).json({
        error: "Missing paymentPayload or paymentRequirements",
      });
    }

    const response: SettleResponse = await facilitator.settle(paymentPayload, paymentRequirements);

    return res.json(response);
  } catch (error) {
    console.error("Settle error:", error);

    if (error instanceof Error && error.message.includes("Settlement aborted:")) {
      return res.json({
        success: false,
        errorReason: error.message.replace("Settlement aborted: ", ""),
        network: req.body?.paymentPayload?.network || "unknown",
      } as SettleResponse);
    }

    res.status(500).json({
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
});

/**
 * GET /
 * Redirect to documentation
 */
app.get("/", (req, res) => {
  res.redirect("https://www.openmid.xyz/docs");
});

/**
 * GET /metrics
 * Prometheus metrics endpoint
 */
app.get("/metrics", async (req, res) => {
  try {
    res.setHeader("Content-Type", metricsRegister.contentType);
    res.send(await metricsRegister.metrics());
  } catch (error) {
    console.error("Metrics error:", error);
    res.status(500).send("Error generating metrics");
  }
});

/**
 * POST /register
 * Register a new agent with ERC-8004
 */
app.post("/register", async (req, res) => {
  try {
    const {
      tokenURI,
      metadata,
      network = "base-sepolia",
      x402Version = 1,
      agentAddress,
      authorization,
    } = req.body;

    // For v1, agentAddress and authorization are required
    if (x402Version === 1) {
      if (!agentAddress) {
        return res.status(400).json({
          success: false,
          error: "agentAddress is required for x402Version 1",
        });
      }
      if (!authorization) {
        return res.status(400).json({
          success: false,
          error: "authorization is required for x402Version 1 (EIP-7702)",
        });
      }
    }

    // Deserialize authorization - convert string values back to BigInt for viem
    // Note: viem's Authorization type expects numbers, but EIP-7702 uses BigInt
    // We'll use type assertion since the values are correct at runtime
    const deserializedAuthorization = {
      chainId: BigInt((authorization as any).chainId),
      address: (authorization as any).address as Address,
      nonce: BigInt((authorization as any).nonce),
      yParity: (authorization as any).yParity as 0 | 1,
      r: (authorization as any).r as `0x${string}`,
      s: (authorization as any).s as `0x${string}`,
    } as unknown as Authorization;

    const result = await registerAgent({
      agentAddress: agentAddress as Address,
      authorization: deserializedAuthorization,
      tokenURI,
      metadata,
      network,
    });

    if (result.success && result.agentId) {
      // For v1, store agentAddress -> agentId mapping
      if (x402Version === 1 && agentAddress) {
        await agentAddressStore.set(agentAddress.toLowerCase(), result.agentId);
        console.log(
          `📝 Stored v1 agentAddress (${agentAddress}) -> agentId (${result.agentId}) mapping`,
        );
      }

      res.json(result);
    } else {
      res.status(400).json(result);
    }
  } catch (error) {
    console.error("Register error:", error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
});

/**
 * GET /supported
 * Get supported payment kinds and extensions
 */
app.get("/supported", async (req, res) => {
  try {
    const response = facilitator.getSupported();
    res.json(response);
  } catch (error) {
    console.error("Supported error:", error);
    res.status(500).json({
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
});

/**
 * GET /agent
 * Get agent ID by address
 */
app.get("/agent", async (req, res) => {
  try {
    const address = req.query.address as string;

    if (!address) {
      return res.status(400).json({
        success: false,
        error: "Address parameter is required",
      });
    }

    const agentId = await agentAddressStore.get(address.toLowerCase());

    if (!agentId) {
      return res.status(404).json({
        success: false,
        error: `Agent not found for address: ${address}`,
      });
    }

    res.json({
      success: true,
      address: address.toLowerCase(),
      agentId,
    });
  } catch (error) {
    console.error("Get agent error:", error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
});

/**
 * GET /reputation
 * Get reputation summary for an agent
 */
app.get("/reputation", async (req, res) => {
  try {
    const { agentId, network = "eip155:84532" } = req.query;

    if (!agentId) {
      return res.status(400).json({
        success: false,
        error: "agentId parameter is required",
      });
    }

    const summary = await getReputationSummary(agentId as string, network as string);

    if (!summary) {
      return res.status(404).json({
        success: false,
        error: "Could not fetch reputation summary",
      });
    }

    res.json({
      success: true,
      agentId,
      count: summary.count.toString(),
      totalScore: summary.totalScore.toString(),
      averageScore: summary.averageScore,
    });
  } catch (error) {
    console.error("Reputation error:", error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
});

/**
 * POST /feedback
 * Submit feedback for an agent (v1: direct submission, no feedbackAuth)
 */
app.post("/feedback", async (req, res) => {
  try {
    const {
      agentId,
      score,
      tag1,
      tag2,
      endpoint,
      feedbackURI,
      feedbackHash,
      network = "eip155:84532",
    } = req.body;

    if (!agentId) {
      return res.status(400).json({
        success: false,
        error: "agentId is required",
      });
    }

    if (score === undefined || score === null) {
      return res.status(400).json({
        success: false,
        error: "score is required",
      });
    }

    if (score < 0 || score > 100) {
      return res.status(400).json({
        success: false,
        error: "score must be between 0 and 100",
      });
    }

    const result = await giveFeedback({
      agentId,
      score,
      tag1,
      tag2,
      endpoint,
      feedbackURI,
      feedbackHash,
      network,
    });

    if (result.success) {
      feedbackCounter.inc({ network, status: "success" });
      res.json({
        success: true,
        agentId,
        txHash: result.txHash,
      });
    } else {
      feedbackCounter.inc({ network, status: "failure" });
      res.status(400).json({
        success: false,
        error: result.error,
      });
    }
  } catch (error) {
    feedbackCounter.inc({ network: "unknown", status: "error" });
    console.error("Feedback error:", error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
});

// ============================================================================
// Server Startup
// ============================================================================

app.listen(parseInt(PORT), () => {
  console.log(`
╔════════════════════════════════════════════════════════╗
║           x402 ERC-8004 v1 Facilitator                 ║
╠════════════════════════════════════════════════════════╣
║  Network:    eip155:84532, eip155:8453                 ║
║  Extensions: erc-8004 v1                               ║
║                                                        ║
║  Endpoints:                                            ║
║  • POST /verify              (verify payment)          ║
║  • POST /settle              (settle payment)          ║
║  • GET  /supported           (get supported kinds)     ║
║  • POST /register            (register agent)          ║
║  • GET  /agent               (get agent by address)    ║
║  • GET  /reputation          (get reputation summary)  ║
║  • POST /feedback            (submit feedback)         ║
╚════════════════════════════════════════════════════════╝
  `);

  // Log that facilitator is ready (needed for e2e test discovery)
  console.log("Facilitator listening");
});
