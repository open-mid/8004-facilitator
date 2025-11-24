// ============================================================================
// Imports
// ============================================================================

import { config } from "dotenv";
import express from "express";
import { paymentMiddleware, Resource, type SolanaAddress } from "x402-express";
import { createWalletClient, http, type Address, type Authorization } from "viem";
import { baseSepolia } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";

config();

// ============================================================================
// Environment Variables & Configuration
// ============================================================================

const facilitatorUrl = process.env.FACILITATOR_URL as Resource;
const payTo = process.env.ADDRESS as `0x${string}` | SolanaAddress;
const agentPrivateKey = process.env.AGENT_PRIVATE_KEY as `0x${string}` | undefined;
const delegateContractAddress = process.env.DELEGATE_CONTRACT_ADDRESS as `0x${string}` | undefined;

// Validate required environment variables
if (!facilitatorUrl || !payTo) {
  console.error("Missing required environment variables");
  process.exit(1);
}

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Generate EIP-7702 authorization for agent registration
 * @param delegateContractAddress The delegate contract address
 * @param agentPrivateKey The agent's private key
 * @param chainId The chain ID
 * @returns Authorization object for EIP-7702
 */
async function generateRegistrationAuthorization(
  delegateContractAddress: Address,
  agentPrivateKey: `0x${string}`,
  chainId: number,
): Promise<Authorization> {
  const agentAccount = privateKeyToAccount(agentPrivateKey);

  const walletClient = createWalletClient({
    account: agentAccount,
    chain: baseSepolia,
    transport: http(),
  });

  const authorization = await walletClient.signAuthorization({
    account: agentAccount,
    contractAddress: delegateContractAddress,
    chainId,
  });

  return authorization;
}

// ============================================================================
// Express App Setup
// ============================================================================

const app = express();
app.use(express.json());

// Configure payment middleware
app.use(
  paymentMiddleware(
    payTo,
    {
      "GET /resource": {
        // USDC amount in dollars
        price: "$0.001",
        network: "base-sepolia",
      },
    },
    {
      url: facilitatorUrl,
    },
  ),
);

// ============================================================================
// Routes
// ============================================================================

/**
 * GET /resource
 * Protected resource endpoint that requires payment
 */
app.get("/resource", (req, res) => {
  res.send({
    resource: "This is a resource",
  });
});

/**
 * POST /register-agent
 * Register an agent with ERC-8004 using EIP-7702
 * Request body:
 * {
 *   tokenURI?: string,
 *   metadata?: Array<{key: string, value: string}>,
 *   network?: string (default: "base-sepolia"),
 *   chainId?: number (default: 84532 for Base Sepolia)
 * }
 */
app.post("/register-agent", async (req, res) => {
  try {
    const {
      tokenURI,
      metadata,
      network = "base-sepolia",
      chainId = 84532, // Base Sepolia chain ID
    } = req.body;

    // Validate required environment variables
    if (!delegateContractAddress) {
      return res.status(500).json({
        success: false,
        error: "DELEGATE_CONTRACT_ADDRESS environment variable is not set",
      });
    }

    if (!agentPrivateKey) {
      return res.status(500).json({
        success: false,
        error: "AGENT_PRIVATE_KEY environment variable is not set",
      });
    }

    // Normalize private key - add 0x prefix if missing
    const normalizedPrivateKey = agentPrivateKey.startsWith("0x")
      ? agentPrivateKey
      : (`0x${agentPrivateKey}` as `0x${string}`);

    // Get agent address from private key
    const agentAccount = privateKeyToAccount(normalizedPrivateKey);
    const agentAddress = agentAccount.address;

    console.log(`Generating EIP-7702 authorization for agent ${agentAddress}`);

    // Generate authorization - delegate to the delegate contract
    const authorization = await generateRegistrationAuthorization(
      delegateContractAddress as Address,
      normalizedPrivateKey,
      chainId,
    );

    console.log(`Authorization generated, calling facilitator /register endpoint`);

    // Serialize authorization - convert BigInt values to strings for JSON
    const serializedAuthorization = {
      chainId: authorization.chainId.toString(),
      address: authorization.address,
      nonce: authorization.nonce.toString(),
      yParity: authorization.yParity,
      r: authorization.r,
      s: authorization.s,
    };

    // Call facilitator's /register endpoint
    const registerResponse = await fetch(`${facilitatorUrl}/register`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        agentAddress,
        authorization: serializedAuthorization,
        tokenURI,
        metadata,
        network,
        x402Version: 1,
      }),
    });

    const result = await registerResponse.json();

    if (!registerResponse.ok) {
      return res.status(registerResponse.status).json(result);
    }

    res.json(result);
  } catch (error) {
    console.error("Register agent error:", error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
});

// ============================================================================
// Server Startup
// ============================================================================

const PORT = 4023;

app.listen(PORT, () => {
  console.log(`Server listening at http://localhost:${PORT}`);
});
