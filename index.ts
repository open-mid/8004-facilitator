import express from "express";
import { x402Facilitator } from "@x402/core/facilitator";
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
import {
  createPublicClient,
  createWalletClient,
  http,
  publicActions,
  encodeFunctionData,
  type Address,
  type Authorization,
} from "viem";
import { baseSepolia } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";

// Import config
import {
  RPC_URL,
  ERC8004_REPUTATION_REGISTRY_ADDRESS,
  DELEGATE_CONTRACT_ADDRESS,
  PORT,
  FACILITATOR_PRIVATE_KEY,
} from "./src/config/env";
import { delegateContractAbi } from "./src/config/contracts";

// Import utils
import { mapX402NetworkToChain } from "./src/utils/network";

// Import services
import { registerAgent, type RegisterInfo } from "./src/services/registerService";
import { generateClientFeedbackAuth } from "./src/services/feedbackService";

const app = express();
app.use(express.json());

// Initialize the EVM account from private key
const evmAccount = privateKeyToAccount(FACILITATOR_PRIVATE_KEY as `0x${string}`);

console.log("facilitator address:", evmAccount.address);

// Create a Viem client with both wallet and public capabilities
const viemClient = createWalletClient({
  account: evmAccount,
  chain: baseSepolia,
  transport: http(),
}).extend(publicActions);

// Initialize the x402 Facilitator with EVM and SVM support
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

// Store client address -> { agentId, feedbackAuth } mapping (for v2)
const feedbackAuthStore = new Map<string, { agentId: string; feedbackAuth: string }>();
// Store agent address -> agentId mapping (for v1)
const agentAddressStore = new Map<string, string>();

const facilitator = new x402Facilitator();

registerExactEvmScheme(facilitator, { signer: evmSigner });
// .registerScheme("eip155:*", new ExactEvmFacilitator(evmSigner))
// .registerSchemeV1("base-sepolia" as `${string}:${string}`, new ExactEvmFacilitator(evmSigner))

facilitator.registerExtension("feedback").onAfterSettle(async context => {
  // This hook only handles v2 payments (v1 is handled directly in /settle endpoint)
  const paymentPayload = context.paymentPayload;
  const extensions = paymentPayload.extensions;

  // Extract register extension data
  const registerInfo = extensions?.feedback as
    | { agentId?: string; feedbackEnabled?: boolean }
    | undefined;

  // For v2, use agentId from registerInfo if feedbackEnabled is true
  if (!registerInfo || !registerInfo.agentId || !registerInfo.feedbackEnabled) {
    // No feedback enabled for v2, skip
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
  const feedbackAuthEndpoint = (registerInfo as { feedbackAuthEndpoint?: string })
    ?.feedbackAuthEndpoint;

  // Extract host from resource URL and construct full endpoint URL
  let agentUrl: string | undefined;
  if (resourceUrl) {
    try {
      const url = new URL(resourceUrl);
      agentUrl = `${url.origin}${feedbackAuthEndpoint}`;
    } catch {
      // nothing
    }
  }

  // Generate feedbackAuth for v2
  const result = await generateClientFeedbackAuth(
    registerInfo.agentId,
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
});

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
        agentAddressStore.set(agentAddress.toLowerCase(), result.agentId);
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
 * POST /feedback
 * Submit feedback to the reputation registry on behalf of a client using EIP-7702 authorization
 */
app.post("/feedback", async (req, res) => {
  try {
    const {
      clientAddress,
      score,
      tag1,
      tag2,
      fileuri,
      filehash,
      network = "base-sepolia",
      authorization,
    } = req.body;

    if (!clientAddress) {
      return res.status(400).json({
        success: false,
        error: "Missing required field: clientAddress",
      });
    }

    if (!authorization) {
      return res.status(400).json({
        success: false,
        error: "Missing required field: authorization (EIP-7702)",
      });
    }

    if (score === undefined || score === null) {
      return res.status(400).json({
        success: false,
        error: "Missing required field: score",
      });
    }

    // Validate score range
    const scoreNum = Number(score);
    if (scoreNum < 0 || scoreNum > 100) {
      return res.status(400).json({
        success: false,
        error: "Score must be between 0 and 100",
      });
    }

    // Fetch feedbackAuth from store
    const storedData = feedbackAuthStore.get(clientAddress.toLowerCase());
    if (!storedData) {
      return res.status(404).json({
        success: false,
        error: "FeedbackAuth not found for the given client address",
      });
    }

    const { agentId, feedbackAuth } = storedData;

    // Get chain for network
    const chain = mapX402NetworkToChain(network, RPC_URL);
    if (!chain) {
      return res.status(400).json({
        success: false,
        error: `Unsupported network: ${network}`,
      });
    }

    // Create clients
    const publicClient = createPublicClient({ chain, transport: http(RPC_URL) });

    // Convert parameters to proper types
    const agentIdBigInt = BigInt(agentId);
    const tag1Bytes32 = tag1
      ? tag1.startsWith("0x")
        ? (tag1 as `0x${string}`)
        : (`0x${tag1.padStart(64, "0")}` as `0x${string}`)
      : ("0x0000000000000000000000000000000000000000000000000000000000000000" as `0x${string}`);
    const tag2Bytes32 = tag2
      ? tag2.startsWith("0x")
        ? (tag2 as `0x${string}`)
        : (`0x${tag2.padStart(64, "0")}` as `0x${string}`)
      : ("0x0000000000000000000000000000000000000000000000000000000000000000" as `0x${string}`);
    const fileuriStr = fileuri || "";
    const filehashBytes32 = filehash
      ? filehash.startsWith("0x")
        ? (filehash as `0x${string}`)
        : (`0x${filehash.padStart(64, "0")}` as `0x${string}`)
      : ("0x0000000000000000000000000000000000000000000000000000000000000000" as `0x${string}`);
    const feedbackAuthBytes = feedbackAuth.startsWith("0x")
      ? (feedbackAuth as `0x${string}`)
      : (`0x${feedbackAuth}` as `0x${string}`);

    console.log(`📝 Submitting feedback for agent ${agentId} from client ${clientAddress}...`);
    console.log(`   - Score: ${scoreNum}`);
    console.log(`   - Network: ${network}`);

    // Deserialize authorization
    const deserializedAuthorization = {
      chainId: BigInt((authorization as any).chainId),
      address: (authorization as any).address as Address,
      nonce: BigInt((authorization as any).nonce),
      yParity: (authorization as any).yParity as 0 | 1,
      r: (authorization as any).r as `0x${string}`,
      s: (authorization as any).s as `0x${string}`,
    } as unknown as Authorization;

    // Verify authorization matches expected delegate address
    if (
      deserializedAuthorization.address.toLowerCase() !== DELEGATE_CONTRACT_ADDRESS.toLowerCase()
    ) {
      return res.status(400).json({
        success: false,
        error: `Authorization address mismatch. Expected: ${DELEGATE_CONTRACT_ADDRESS}, Got: ${deserializedAuthorization.address}`,
      });
    }

    // Encode the giveFeedback function call
    const data = encodeFunctionData({
      abi: delegateContractAbi,
      functionName: "giveFeedback",
      args: [
        ERC8004_REPUTATION_REGISTRY_ADDRESS,
        agentIdBigInt,
        scoreNum,
        tag1Bytes32,
        tag2Bytes32,
        fileuriStr,
        filehashBytes32,
        feedbackAuthBytes,
      ],
    });

    // Create wallet client with facilitator's account
    const account = privateKeyToAccount(FACILITATOR_PRIVATE_KEY as `0x${string}`);
    const walletClient = createWalletClient({ account, chain, transport: http(RPC_URL) });

    console.log(`📤 Sending EIP-7702 transaction with authorization...`);
    console.log(`   - Client Address: ${clientAddress}`);
    console.log(`   - Delegate Contract: ${deserializedAuthorization.address}`);

    // Send EIP-7702 transaction
    const hash = await walletClient.sendTransaction({
      authorizationList: [deserializedAuthorization],
      data,
      to: clientAddress as Address, // The client's EOA that's being delegated
    });

    console.log(`✅ Feedback transaction submitted: ${hash}`);

    // Wait for transaction receipt
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    console.log(`✅ Feedback transaction confirmed in block: ${receipt.blockNumber}`);

    res.json({
      success: true,
      txHash: hash,
      blockNumber: receipt.blockNumber.toString(),
      agentId,
      clientAddress,
    });
  } catch (error) {
    console.error("Feedback submission error:", error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
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

// Start the server
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
║  • POST /feedback            (submit feedback)         ║
║  • POST /close               (shutdown server)         ║
║  • POST /register            (register agent)          ║
╚════════════════════════════════════════════════════════╝
  `);

  // Log that facilitator is ready (needed for e2e test discovery)
  console.log("Facilitator listening");
});
