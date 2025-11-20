import { config } from "dotenv";
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
  encodeFunctionData,
  type Address,
  type Authorization,
} from "viem";
import { anvil, base, baseSepolia, type Chain } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import crypto from "crypto";

config();

const RPC_URL = process.env.RPC_URL as string | undefined;
const ERC8004_IDENTITY_REGISTRY_ADDRESS = process.env.ERC8004_IDENTITY_REGISTRY_ADDRESS as
  | `0x${string}`
  | undefined;
const DELEGATE_CONTRACT_ADDRESS = process.env.DELEGATE_CONTRACT_ADDRESS as
  | `0x${string}`
  | undefined;
const TEST_CONTRACT_ADDRESS = process.env.TEST_CONTRACT_ADDRESS as `0x${string}` | undefined;
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

const delegateContractAbi = parseAbi([
  "function register(address registry) returns (uint256 agentId)",
  "function register(address registry, string calldata tokenURI) returns (uint256 agentId)",
  "function register(address registry, string calldata tokenURI, MetadataEntry[] calldata metadata) returns (uint256 agentId)",
  "function testDelegation(address testContract, string calldata message) external",
  "function getVersion(address registry) external view returns (string memory version)",
  "function getVersion(address registry) external",
  "event TestVersion(address indexed caller, address indexed registry, string version)",
  "struct MetadataEntry { string key; bytes value; }",
]);

const testContractAbi = parseAbi([
  "function testLog(string calldata message) external",
  "function testLogWithRegistry(address registry, string calldata message) external",
  "event TestLog(address indexed caller, string message, uint256 timestamp)",
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

// Store client address -> { agentId, feedbackAuth } mapping (for v2)
const feedbackAuthStore = new Map<string, { agentId: string; feedbackAuth: string }>();

// Store agent address -> agentId mapping (for v1)
const agentAddressStore = new Map<string, string>();

function createPaymentHash(paymentPayload: PaymentPayload): string {
  return crypto.createHash("sha256").update(JSON.stringify(paymentPayload)).digest("hex");
}

type RegisterInfo = {
  agentAddress: Address;
  authorization: Authorization;
  tokenURI?: string;
  metadata?: { key: string; value: string }[];
  network?: string;
};

type RegisterResult = {
  success: boolean;
  network?: string;
  agentId?: string;
  agentOwner?: string;
  txHash?: string;
  error?: string;
};

type GenerateFeedbackAuthResult = {
  success: boolean;
  agentId?: string;
  feedbackAuth?: string;
  error?: string;
};

const registerAgent = async (info: RegisterInfo): Promise<RegisterResult> => {
  const { network, tokenURI, metadata, agentAddress, authorization } = info;

  if (!network) {
    console.log("Registration failed: missing network");
    return {
      success: false,
      error: "Missing required field: network",
    };
  }

  if (!RPC_URL || !ERC8004_IDENTITY_REGISTRY_ADDRESS || !DELEGATE_CONTRACT_ADDRESS) {
    console.log("Registration failed: missing RPC_URL, REGISTRY address, or DELEGATE address");
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

    if (!FACILITATOR_PRIVATE_KEY) {
      console.log("Registration failed: FACILITATOR_PRIVATE_KEY required");
      return {
        success: false,
        error: "Facilitator private key not configured",
      };
    }

    const account = privateKeyToAccount(FACILITATOR_PRIVATE_KEY as `0x${string}`);
    const walletClient = createWalletClient({ account, chain, transport: http(RPC_URL) });

    // Prepare metadata entries if provided
    let metadataEntries: Array<{ key: string; value: `0x${string}` }> | undefined;
    if (metadata && metadata.length > 0) {
      metadataEntries = metadata.map((entry: { key: string; value: string }) => ({
        key: entry.key,
        value: entry.value.startsWith("0x")
          ? (entry.value as `0x${string}`)
          : (`0x${Buffer.from(entry.value).toString("hex")}` as `0x${string}`),
      }));
    }

    // Verify authorization matches delegate contract
    const delegateAddress = DELEGATE_CONTRACT_ADDRESS!; // Already checked above
    if (authorization.address.toLowerCase() !== delegateAddress.toLowerCase()) {
      console.error(
        `❌ Authorization address mismatch! Expected: ${delegateAddress}, Got: ${authorization.address}`,
      );
      return {
        success: false,
        error: `Authorization address (${authorization.address}) does not match delegate contract address (${delegateAddress})`,
      };
    }

    console.log(`✅ Authorization verified:`);
    console.log(`   - Delegate Address: ${authorization.address}`);
    console.log(`   - ChainId: ${authorization.chainId}`);
    console.log(`   - Nonce: ${authorization.nonce}`);
    console.log(`   - Agent Address: ${agentAddress}`);

    // Execute EIP-7702 transaction with authorization list
    // The call is made to the agent's address (which is delegated to the delegate contract)
    // The delegate contract will call IdentityRegistry.register() with agent as msg.sender
    let data: `0x${string}`;
    if (metadataEntries && metadataEntries.length > 0) {
      data = encodeFunctionData({
        abi: delegateContractAbi,
        functionName: "register",
        args: [ERC8004_IDENTITY_REGISTRY_ADDRESS, tokenURI || "", metadataEntries],
      });
    } else if (tokenURI) {
      data = encodeFunctionData({
        abi: delegateContractAbi,
        functionName: "register",
        args: [ERC8004_IDENTITY_REGISTRY_ADDRESS, tokenURI],
      });
    } else {
      data = encodeFunctionData({
        abi: delegateContractAbi,
        functionName: "register",
        args: [ERC8004_IDENTITY_REGISTRY_ADDRESS],
      });
    }

    const hash = await walletClient.sendTransaction({
      authorizationList: [authorization],
      data,
      to: agentAddress, // The EOA that's being delegated
    });

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

    let agentId: string | undefined;
    if (registeredEvent) {
      try {
        const decoded = decodeEventLog({
          abi: identityRegistryAbi,
          data: registeredEvent.data,
          topics: registeredEvent.topics,
        });
        if (decoded.eventName === "Registered") {
          console.log("Registered event decoded:", decoded);
          agentId = decoded.args.agentId?.toString();
        }
      } catch (err) {
        console.log("ERC-8004: Failed to decode Registered event", err);
      }
    }

    return {
      success: true,
      network,
      txHash: hash,
      agentOwner: agentAddress, // Agent is the owner, not facilitator
      agentId,
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

const generateClientFeedbackAuth = async (
  agentId: string,
  clientAddress: Address,
  network: string,
): Promise<GenerateFeedbackAuthResult> => {
  if (!RPC_URL || !ERC8004_IDENTITY_REGISTRY_ADDRESS) {
    return {
      success: false,
      error: "Facilitator not configured for ERC-8004",
    };
  }

  if (!FACILITATOR_PRIVATE_KEY) {
    return {
      success: false,
      error: "Facilitator private key not configured",
    };
  }

  const chain = mapX402NetworkToChain(network, RPC_URL);
  if (!chain) {
    return {
      success: false,
      error: `Unsupported network: ${network}`,
    };
  }

  try {
    const publicClient = createPublicClient({ chain, transport: http(RPC_URL) });
    const account = privateKeyToAccount(FACILITATOR_PRIVATE_KEY as `0x${string}`);
    const facilitatorAddress = account.address;

    // Get the actual chain ID from the blockchain
    const actualChainId = await publicClient.getChainId();

    // Check if agent exists and belongs to facilitator
    try {
      const agentIdBigInt = BigInt(agentId);
      const owner = await publicClient.readContract({
        address: ERC8004_IDENTITY_REGISTRY_ADDRESS,
        abi: identityRegistryAbi,
        functionName: "ownerOf",
        args: [agentIdBigInt],
      });

      // Verify ownership
      if (owner.toLowerCase() !== facilitatorAddress.toLowerCase()) {
        return {
          success: false,
          error: `Agent ${agentId} exists but belongs to different owner: ${owner}`,
        };
      }

      // Agent exists and belongs to facilitator - generate feedbackAuth
      console.log(
        `ERC-8004: Agent ${agentId} exists and belongs to facilitator, generating feedbackAuth`,
      );

      const feedbackAuth = await generateFeedbackAuth(
        agentId,
        clientAddress,
        facilitatorAddress,
        FACILITATOR_PRIVATE_KEY as `0x${string}`,
        actualChainId,
      );

      // Store feedbackAuth and agentId
      feedbackAuthStore.set(clientAddress.toLowerCase(), {
        agentId,
        feedbackAuth,
      });

      console.log(
        `📝 Stored feedbackAuth and agentId (${agentId}) for client address: ${clientAddress}`,
      );

      return {
        success: true,
        agentId,
        feedbackAuth,
      };
    } catch (err) {
      // If ownerOf reverts, agent doesn't exist
      return {
        success: false,
        error: `Agent ${agentId} does not exist: ${err instanceof Error ? err.message : "Unknown error"}`,
      };
    }
  } catch (e: any) {
    console.error("ERC-8004: Failed to generate feedbackAuth:", e?.message || e);
    return {
      success: false,
      error: e?.message || "Failed to generate feedbackAuth",
    };
  }
};

const facilitator = new x402Facilitator()
  .registerScheme("eip155:*", new ExactEvmFacilitator(evmSigner))
  .registerSchemeV1("base-sepolia" as `${string}:${string}`, new ExactEvmFacilitator(evmSigner))
  .onAfterSettle(async context => {
    // This hook only handles v2 payments (v1 is handled directly in /settle endpoint)
    const paymentPayload = context.paymentPayload;
    const extensions = paymentPayload.extensions;

    // Extract register extension data
    const registerInfo = extensions?.register as
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

    // Generate feedbackAuth for v2
    const result = await generateClientFeedbackAuth(
      registerInfo.agentId,
      clientAddress as Address,
      network,
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

      // Create public client for legacy verify
      const publicClient = createPublicClient({
        chain,
        transport: http(RPC_URL),
      });

      const response: LegacyVerifyResponse = await legacyVerify(legacyPayload, legacyRequirements);

      return res.json(response);
    } else if (x402Version === 2) {
      // Use current facilitator verify for v2
      console.log("Using x402 v2 for x402Version 2");

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

      // Generate feedbackAuth for v1 after successful settlement
      if (response.success) {
        // Get client address from v1 payment payload
        const clientAddress = (legacyPayload.payload as any)?.authorization?.from;
        const payTo = (legacyPayload.payload as any)?.authorization?.to;

        if (clientAddress) {
          // Fetch agentId from agentAddress mapping
          const agentId = agentAddressStore.get(payTo.toLowerCase());

          if (agentId) {
            console.log(`📋 Found v1 agentId ${agentId} for agentAddress ${payTo}`);

            const feedbackResult = await generateClientFeedbackAuth(
              agentId,
              clientAddress as Address,
              network,
            );

            if (feedbackResult.success && feedbackResult.feedbackAuth) {
              console.log(`✅ Generated feedbackAuth for v1 agent ${agentId}`);
            } else {
              console.error(`❌ Failed to generate feedbackAuth for v1: ${feedbackResult.error}`);
            }
          } else {
            console.warn(
              `No agentId found for v1 agentAddress ${payTo}, skipping feedbackAuth generation`,
            );
          }
        } else {
          console.warn(
            "No client address found in v1 payment payload, skipping feedbackAuth generation",
          );
        }
      }

      return res.json(response);
    } else if (x402Version === 2) {
      // Use current facilitator settle for v2
      console.log("Using x402 v2 for x402Version 2");

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
