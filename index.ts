import express from "express";
import { x402Facilitator, FacilitatorSettleResultContext } from "@x402/core/facilitator";
// Import legacy verify/settle functions - using file path since @x402/legacy points to the legacy directory
import { verify as legacyVerify, settle as legacySettle } from "@x402/legacy/x402/dist/cjs/verify";
import type {
  PaymentPayload as LegacyPaymentPayload,
  PaymentRequirements as LegacyPaymentRequirements,
  VerifyResponse as LegacyVerifyResponse,
  SettleResponse as LegacySettleResponse,
} from "@x402/legacy/x402/dist/cjs/types";
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
import { RPC_URL, PORT, FACILITATOR_PRIVATE_KEY, REDIS_URL } from "./src/config/env";

// Import utils
import { mapX402NetworkToChain } from "./src/utils/network";
import { createFacilitatorSigners } from "./src/utils/signers";

// Import services
import { registerAgent } from "./src/services/registerService";
import { generateClientFeedbackAuth } from "./src/services/feedbackService";
import { createRedisStore } from "./src/services/redisStore";

// ============================================================================
// Configuration & Initialization
// ============================================================================

const { evmAccount, baseSepoliaSigner, baseMainnetSigner } = createFacilitatorSigners(
  FACILITATOR_PRIVATE_KEY as `0x${string}`,
);
console.log("facilitator address:", evmAccount.address);

const facilitator = new x402Facilitator();

// Register v2 networks - separate registration for each chain
facilitator.register(["eip155:84532"], new ExactEvmScheme(baseSepoliaSigner));
facilitator.register(["eip155:8453"], new ExactEvmScheme(baseMainnetSigner));

// Register v1 networks - separate registration for each chain
facilitator.registerV1(["base-sepolia"] as any, new ExactEvmSchemeV1Facilitator(baseSepoliaSigner));
facilitator.registerV1(["base"] as any, new ExactEvmSchemeV1Facilitator(baseMainnetSigner));

// ============================================================================
// Data Stores
// ============================================================================

const feedbackAuthStore = createRedisStore<{ agentId: string; feedbackAuth: string }>(REDIS_URL);
const agentAddressStore = createRedisStore<string>(REDIS_URL);

// ============================================================================
// Extension Setup
// ============================================================================
facilitator.registerExtension("erc-8004").onAfterSettle(async context => {
  await register(context);
  // feedback happens async
  feedback(context);
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
      return;
    }

    if (result.agentId) {
      await agentAddressStore.set(agentAddress.toLowerCase(), result.agentId);
      console.log(
        `📝 Stored v2 agentAddress (${agentAddress}) -> agentId (${result.agentId}) mapping`,
      );
    }
  } catch (error) {
    console.error(`❌ Failed to register agent: ${error}`);
    return;
  }
};

const feedback = async (context: FacilitatorSettleResultContext) => {
  const paymentPayload = context.paymentPayload;
  const extensions = paymentPayload.extensions;

  const feedbackInfo = extensions?.["erc-8004"] as
    | { feedbackAuthEndpoint?: string; feedbackEnabled?: boolean }
    | undefined;

  if (!feedbackInfo || !feedbackInfo.feedbackEnabled) {
    console.log("No feedback enabled for v2, skipping feedbackAuth generation");
    return;
  }

  const clientAddress = (paymentPayload.payload as any)?.authorization?.from;
  if (!clientAddress) {
    console.warn("No client address found in payment payload, skipping feedbackAuth generation");
    return;
  }

  const agentAddress = (paymentPayload.accepted.payTo as Address).toLowerCase();
  if (!agentAddress) {
    console.warn("No agent address found in payment payload, skipping feedbackAuth generation");
    return;
  }

  const network = paymentPayload.accepted?.network || "base-sepolia";

  const resourceUrl = paymentPayload.resource?.url;
  const feedbackAuthEndpoint = (feedbackInfo as { feedbackAuthEndpoint?: string })
    ?.feedbackAuthEndpoint;

  let agentUrl: string | undefined;
  if (resourceUrl) {
    try {
      const url = new URL(resourceUrl);
      agentUrl = `${url.origin}${feedbackAuthEndpoint}`;
    } catch {
      console.error(`❌ Invalid resource URL: ${resourceUrl}`);
      return;
    }
  }

  const agentId = await agentAddressStore.get(agentAddress);
  if (!agentId) {
    console.error(`❌ Agent not found for client address: ${clientAddress}`);
    return;
  }

  const result = await generateClientFeedbackAuth(
    agentId,
    clientAddress as Address,
    network,
    feedbackAuthStore,
    agentUrl,
  );

  if (result.success) {
    console.log(`✅ Generated feedbackAuth for v2 agent ${result.agentId}`);
  } else {
    console.error(`❌ Failed to generate feedbackAuth for v2: ${result.error}`);
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
  try {
    const { paymentPayload, paymentRequirements } = req.body as {
      paymentPayload: PaymentPayload | LegacyPaymentPayload;
      paymentRequirements: PaymentRequirements | LegacyPaymentRequirements;
    };

    if (!paymentPayload || !paymentRequirements) {
      return res.status(400).json({
        error: "Missing paymentPayload or paymentRequirements",
      });
    }

    const x402Version = (paymentPayload as any).x402Version;
    if (x402Version === 1) {
      console.log("Using legacy verify for x402Version 1");

      if (!RPC_URL) {
        return res.status(500).json({
          error: "RPC_URL not configured",
        });
      }

      const legacyPayload = paymentPayload as LegacyPaymentPayload;
      const legacyRequirements = paymentRequirements as LegacyPaymentRequirements;

      const network = legacyRequirements.network;
      const chain = mapX402NetworkToChain(network, RPC_URL);

      if (!chain) {
        return res.status(400).json({
          isValid: false,
          invalidReason: "invalid_scheme" as any, // Type assertion needed due to strict error enum
        } as LegacyVerifyResponse);
      }

      const response: LegacyVerifyResponse = await legacyVerify(legacyPayload, legacyRequirements);

      return res.json(response);
    } else if (x402Version === 2) {
      console.log("Using x402 v2 for verify");

      const response: VerifyResponse = await facilitator.verify(
        paymentPayload as PaymentPayload,
        paymentRequirements as PaymentRequirements,
      );

      return res.json(response);
    } else {
      return res.status(400).json({
        error: `Unsupported x402Version: ${x402Version}`,
      });
    }
  } catch (error) {
    console.error("Verify error:", error);
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
      paymentPayload: PaymentPayload | LegacyPaymentPayload;
      paymentRequirements: PaymentRequirements | LegacyPaymentRequirements;
    };

    if (!paymentPayload || !paymentRequirements) {
      return res.status(400).json({
        error: "Missing paymentPayload or paymentRequirements",
      });
    }

    const x402Version = (paymentPayload as any).x402Version;
    if (x402Version === 1) {
      console.log("Using legacy settle for x402Version 1");

      if (!RPC_URL || !FACILITATOR_PRIVATE_KEY) {
        return res.status(500).json({
          success: false,
          errorReason: "invalid_scheme" as any, // Type assertion needed due to strict error enum
          network: (paymentRequirements as LegacyPaymentRequirements).network,
          transaction: "",
        } as LegacySettleResponse);
      }

      const legacyPayload = paymentPayload as LegacyPaymentPayload;
      const legacyRequirements = paymentRequirements as LegacyPaymentRequirements;

      // Get network from requirements (v1 format)
      const network = legacyRequirements.network;
      const chain = mapX402NetworkToChain(network, RPC_URL);

      if (!chain) {
        return res.status(400).json({
          success: false,
          errorReason: "invalid_scheme" as any, // Type assertion needed due to strict error enum
          network,
          transaction: "",
        } as LegacySettleResponse);
      }

      const response: LegacySettleResponse = await legacySettle(legacyPayload, legacyRequirements);
      // TODO: not generating feedbackAuth for v1 after successful settlement

      return res.json(response);
    } else if (x402Version === 2) {
      console.log("Using x402 v2 for settle");

      // Hooks will automatically:
      // - Validate payment was verified (onBeforeSettle - will abort if not)
      // - Check verification timeout (onBeforeSettle)
      // - Clean up tracking (onAfterSettle / onSettleFailure)
      const response: SettleResponse = await facilitator.settle(
        paymentPayload as PaymentPayload,
        paymentRequirements as PaymentRequirements,
      );

      return res.json(response);
    } else {
      return res.status(400).json({
        success: false,
        errorReason: "invalid_scheme" as any, // Type assertion needed due to strict error enum
        network: (paymentRequirements as any).network || "base-sepolia",
        transaction: "",
      } as LegacySettleResponse);
    }
  } catch (error) {
    console.error("Settle error:", error);

    // Check if this was an abort from hook (v2 only)
    if (error instanceof Error && error.message.includes("Settlement aborted:")) {
      // Return a proper SettleResponse instead of 500 error
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

// ============================================================================
// Server Startup
// ============================================================================

app.listen(parseInt(PORT), () => {
  console.log(`
╔════════════════════════════════════════════════════════╗
║           x402 TypeScript Facilitator                  ║
╠════════════════════════════════════════════════════════╣
║  Network:    eip155:84532, eip155:8453                 ║
║  Extensions: erc-8004                                  ║
║                                                        ║
║  Endpoints:                                            ║
║  • POST /verify              (verify payment)          ║
║  • POST /settle              (settle payment)          ║
║  • GET  /supported           (get supported kinds)     ║
║  • POST /register            (register agent)          ║
╚════════════════════════════════════════════════════════╝
  `);

  // Log that facilitator is ready (needed for e2e test discovery)
  console.log("Facilitator listening");
});
