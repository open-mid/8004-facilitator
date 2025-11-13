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
// Normalize private keys - add 0x prefix if missing
let FACILITATOR_PRIVATE_KEY = process.env.FACILITATOR_PRIVATE_KEY;
if (FACILITATOR_PRIVATE_KEY && !FACILITATOR_PRIVATE_KEY.startsWith("0x")) {
  FACILITATOR_PRIVATE_KEY = "0x" + FACILITATOR_PRIVATE_KEY;
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
  "function agentExists(uint256 agentId) view returns (bool exists)",
  "function balanceOf(address owner) view returns (uint256 balance)",
  "event Registered(uint256 indexed agentId, string tokenURI, address indexed owner)",
  "struct MetadataEntry { string key; bytes value; }",
]);

const SUPPORTED_NETWORKS = ["base-sepolia", "base"];

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

    res.json({
      success: true,
      network,
      txHash: hash,
      agentOwner: facilitatorAddress,
      agentId,
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
});
