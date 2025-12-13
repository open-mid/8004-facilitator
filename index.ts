// ============================================================================
// Imports
// ============================================================================

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
import { registerExactEvmScheme } from "@x402/evm/exact/facilitator";
import { toFacilitatorEvmSigner } from "@x402/evm";
import { createWalletClient, http, publicActions, type Address, type Authorization } from "viem";
import { baseSepolia } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";

// Import config
import { RPC_URL, PORT, FACILITATOR_PRIVATE_KEY, REDIS_URL } from "./src/config/env";

// Import utils
import { mapX402NetworkToChain } from "./src/utils/network";

// Import services
import { registerAgent } from "./src/services/registerService";
import { generateClientFeedbackAuth } from "./src/services/feedbackService";
import { createRedisStore, type KeyValueStore } from "./src/services/redisStore";

// ============================================================================
// Configuration & Initialization
// ============================================================================

// Initialize the EVM account from private key
const evmAccount = privateKeyToAccount(FACILITATOR_PRIVATE_KEY as `0x${string}`);
console.log("facilitator address:", evmAccount.address);

// Create a Viem client with both wallet and public capabilities
const viemClient = createWalletClient({
  account: evmAccount,
  chain: baseSepolia,
  transport: http(),
}).extend(publicActions);

// Initialize the x402 Facilitator with EVM support
const evmSigner = toFacilitatorEvmSigner({
  readContract: (args: {
    address: `0x${string}`;
    abi: readonly unknown[];
    functionName: string;
    args?: readonly unknown[];
  }) =>
    viemClient.readContract({
      ...args,
      args: args.args || [],
    }),
  verifyTypedData: (args: {
    address: `0x${string}`;
    domain: Record<string, unknown>;
    types: Record<string, unknown>;
    primaryType: string;
    message: Record<string, unknown>;
    signature: `0x${string}`;
  }) => viemClient.verifyTypedData(args as any),
  writeContract: (args: {
    address: `0x${string}`;
    abi: readonly unknown[];
    functionName: string;
    args: readonly unknown[];
  }) =>
    viemClient.writeContract({
      ...args,
      args: args.args || [],
    }),
  waitForTransactionReceipt: (args: { hash: `0x${string}` }) =>
    viemClient.waitForTransactionReceipt(args),
});

// Initialize facilitator and register schemes
const facilitator = new x402Facilitator();
registerExactEvmScheme(facilitator, { signer: evmSigner });

// ============================================================================
// Data Stores
// ============================================================================

// Store client address -> { agentId, feedbackAuth } mapping (for v2)
const feedbackAuthStore = createRedisStore<{ agentId: string; feedbackAuth: string }>(REDIS_URL);
// Store agent address -> agentId mapping (for v1)
const agentAddressStore = createRedisStore<string>(REDIS_URL);

// ============================================================================
// Extension Setup
// ============================================================================
facilitator.registerExtension("8004").onAfterSettle(async context => {
  await register(context);
  await feedback(context);
});

const register = async (context: FacilitatorSettleResultContext) => {
  const paymentPayload = context.paymentPayload;
  const extensions = paymentPayload.extensions;

  const registeryInfo = extensions?.["erc-8004"] as { registerEndpoint?: string } | undefined;
  if (!registeryInfo) {
    return;
  }

  const agentAddress = (paymentPayload.accepted.payTo as Address).toLowerCase();
  const agentId = await agentAddressStore.get(agentAddress);
  if (agentId) {
    console.log(`✅ Agent ${agentId} already registered, skipping registration`);
    return;
  }

  const resourceUrl = paymentPayload.resource?.url;
  const registerEndpoint = (registeryInfo as { registerEndpoint?: string })?.registerEndpoint;

  console.log(`🔍 Registering agent ${agentAddress} with endpoint ${registerEndpoint}`);

  if (!registerEndpoint) {
    return;
  }

  const registerUrl = `${new URL(resourceUrl).origin}${registerEndpoint}`;
  console.log(`🔍 Register URL: ${registerUrl}`);

  const response = await fetch(registerUrl);
  const data = await response.json();
  if (!response.ok) {
    console.error(`❌ Failed to register agent: ${data.error}`);
    return;
  }

  const { tokenURI, metadata, authorization } = data;
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
    network: paymentPayload.accepted?.network,
  });

  if (!result.success) {
    return;
  }

  // store agentAddress -> agentId mapping
  if (result.agentId) {
    await agentAddressStore.set(agentAddress.toLowerCase(), result.agentId);
    console.log(
      `📝 Stored v2 agentAddress (${agentAddress}) -> agentId (${result.agentId}) mapping`,
    );
  }
};

// Register feedback extension with lifecycle hooks
const feedback = async (context: FacilitatorSettleResultContext) => {
  // This hook only handles v2 payments (v1 is handled directly in /settle endpoint)
  const paymentPayload = context.paymentPayload;
  const extensions = paymentPayload.extensions;

  // Extract register extension data
  const feedbackInfo = extensions?.["erc-8004"] as
    | { feedbackAuthEndpoint?: string; feedbackEnabled?: boolean }
    | undefined;

  // For v2, use agentId from registerInfo if feedbackEnabled is true
  if (!feedbackInfo || !feedbackInfo.feedbackEnabled) {
    // No feedback enabled for v2, skip
    console.log("No feedback enabled for v2, skipping feedbackAuth generation");
    return;
  }

  // Get client address from payment payload (the payer)
  const clientAddress = (paymentPayload.payload as any)?.authorization?.from;

  if (!clientAddress) {
    console.warn("No client address found in payment payload, skipping feedbackAuth generation");
    return;
  }

  // Get network from payment requirements
  const network = paymentPayload.accepted?.network || "base-sepolia";

  // Get agent URL from resource and feedbackAuthEndpoint from extensions
  const resourceUrl = paymentPayload.resource?.url;
  const feedbackAuthEndpoint = (feedbackInfo as { feedbackAuthEndpoint?: string })
    ?.feedbackAuthEndpoint;

  // Extract host from resource URL and construct full endpoint URL
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

  const agentId = await agentAddressStore.get(clientAddress.toLowerCase());
  if (!agentId) {
    console.error(`❌ Agent not found for client address: ${clientAddress}`);
    return;
  }

  // Generate feedbackAuth for v2
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

// ============================================================================
// Express App Setup
// ============================================================================

const app = express();
app.use(express.json());

// ============================================================================
// Routes
// ============================================================================

/**
 * POST /verify
 * Verify a payment against requirements
 *
 * Note: Payment tracking and bazaar discovery are handled by lifecycle hooks
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

    // Check x402Version to determine which verify function to use
    const x402Version = (paymentPayload as any).x402Version;

    if (x402Version === 1) {
      // Use legacy verify for v1
      console.log("Using legacy verify for x402Version 1");

      if (!RPC_URL) {
        return res.status(500).json({
          error: "RPC_URL not configured",
        });
      }

      const legacyPayload = paymentPayload as LegacyPaymentPayload;
      const legacyRequirements = paymentRequirements as LegacyPaymentRequirements;

      // Get network from requirements (v1 format)
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
      // Use current facilitator verify for v2
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

    // Check x402Version to determine which settle function to use
    const x402Version = (paymentPayload as any).x402Version;

    if (x402Version === 1) {
      // Use legacy settle for v1
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
      // Use current facilitator settle for v2
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
 * COMMENTED OUT FOR TESTING - Use /register-test instead
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
    const response = {
      kinds: [
        {
          x402Version: 2,
          scheme: "exact",
          network: "eip155:84532",
        },
      ],
      extensions: ["feedback"],
    };
    console.log("Returning supported schemes:", response);
    res.json(response);
  } catch (error) {
    console.error("Supported error:", error);
    res.status(500).json({
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
});

/**
 * GET /health
 * Health check endpoint
 */
app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    network: "eip155:84532",
    facilitator: "typescript",
    version: "2.0.0",
    extensions: ["register"],
  });
});

/**
 * POST /close
 * Graceful shutdown endpoint
 */
app.post("/close", (req, res) => {
  res.json({ message: "Facilitator shutting down gracefully" });
  console.log("Received shutdown request");

  // Give time for response to be sent
  setTimeout(() => {
    process.exit(0);
  }, 100);
});

// ============================================================================
// Server Startup
// ============================================================================

app.listen(parseInt(PORT), () => {
  console.log(`
╔════════════════════════════════════════════════════════╗
║           x402 TypeScript Facilitator                  ║
╠════════════════════════════════════════════════════════╣
║  Network:    eip155:84532                              ║
║  Extensions: feedback                                  ║
║                                                        ║
║  Endpoints:                                            ║
║  • POST /verify              (verify payment)          ║
║  • POST /settle              (settle payment)          ║
║  • GET  /supported           (get supported kinds)     ║
║  • GET  /health              (health check)            ║
║  • POST /close               (shutdown server)         ║
║  • POST /register            (register agent)          ║
╚════════════════════════════════════════════════════════╝
  `);

  // Log that facilitator is ready (needed for e2e test discovery)
  console.log("Facilitator listening");
});
