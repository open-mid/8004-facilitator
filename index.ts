import { config } from "dotenv";
import express from "express";
import {
  createPublicClient,
  createWalletClient,
  http,
  parseAbi,
  getAddress,
  encodeFunctionData,
  decodeEventLog,
} from "viem";
import { anvil, base, baseSepolia, sepolia, polygonAmoy, type Chain } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";

config();

const app = express();
const PORT = process.env.PORT || 4020;
const RPC_URL = process.env.RPC_URL as string | undefined;
const ERC8004_IDENTITY_REGISTRY_ADDRESS = process.env.ERC8004_IDENTITY_REGISTRY_ADDRESS as
  | `0x${string}`
  | undefined;
const FACILITATOR_PRIVATE_KEY = process.env.FACILITATOR_PRIVATE_KEY as `0x${string}` | undefined;

// Request logging middleware (before JSON parsing to catch all requests)
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
  console.log("Headers:", JSON.stringify(req.headers, null, 2));
  next();
});

// JSON parsing middleware with error handling
app.use(express.json());

// In-memory storage for payment status (in production, use a real database)
const paymentStatuses = new Map<
  string,
  {
    status: "pending" | "confirmed" | "failed";
    txHash?: string;
    error?: string;
    agentAddress?: string; // payee (authorization.to)
    payerAddress?: string; // payer (authorization.from)
  }
>();

// In-memory storage for registration status
const registrationStatuses = new Map<
  string,
  {
    status: "pending" | "confirmed" | "failed";
    txHash?: string;
    agentId?: string;
    agentOwner?: string;
    network?: string;
    error?: string;
  }
>();

function isLocalRPC(rpcUrl?: string): boolean {
  if (!rpcUrl) return false;
  try {
    const url = new URL(rpcUrl);
    return (
      url.hostname === "localhost" ||
      url.hostname === "127.0.0.1" ||
      url.hostname === "0.0.0.0" ||
      url.hostname === "::1"
    );
  } catch {
    // If URL parsing fails, check if it contains localhost or 127.0.0.1
    return rpcUrl.includes("localhost") || rpcUrl.includes("127.0.0.1");
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
    case "sepolia":
      return sepolia;
    case "polygon-amoy":
      return polygonAmoy;
    default:
      return undefined;
  }
}

const identityRegistryAbi = parseAbi([
  "function register() returns (uint256 agentId)",
  "function register(string calldata tokenURI_) returns (uint256 agentId)",
  "function register(string calldata tokenURI_, MetadataEntry[] calldata metadata) returns (uint256 agentId)",
  "function agentExists(uint256 agentId) view returns (bool exists)",
  "function balanceOf(address owner) view returns (uint256 balance)",
  "event Registered(uint256 indexed agentId, string tokenURI, address indexed owner)",
  "struct MetadataEntry { string key; bytes value; }",
]);

// GET /health - Health check endpoint
app.get("/health", (req, res) => {
  console.log("Health check requested");
  res.json({ status: "healthy" });
});

// GET /supported - Get supported payment kinds
app.get("/supported", (req, res) => {
  console.log("Supported payment kinds requested");
  // Return dummy supported networks/schemes
  const response = {
    schemes: ["exact"],
    networks: [
      "base-sepolia",
      "base",
      "ethereum",
      "optimism",
      "sepolia",
      "solana",
      "solana-devnet",
    ],
  };
  console.log("Returning supported schemes:", response);
  res.json(response);
});

// POST /verify - Verify a payment payload
app.post("/verify", (req, res) => {
  console.log("=== /verify endpoint hit ===");
  console.log("Request body keys:", Object.keys(req.body || {}));
  console.log("Request body:", JSON.stringify(req.body, null, 2));

  const { paymentPayload, paymentRequirements, x402Version } = req.body;

  // Dummy facilitator - accept everything
  // In a real implementation, you would:
  // 1. Parse and validate the payment signature
  // 2. Verify the signature against the payer's address
  // 3. Check payment amount matches requirements
  // 4. Validate network and chain ID
  // 5. Verify nonce hasn't been reused

  if (!paymentPayload) {
    console.log("Verification failed: missing payment payload");
    return res.status(400).json({
      isValid: false,
      invalidReason: "invalid_exact_evm_payload_signature",
    });
  }

  // Extract addresses from the payment payload
  const payer = paymentPayload.payload?.authorization?.from;
  const agent = paymentPayload.payload?.authorization?.to;

  // Generate a dummy payment ID for tracking
  const paymentId = `pay_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

  // Store initial status (include addresses for later registration)
  paymentStatuses.set(paymentId, {
    status: "pending",
    agentAddress: agent,
    payerAddress: payer,
  });

  // In a real implementation, verify signature here
  // const isValid = await verifyPaymentSignature(paymentPayload);

  console.log("Verification successful, payment ID:", paymentId);

  // Return response matching VerifyResponseSchema
  res.json({
    isValid: true,
    payer,
  });
});

// POST /settle - Submit payment on-chain
app.post("/settle", async (req, res) => {
  const { paymentPayload, paymentRequirements, x402Version } = req.body;

  console.log("Settlement request received:", JSON.stringify(req.body, null, 2));

  if (!paymentPayload) {
    console.log("Settlement failed: missing payment payload");
    return res.status(400).json({
      success: false,
      errorReason: "invalid_exact_evm_payload_signature",
    });
  }

  // Generate a dummy transaction hash
  const transaction = `0x${Date.now().toString(16)}${Math.random().toString(16).substr(2, 56)}`;

  // Extract network from payment payload
  const network = paymentPayload.network;

  // In a real implementation, you would:
  // 1. Connect to the appropriate blockchain network
  // 2. Build and sign the transaction
  // 3. Submit the transaction to the network
  // 4. Wait for confirmation
  // 5. Return the transaction hash

  console.log("Settlement successful, transaction hash:", transaction);

  // Extract addresses from the payment payload
  const payer = paymentPayload.payload?.authorization?.from;
  const agent = paymentPayload.payload?.authorization?.to;

  // Update payment status
  const paymentId =
    paymentPayload.payload?.authorization?.nonce ||
    `pay_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  paymentStatuses.set(paymentId, {
    status: "confirmed",
    txHash: transaction,
    agentAddress: agent,
    payerAddress: payer,
  });

  // Return response matching SettleResponseSchema
  res.json({
    success: true,
    transaction,
    network,
    payer,
  });
});

// POST /register - Register agent with ERC-8004
app.post("/register", async (req, res) => {
  console.log("=== /register endpoint hit ===");
  console.log("Request body:", JSON.stringify(req.body, null, 2));

  const { network, tokenURI, metadata, mode = "self" } = req.body;

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

  const registrationId = `reg_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

  // Store initial status
  registrationStatuses.set(registrationId, {
    status: "pending",
    network,
  });

  try {
    const publicClient = createPublicClient({ chain, transport: http(RPC_URL) });

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

      registrationStatuses.set(registrationId, {
        status: "confirmed",
        network,
      });

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

    const account = privateKeyToAccount(FACILITATOR_PRIVATE_KEY);
    const walletClient = createWalletClient({ account, chain, transport: http(RPC_URL) });

    // Check if facilitator already has agents registered (weak check)
    const facilitatorAddress = account.address;
    let hasAgents = false;
    try {
      const balance = await publicClient.readContract({
        address: ERC8004_IDENTITY_REGISTRY_ADDRESS,
        abi: identityRegistryAbi,
        functionName: "balanceOf",
        args: [facilitatorAddress],
      });
      hasAgents = balance > 0n;
    } catch (err) {
      console.log("ERC-8004: balanceOf check failed, proceeding with registration", err);
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

    console.log("ERC-8004: register tx submitted:", hash);

    // Wait for transaction receipt and extract agentId from event
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    console.log("ERC-8004: register confirmed in block", receipt.blockNumber);

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

    registrationStatuses.set(registrationId, {
      status: "confirmed",
      txHash: hash,
      agentId,
      agentOwner: facilitatorAddress,
      network,
    });

    res.json({
      success: true,
      network,
      txHash: hash,
      agentOwner: facilitatorAddress,
      agentId,
    });
  } catch (e: any) {
    console.error("ERC-8004: Registration failed:", e?.message || e);
    registrationStatuses.set(registrationId, {
      status: "failed",
      network,
      error: e?.message || String(e),
    });

    res.status(500).json({
      success: false,
      error: e?.message || "Registration failed",
      network,
    });
  }
});

// GET /status/:paymentId - Get payment status
app.get("/status/:paymentId", (req, res) => {
  const { paymentId } = req.params;

  console.log(`Status check requested for payment ID: ${paymentId}`);

  const status = paymentStatuses.get(paymentId);

  if (!status) {
    console.log(`Payment not found: ${paymentId}`);
    return res.status(404).json({
      error: "Payment not found",
    });
  }

  console.log(`Status for ${paymentId}:`, status);
  res.json({
    paymentId,
    ...status,
  });
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
  console.log(`🚀 Dummy x402 Facilitator running on http://localhost:${PORT}`);
  console.log(`Endpoints available:`);
  console.log(`  GET  /health`);
  console.log(`  GET  /supported`);
  console.log(`  POST /verify`);
  console.log(`  POST /settle`);
  console.log(`  POST /register`);
  console.log(`  GET  /status/:paymentId`);
});
