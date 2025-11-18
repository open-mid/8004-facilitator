import { config } from "dotenv";
import express from "express";
import { x402Facilitator } from "@x402/core/facilitator";
import type {
  PaymentRequirements,
  PaymentPayload,
  VerifyResponse,
  SettleResponse,
} from "@x402/core/types";
import { ExactEvmFacilitator, toFacilitatorEvmSigner } from "@x402/evm";
import {
  createPublicClient,
  createWalletClient,
  http,
  publicActions,
  parseAbi,
  decodeEventLog,
  encodeAbiParameters,
  keccak256,
  encodePacked,
  type Address,
} from "viem";
import { anvil, base, baseSepolia, type Chain } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import crypto from "crypto";

config();

const RPC_URL = process.env.RPC_URL as string | undefined;
const ERC8004_IDENTITY_REGISTRY_ADDRESS = process.env.ERC8004_IDENTITY_REGISTRY_ADDRESS as
  | `0x${string}`
  | undefined;
const PORT = process.env.PORT || "4022";

const app = express();
app.use(express.json());

// Normalize private keys - add 0x prefix if missing
let FACILITATOR_PRIVATE_KEY = process.env.FACILITATOR_PRIVATE_KEY;
if (FACILITATOR_PRIVATE_KEY && !FACILITATOR_PRIVATE_KEY.startsWith("0x")) {
  FACILITATOR_PRIVATE_KEY = "0x" + FACILITATOR_PRIVATE_KEY;
}

function isLocalRPC(rpcUrl?: string): boolean {
  if (!rpcUrl) return false;
  try {
    const url = new URL(rpcUrl);
    return url.hostname === "localhost" || url.hostname === "127.0.0.1";
  } catch {
    return rpcUrl?.includes("localhost") || rpcUrl?.includes("127.0.0.1");
  }
}

function mapX402NetworkToChain(network?: string, rpcUrl?: string): Chain | undefined {
  // If RPC is local, always use anvil chain (chainId 31337)
  if (isLocalRPC(rpcUrl)) {
    console.log("Detected local RPC, using anvil chain (chainId: 31337)");
    return anvil;
  }

  if (!network) {
    return undefined;
  }

  // Handle CAIP-2 format (eip155:chainId)
  if (network.startsWith("eip155:")) {
    const chainId = parseInt(network.split(":")[1]);

    // Map known chain IDs to viem chains
    switch (chainId) {
      case 84532: // Base Sepolia
        return baseSepolia;
      case 8453: // Base Mainnet
        return base;
      case 31337: // Anvil (local)
        return anvil;
      default:
        // For unknown chain IDs, try to find in viem chains
        // This would require importing all chains, so for now just return undefined
        console.warn(`Unknown chain ID: ${chainId} for network: ${network}`);
        return undefined;
    }
  }

  // Handle simple network names (V1 format)
  switch (network) {
    case "base-sepolia":
      return baseSepolia;
    case "base":
      return base;
    default:
      return undefined;
  }
}

const identityRegistryAbi = parseAbi([
  "function register() returns (uint256 agentId)",
  "function register(string calldata tokenURI_) returns (uint256 agentId)",
  "function register(string calldata tokenURI_, MetadataEntry[] calldata metadata) returns (uint256 agentId)",
  "function balanceOf(address owner) view returns (uint256 balance)",
  "function ownerOf(uint256 tokenId) view returns (address owner)",
  "event Registered(uint256 indexed agentId, string tokenURI, address indexed owner)",
  "struct MetadataEntry { string key; bytes value; }",
]);

// Validate required environment variables
if (!process.env.EVM_PRIVATE_KEY) {
  console.error("❌ EVM_PRIVATE_KEY environment variable is required");
  process.exit(1);
}

// Initialize the EVM account from private key
const evmAccount = privateKeyToAccount(process.env.EVM_PRIVATE_KEY as `0x${string}`);

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

// Store client address -> { agentId, feedbackAuth } mapping
const feedbackAuthStore = new Map<string, { agentId: string; feedbackAuth: string }>();

function createPaymentHash(paymentPayload: PaymentPayload): string {
  return crypto.createHash("sha256").update(JSON.stringify(paymentPayload)).digest("hex");
}

type RegisterInfo = {
  agentId?: string;
  tokenURI?: string;
  metadata?: { key: string; value: string }[];
  network?: string;
  clientAddress?: string;
  feedbackEnabled?: boolean;
};

type RegisterResult = {
  success: boolean;
  network?: string;
  agentId?: string;
  agentOwner?: string;
  txHash?: string;
  feedbackAuth?: string;
  error?: string;
};

const registerAgent = async (info: RegisterInfo): Promise<RegisterResult> => {
  const {
    network,
    tokenURI,
    metadata,
    agentId: requestedAgentId,
    clientAddress,
    feedbackEnabled,
  } = info;

  if (!network) {
    console.log("Registration failed: missing network");
    return {
      success: false,
      error: "Missing required field: network",
    };
  }

  if (!RPC_URL || !ERC8004_IDENTITY_REGISTRY_ADDRESS) {
    console.log("Registration failed: missing RPC_URL or REGISTRY address");
    return {
      success: false,
      error: "Facilitator not configured for ERC-8004 registration",
    };
  }

  const chain = mapX402NetworkToChain(network, RPC_URL);
  if (!chain) {
    console.log("Registration failed: unsupported network:", network);
    return {
      success: false,
      error: `Unsupported network: ${network}`,
      network,
    };
  }

  try {
    const publicClient = createPublicClient({ chain, transport: http(RPC_URL) });

    // Get the actual chain ID from the blockchain to ensure it matches
    const actualChainId = await publicClient.getChainId();

    // Facilitator registers itself
    if (!FACILITATOR_PRIVATE_KEY) {
      console.log("Registration failed: FACILITATOR_PRIVATE_KEY required");
      return {
        success: false,
        error: "Facilitator private key not configured",
      };
    }

    console.log("Registering agent with ERC-8004");

    const account = privateKeyToAccount(FACILITATOR_PRIVATE_KEY as `0x${string}`);
    const walletClient = createWalletClient({ account, chain, transport: http(RPC_URL) });
    const facilitatorAddress = account.address;

    // If agentId is provided, check if it exists and belongs to the facilitator
    if (requestedAgentId) {
      try {
        const agentIdBigInt = BigInt(requestedAgentId);

        // Check ownership - ownerOf will revert if agent doesn't exist
        const owner = await publicClient.readContract({
          address: ERC8004_IDENTITY_REGISTRY_ADDRESS,
          abi: identityRegistryAbi,
          functionName: "ownerOf",
          args: [agentIdBigInt],
        });

        // If ownerOf succeeds, agent exists - verify ownership
        if (owner.toLowerCase() === facilitatorAddress.toLowerCase()) {
          console.log(
            `ERC-8004: Agent ${requestedAgentId} already exists and belongs to facilitator`,
          );

          // Generate feedbackAuth if clientAddress is provided
          let feedbackAuth: string | undefined;
          if (clientAddress && FACILITATOR_PRIVATE_KEY && feedbackEnabled) {
            try {
              feedbackAuth = await generateFeedbackAuth(
                requestedAgentId.toString(),
                clientAddress as Address,
                facilitatorAddress,
                FACILITATOR_PRIVATE_KEY as `0x${string}`,
                actualChainId,
              );
            } catch (err) {
              console.error("ERC-8004: Failed to generate feedbackAuth:", err);
            }
          }

          return {
            success: true,
            network,
            agentOwner: facilitatorAddress,
            agentId: requestedAgentId.toString(),
            ...(feedbackAuth && { feedbackAuth }),
          };
        } else {
          // Agent exists but belongs to different owner
          console.log(
            `ERC-8004: Agent ${requestedAgentId} exists but belongs to different owner: ${owner}`,
          );
          return {
            success: false,
            error: `Agent ${requestedAgentId} exists but belongs to different owner: ${owner}`,
            network,
          };
        }
      } catch (err) {
        // If ownerOf reverts, the agent doesn't exist
        // Don't proceed with registration if we can't verify
        console.error(
          "ERC-8004: Agent does not exist or error checking ownership, cannot proceed with registration",
          err,
        );
        return {
          success: false,
          error: `Agent ${requestedAgentId} does not exist or failed to verify: ${err instanceof Error ? err.message : "Unknown error"}`,
          network,
        };
      }
    }

    let hash: `0x${string}`;
    let agentId: string | undefined;

    // Build transaction based on provided parameters
    if (metadata && metadata.length > 0) {
      const metadataEntries = metadata.map((entry: { key: string; value: string }) => ({
        key: entry.key,
        value: entry.value.startsWith("0x")
          ? (entry.value as `0x${string}`)
          : (`0x${Buffer.from(entry.value).toString("hex")}` as `0x${string}`),
      }));

      hash = await walletClient.writeContract({
        address: ERC8004_IDENTITY_REGISTRY_ADDRESS,
        abi: identityRegistryAbi,
        functionName: "register",
        args: [tokenURI || "", metadataEntries],
      });
    } else if (tokenURI) {
      hash = await walletClient.writeContract({
        address: ERC8004_IDENTITY_REGISTRY_ADDRESS,
        abi: identityRegistryAbi,
        functionName: "register",
        args: [tokenURI],
      });
    } else {
      hash = await walletClient.writeContract({
        address: ERC8004_IDENTITY_REGISTRY_ADDRESS,
        abi: identityRegistryAbi,
        functionName: "register",
        args: [],
      });
    }

    const receipt = await publicClient.waitForTransactionReceipt({ hash });

    // Extract agentId from Registered event
    const registeredEvent = receipt.logs.find(log => {
      try {
        const decoded = decodeEventLog({
          abi: identityRegistryAbi,
          data: log.data,
          topics: log.topics,
        });
        return decoded.eventName === "Registered";
      } catch {
        return false;
      }
    });

    if (registeredEvent) {
      try {
        const decoded = decodeEventLog({
          abi: identityRegistryAbi,
          data: registeredEvent.data,
          topics: registeredEvent.topics,
        });
        if (decoded.eventName === "Registered") {
          agentId = decoded.args.agentId?.toString();
        }
      } catch (err) {
        console.log("ERC-8004: Failed to decode Registered event", err);
      }
    }

    // Generate feedbackAuth if clientAddress is provided and agentId is available
    let feedbackAuth: string | undefined;
    if (clientAddress && agentId && FACILITATOR_PRIVATE_KEY) {
      try {
        // Get the actual chain ID from the blockchain to ensure it matches
        const actualChainId = await publicClient.getChainId();
        feedbackAuth = await generateFeedbackAuth(
          agentId,
          clientAddress as Address,
          facilitatorAddress,
          FACILITATOR_PRIVATE_KEY as `0x${string}`,
          actualChainId,
        );
      } catch (err) {
        console.error("ERC-8004: Failed to generate feedbackAuth:", err);
      }
    }

    return {
      success: true,
      network,
      txHash: hash,
      agentOwner: facilitatorAddress,
      agentId,
      ...(feedbackAuth && { feedbackAuth }),
    };
  } catch (e: any) {
    console.error("ERC-8004: Registration failed:", e?.message || e);

    return {
      success: false,
      error: e?.message || "Registration failed",
      network,
    };
  }
};

const facilitator = new x402Facilitator()
  .registerScheme("eip155:*", new ExactEvmFacilitator(evmSigner))
  .registerSchemeV1("base-sepolia" as `${string}:${string}`, new ExactEvmFacilitator(evmSigner))
  .onAfterSettle(async context => {
    const paymentPayload = context.paymentPayload;
    const extensions = paymentPayload.extensions;

    // Extract register extension data
    const registerInfo = extensions?.register as RegisterInfo | undefined;
    console.log(registerInfo);
    if (registerInfo) {
      // Get network from payment requirements
      const network = paymentPayload.accepted?.network || registerInfo.network;
      // Get client address from payment payload (the payer)
      const clientAddress = (paymentPayload.payload as any)?.authorization?.from;

      const result = await registerAgent({
        ...registerInfo,
        network: network || "base-sepolia", // fallback to base-sepolia
        clientAddress,
      });

      if (result.success) {
        console.log(
          `✅ Agent registered: ${result.agentId}`,
          result.txHash ? `tx: ${result.txHash}` : "",
        );

        // Store feedbackAuth and agentId if feedbackEnabled is true and both are available
        if (
          registerInfo.feedbackEnabled &&
          result.feedbackAuth &&
          result.agentId &&
          clientAddress
        ) {
          feedbackAuthStore.set(clientAddress.toLowerCase(), {
            agentId: result.agentId,
            feedbackAuth: result.feedbackAuth,
          });
          console.log(
            `📝 Stored feedbackAuth and agentId (${result.agentId}) for client address: ${clientAddress}`,
          );
        }
      } else {
        console.error(`❌ Agent registration failed: ${result.error}`);
      }
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
      paymentPayload: PaymentPayload;
      paymentRequirements: PaymentRequirements;
    };

    if (!paymentPayload || !paymentRequirements) {
      return res.status(400).json({
        error: "Missing paymentPayload or paymentRequirements",
      });
    }

    // Hooks will automatically:
    // - Track verified payment (onAfterVerify)
    // - Extract and catalog discovery info (onAfterVerify)
    const response: VerifyResponse = await facilitator.verify(paymentPayload, paymentRequirements);

    res.json(response);
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
    const { paymentPayload, paymentRequirements } = req.body;

    if (!paymentPayload || !paymentRequirements) {
      return res.status(400).json({
        error: "Missing paymentPayload or paymentRequirements",
      });
    }

    // Hooks will automatically:
    // - Validate payment was verified (onBeforeSettle - will abort if not)
    // - Check verification timeout (onBeforeSettle)
    // - Clean up tracking (onAfterSettle / onSettleFailure)
    const response: SettleResponse = await facilitator.settle(
      paymentPayload as PaymentPayload,
      paymentRequirements as PaymentRequirements,
    );

    res.json(response);
  } catch (error) {
    console.error("Settle error:", error);

    // Check if this was an abort from hook
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
      extensions: ["register"],
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
 * GET /getFeedbackAuth
 * Retrieve feedbackAuth for a given client address
 */
app.get("/getFeedbackAuth", (req, res) => {
  try {
    const { clientAddress } = req.query;

    if (!clientAddress || typeof clientAddress !== "string") {
      return res.status(400).json({
        success: false,
        error: "Missing or invalid clientAddress query parameter",
      });
    }

    const storedData = feedbackAuthStore.get(clientAddress.toLowerCase());

    if (!storedData) {
      return res.status(404).json({
        success: false,
        error: "FeedbackAuth not found for the given client address",
      });
    }

    console.log(
      `Retrieved feedbackAuth and agentId (${storedData.agentId}) for client address: ${clientAddress}`,
    );
    res.json({
      success: true,
      clientAddress,
      agentId: storedData.agentId,
      feedbackAuth: storedData.feedbackAuth,
    });
  } catch (error) {
    console.error("GetFeedbackAuth error:", error);
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
║  Server:     http://localhost:${PORT}                  ║
║  Network:    eip155:84532                              ║
║  Address:    ${evmAccount.address}                        ║
║  Extensions: register                                    ║
║                                                        ║
║  Endpoints:                                            ║
║  • POST /verify              (verify payment)         ║
║  • POST /settle              (settle payment)         ║
║  • GET  /supported           (get supported kinds)    ║
║  • GET  /health              (health check)           ║
║  • POST /close               (shutdown server)        ║
╚════════════════════════════════════════════════════════╝
  `);

  // Log that facilitator is ready (needed for e2e test discovery)
  console.log("Facilitator listening");
});

// Helper function to generate feedbackAuth for ERC-8004 feedback
async function generateFeedbackAuth(
  agentId: string,
  clientAddress: Address,
  agentOwnerAddress: Address,
  agentOwnerPrivateKey: `0x${string}`,
  chainId: number,
  expiry?: bigint,
  indexLimit: bigint = 1000n,
): Promise<`0x${string}`> {
  if (!ERC8004_IDENTITY_REGISTRY_ADDRESS) {
    throw new Error("ERC8004_IDENTITY_REGISTRY_ADDRESS not configured");
  }

  const expiryTime = expiry || BigInt(Math.floor(Date.now() / 1000) + 3600); // 1 hour default

  // Create the FeedbackAuth struct - order must match Solidity struct exactly
  const feedbackAuthStruct = encodeAbiParameters(
    [
      { name: "agentId", type: "uint256" },
      { name: "clientAddress", type: "address" },
      { name: "indexLimit", type: "uint64" },
      { name: "expiry", type: "uint256" },
      { name: "chainId", type: "uint256" },
      { name: "identityRegistry", type: "address" },
      { name: "signerAddress", type: "address" },
    ],
    [
      BigInt(agentId),
      clientAddress,
      indexLimit,
      expiryTime,
      BigInt(chainId),
      ERC8004_IDENTITY_REGISTRY_ADDRESS,
      agentOwnerAddress,
    ],
  );

  // Hash the struct the same way the contract's _hashFeedbackAuth does:
  // 1. First hash the struct: keccak256(abi.encode(auth))
  // 2. Then apply EIP-191 prefix: keccak256("\x19Ethereum Signed Message:\n32" + structHash)
  const structHash = keccak256(feedbackAuthStruct);
  const eip191Hash = keccak256(
    encodePacked(["string", "bytes32"], ["\x19Ethereum Signed Message:\n32", structHash]),
  );

  // Sign the EIP-191 hash
  const account = privateKeyToAccount(agentOwnerPrivateKey);
  const signature = await account.sign({ hash: eip191Hash });

  // Encode: [struct bytes][signature (65 bytes: r=32, s=32, v=1)]
  const feedbackAuth = (feedbackAuthStruct + signature.slice(2)) as `0x${string}`;

  return feedbackAuth;
}
