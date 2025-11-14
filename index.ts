import { config } from "dotenv";
import express, { Request, Response } from "express";
import { verify, settle } from "x402/facilitator";
import {
  PaymentRequirementsSchema,
  type PaymentRequirements,
  type PaymentPayload,
  PaymentPayloadSchema,
  createConnectedClient,
  createSigner,
} from "x402/types";
import {
  createPublicClient,
  createWalletClient,
  http,
  parseAbi,
  encodeFunctionData,
  decodeEventLog,
  encodeAbiParameters,
  keccak256,
  encodePacked,
  type Address,
} from "viem";
import { anvil, base, baseSepolia, type Chain } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";

config();

const app = express();
const PORT = process.env.PORT || 4020;
const RPC_URL = process.env.RPC_URL as string | undefined;
const ERC8004_IDENTITY_REGISTRY_ADDRESS = process.env.ERC8004_IDENTITY_REGISTRY_ADDRESS as
  | `0x${string}`
  | undefined;
const ERC8004_REPUTATION_REGISTRY_ADDRESS = process.env.ERC8004_REPUTATION_REGISTRY_ADDRESS as
  | `0x${string}`
  | undefined;
// Normalize private keys - add 0x prefix if missing
let FACILITATOR_PRIVATE_KEY = process.env.FACILITATOR_PRIVATE_KEY;
if (FACILITATOR_PRIVATE_KEY && !FACILITATOR_PRIVATE_KEY.startsWith("0x")) {
  FACILITATOR_PRIVATE_KEY = "0x" + FACILITATOR_PRIVATE_KEY;
}

let FEEDBACK_PRIVATE_KEY = process.env.FEEDBACK_PRIVATE_KEY;
if (FEEDBACK_PRIVATE_KEY && !FEEDBACK_PRIVATE_KEY.startsWith("0x")) {
  FEEDBACK_PRIVATE_KEY = "0x" + FEEDBACK_PRIVATE_KEY;
}

let EVM_PRIVATE_KEY = process.env.EVM_PRIVATE_KEY || "";
if (EVM_PRIVATE_KEY && !EVM_PRIVATE_KEY.startsWith("0x")) {
  EVM_PRIVATE_KEY = "0x" + EVM_PRIVATE_KEY;
}

// Request logging middleware (before JSON parsing to catch all requests)
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
  next();
});

// JSON parsing middleware with error handling
app.use(express.json());

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

  // Otherwise, use the mapped network chain
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

const feedbackAbi = parseAbi([
  "function giveFeedback(uint256 agentId, uint8 score, bytes32 tag1, bytes32 tag2, string calldata fileuri, bytes32 filehash, bytes memory feedbackAuth)",
  "event NewFeedback(uint256 indexed agentId, address indexed client, uint8 score, bytes32 tag1, bytes32 tag2, string fileuri, bytes32 filehash)",
]);

const SUPPORTED_NETWORKS = ["base-sepolia", "base"];

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

// GET /health - Health check endpoint
app.get("/health", (req, res) => {
  console.log("Health check requested");
  res.json({ status: "healthy" });
});

// GET /supported - Get supported payment kinds
app.get("/supported", (req, res) => {
  const response = {
    schemes: ["exact"],
    networks: SUPPORTED_NETWORKS,
  };
  console.log("Returning supported schemes:", response);
  res.json(response);
});

// GET /verify - Info endpoint
app.get("/verify", (req: Request, res: Response) => {
  res.json({
    endpoint: "/verify",
    description: "POST to verify x402 payments",
    body: {
      paymentPayload: "PaymentPayload",
      paymentRequirements: "PaymentRequirements",
    },
  });
});

// POST /verify - Verify a payment payload
app.post("/verify", async (req: Request, res: Response) => {
  try {
    const body: { paymentPayload: PaymentPayload; paymentRequirements: PaymentRequirements } =
      req.body;
    const paymentRequirements = PaymentRequirementsSchema.parse(body.paymentRequirements);
    const paymentPayload = PaymentPayloadSchema.parse(body.paymentPayload);

    if (!SUPPORTED_NETWORKS.includes(paymentRequirements.network)) {
      throw new Error("Invalid network - only EVM networks are supported");
    }

    const client = createConnectedClient(paymentRequirements.network);
    const valid = await verify(client, paymentPayload, paymentRequirements);

    console.log("Verification result:", valid);
    res.json(valid);
  } catch (error) {
    console.error("error", error);
    res.status(400).json({ error: "Invalid request" });
  }
});

// GET /settle - Info endpoint
app.get("/settle", (req: Request, res: Response) => {
  res.json({
    endpoint: "/settle",
    description: "POST to settle x402 payments",
    body: {
      paymentPayload: "PaymentPayload",
      paymentRequirements: "PaymentRequirements",
    },
  });
});

// POST /settle - Submit payment on-chain
app.post("/settle", async (req: Request, res: Response) => {
  try {
    const body: { paymentPayload: PaymentPayload; paymentRequirements: PaymentRequirements } =
      req.body;
    const paymentRequirements = PaymentRequirementsSchema.parse(body.paymentRequirements);
    const paymentPayload = PaymentPayloadSchema.parse(body.paymentPayload);

    if (!SUPPORTED_NETWORKS.includes(paymentRequirements.network)) {
      throw new Error("Invalid network - only EVM networks are supported");
    }

    const signer = await createSigner(
      paymentRequirements.network,
      EVM_PRIVATE_KEY as `0x${string}`,
    );
    const response = await settle(signer, paymentPayload, paymentRequirements);

    res.json(response);
  } catch (error) {
    console.error("error", error);
    res.status(400).json({ error: `Invalid request: ${error}` });
  }
});

// POST /register - Register agent with ERC-8004
app.post("/register", async (req, res) => {
  const {
    network,
    tokenURI,
    metadata,
    mode = "self",
    agentId: requestedAgentId,
    clientAddress,
  } = req.body;

  if (!network) {
    console.log("Registration failed: missing network");
    return res.status(400).json({
      success: false,
      error: "Missing required field: network",
    });
  }

  if (!RPC_URL || !ERC8004_IDENTITY_REGISTRY_ADDRESS) {
    console.log("Registration failed: missing RPC_URL or REGISTRY address");
    return res.status(500).json({
      success: false,
      error: "Facilitator not configured for ERC-8004 registration",
    });
  }

  const chain = mapX402NetworkToChain(network, RPC_URL);
  if (!chain) {
    console.log("Registration failed: unsupported network:", network);
    return res.status(400).json({
      success: false,
      error: `Unsupported network: ${network}`,
    });
  }

  try {
    const publicClient = createPublicClient({ chain, transport: http(RPC_URL) });

    // Get the actual chain ID from the blockchain to ensure it matches
    const actualChainId = await publicClient.getChainId();

    if (mode === "prepare") {
      // Prepare transaction data for agent to sign themselves
      console.log("Preparing registration transaction for agent to sign");

      let callData: `0x${string}`;

      if (metadata && metadata.length > 0) {
        // Convert metadata to proper format
        const metadataEntries = metadata.map((entry: { key: string; value: string }) => ({
          key: entry.key,
          value: entry.value.startsWith("0x")
            ? (entry.value as `0x${string}`)
            : `0x${Buffer.from(entry.value).toString("hex")}`,
        }));

        callData = encodeFunctionData({
          abi: identityRegistryAbi,
          functionName: "register",
          args: [tokenURI || "", metadataEntries],
        });
      } else if (tokenURI) {
        callData = encodeFunctionData({
          abi: identityRegistryAbi,
          functionName: "register",
          args: [tokenURI],
        });
      } else {
        callData = encodeFunctionData({
          abi: identityRegistryAbi,
          functionName: "register",
          args: [],
        });
      }

      return res.json({
        success: true,
        network,
        mode: "prepare",
        to: ERC8004_IDENTITY_REGISTRY_ADDRESS,
        data: callData,
        chainId: chain.id,
      });
    }

    // mode === "self" - facilitator registers itself
    if (!FACILITATOR_PRIVATE_KEY) {
      console.log("Registration failed: FACILITATOR_PRIVATE_KEY required for self mode");
      return res.status(500).json({
        success: false,
        error: "Facilitator private key not configured",
      });
    }

    console.log("Registering agent with ERC-8004 (self mode)");

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
          if (clientAddress && FACILITATOR_PRIVATE_KEY) {
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

          return res.json({
            success: true,
            network,
            agentOwner: facilitatorAddress,
            agentId: requestedAgentId.toString(),
            ...(feedbackAuth && { feedbackAuth }),
            // No txHash since no new registration
          });
        } else {
          // Agent exists but belongs to different owner
          console.log(
            `ERC-8004: Agent ${requestedAgentId} exists but belongs to different owner: ${owner}`,
          );
          return res.status(400).json({
            success: false,
            error: `Agent ${requestedAgentId} exists but belongs to different owner: ${owner}`,
            network,
          });
        }
      } catch (err) {
        // If ownerOf reverts, the agent doesn't exist
        // Don't proceed with registration if we can't verify
        console.error(
          "ERC-8004: Agent does not exist or error checking ownership, cannot proceed with registration",
          err,
        );
        return res.status(400).json({
          success: false,
          error: `Agent ${requestedAgentId} does not exist or failed to verify: ${err instanceof Error ? err.message : "Unknown error"}`,
          network,
        });
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

    res.json({
      success: true,
      network,
      txHash: hash,
      agentOwner: facilitatorAddress,
      agentId,
      ...(feedbackAuth && { feedbackAuth }),
    });
  } catch (e: any) {
    console.error("ERC-8004: Registration failed:", e?.message || e);

    res.status(500).json({
      success: false,
      error: e?.message || "Registration failed",
      network,
    });
  }
});

// POST /feedback - Submit feedback/reputation for an agent
app.post("/feedback", async (req: Request, res: Response) => {
  console.log("=== /feedback endpoint hit ===");
  console.log("Request body:", JSON.stringify(req.body, null, 2));

  const {
    network,
    agentId,
    score,
    tag1,
    tag2,
    fileuri,
    filehash,
    feedbackAuth,
    mode = "self",
  } = req.body;

  if (!network) {
    console.log("Feedback failed: missing network");
    return res.status(400).json({
      success: false,
      error: "Missing required field: network",
    });
  }

  if (!agentId) {
    console.log("Feedback failed: missing agentId");
    return res.status(400).json({
      success: false,
      error: "Missing required field: agentId",
    });
  }

  if (score === undefined || score === null) {
    console.log("Feedback failed: missing score");
    return res.status(400).json({
      success: false,
      error: "Missing required field: score (0-100)",
    });
  }

  if (!feedbackAuth) {
    console.log("Feedback failed: missing feedbackAuth");
    return res.status(400).json({
      success: false,
      error: "Missing required field: feedbackAuth",
    });
  }

  // Validate score range
  const scoreNum = Number(score);
  if (scoreNum < 0 || scoreNum > 100) {
    console.log("Feedback failed: invalid score range");
    return res.status(400).json({
      success: false,
      error: "Score must be between 0 and 100",
    });
  }

  if (!ERC8004_REPUTATION_REGISTRY_ADDRESS) {
    console.log("Feedback failed: missing ERC8004_REPUTATION_REGISTRY_ADDRESS address");
    return res.status(500).json({
      success: false,
      error: "Facilitator not configured for ERC-8004 feedback",
    });
  }

  if (!RPC_URL) {
    console.log("Feedback failed: missing RPC_URL");
    return res.status(500).json({
      success: false,
      error: "Facilitator not configured with RPC URL",
    });
  }

  const chain = mapX402NetworkToChain(network, RPC_URL);
  if (!chain) {
    console.log("Feedback failed: unsupported network:", network);
    return res.status(400).json({
      success: false,
      error: `Unsupported network: ${network}`,
    });
  }

  const agentIdBigInt = BigInt(agentId);

  // Convert optional parameters to proper types
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

  try {
    const publicClient = createPublicClient({ chain, transport: http(RPC_URL) });

    // Verify agent exists - ownerOf will revert if agent doesn't exist
    if (ERC8004_IDENTITY_REGISTRY_ADDRESS) {
      try {
        await publicClient.readContract({
          address: ERC8004_IDENTITY_REGISTRY_ADDRESS,
          abi: identityRegistryAbi,
          functionName: "ownerOf",
          args: [agentIdBigInt],
        });
        // If ownerOf succeeds, agent exists
      } catch (err) {
        // If ownerOf reverts, agent doesn't exist
        console.log("Feedback failed: agent does not exist:", agentId, err);
        return res.status(400).json({
          success: false,
          error: `Agent ${agentId} does not exist`,
        });
      }
    }

    if (mode === "prepare") {
      // Prepare transaction data for client to sign themselves
      console.log("Preparing feedback transaction for client to sign");

      const callData = encodeFunctionData({
        abi: feedbackAbi,
        functionName: "giveFeedback",
        args: [
          agentIdBigInt,
          scoreNum,
          tag1Bytes32,
          tag2Bytes32,
          fileuriStr,
          filehashBytes32,
          feedbackAuthBytes,
        ],
      });

      return res.json({
        success: true,
        network,
        mode: "prepare",
        to: ERC8004_REPUTATION_REGISTRY_ADDRESS,
        data: callData,
        chainId: chain.id,
        agentId: agentId.toString(),
      });
    }

    // mode === "self" - facilitator submits feedback
    if (!FEEDBACK_PRIVATE_KEY) {
      console.log("Feedback failed: FEEDBACK_PRIVATE_KEY required for self mode");
      return res.status(500).json({
        success: false,
        error: "Feedback private key not configured",
      });
    }

    console.log("Submitting feedback for agent with ERC-8004 (self mode)");

    const account = privateKeyToAccount(FEEDBACK_PRIVATE_KEY as `0x${string}`);
    const walletClient = createWalletClient({ account, chain, transport: http(RPC_URL) });

    const hash = await walletClient.writeContract({
      address: ERC8004_REPUTATION_REGISTRY_ADDRESS,
      abi: feedbackAbi,
      functionName: "giveFeedback",
      args: [
        agentIdBigInt,
        scoreNum,
        tag1Bytes32,
        tag2Bytes32,
        fileuriStr,
        filehashBytes32,
        feedbackAuthBytes,
      ],
    });

    console.log("ERC-8004: feedback tx submitted:", hash);

    // Wait for transaction receipt and extract event data
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    console.log("ERC-8004: feedback confirmed in block", receipt.blockNumber);

    // Extract data from NewFeedback event
    const feedbackEvent = receipt.logs.find(log => {
      try {
        const decoded = decodeEventLog({
          abi: feedbackAbi,
          data: log.data,
          topics: log.topics,
        });
        return decoded.eventName === "NewFeedback";
      } catch {
        return false;
      }
    });

    let eventData: any = undefined;
    if (feedbackEvent) {
      try {
        const decoded = decodeEventLog({
          abi: feedbackAbi,
          data: feedbackEvent.data,
          topics: feedbackEvent.topics,
        });
        if (decoded.eventName === "NewFeedback") {
          eventData = {
            agentId: decoded.args.agentId?.toString(),
            client: decoded.args.client,
            score: decoded.args.score,
            tag1: decoded.args.tag1,
            tag2: decoded.args.tag2,
            fileuri: decoded.args.fileuri,
            filehash: decoded.args.filehash,
          };
        }
      } catch (err) {
        console.log("ERC-8004: Failed to decode NewFeedback event", err);
      }
    }

    res.json({
      success: true,
      network,
      txHash: hash,
      agentId: agentId.toString(),
      event: eventData,
    });
  } catch (e: any) {
    console.error("ERC-8004: Feedback submission failed:", e?.message || e);
    res.status(500).json({
      success: false,
      error: e?.message || "Feedback submission failed",
      network,
    });
  }
});

// Catch-all for unsupported routes
app.use("*", (req, res) => {
  console.log(`Unsupported route accessed: ${req.method} ${req.originalUrl}`);
  res.status(404).json({
    error: "Endpoint not found",
  });
});

// Error handling middleware
app.use((err: Error, req: express.Request, res: express.Response, next: express.NextFunction) => {
  console.error("Error:", err);
  res.status(500).json({
    error: "Internal server error",
    message: err.message,
  });
});

app.listen(PORT, () => {
  console.log(`🚀 x402 ERC-8004 Facilitator running on http://localhost:${PORT}`);
  console.log(`Endpoints available:`);
  console.log(`  GET  /health`);
  console.log(`  GET  /supported`);
  console.log(`  POST /verify`);
  console.log(`  POST /settle`);
  console.log(`  POST /register`);
  console.log(`  POST /feedback`);
});
