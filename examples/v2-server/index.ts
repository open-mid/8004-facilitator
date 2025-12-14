// ============================================================================
// Imports
// ============================================================================

import { config } from "dotenv";
import express from "express";
import { paymentMiddleware } from "@x402/express";
import { HTTPFacilitatorClient, x402ResourceServer } from "@x402/core/server";
import { registerExactEvmScheme } from "@x402/evm/exact/server";
import { createWalletClient, http, type Address, type Authorization } from "viem";
import { baseSepolia } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import type { Hex } from "viem";

config();

// ============================================================================
// Environment Variables & Configuration
// ============================================================================

const facilitatorUrl = process.env.FACILITATOR_URL;
const payTo = process.env.ADDRESS as `0x${string}`;
const agentPrivateKey = process.env.AGENT_PRIVATE_KEY as `0x${string}` | undefined;
const delegateContractAddress = process.env.DELEGATE_CONTRACT_ADDRESS as `0x${string}` | undefined;

// Validate required environment variables
if (!agentPrivateKey) {
  console.error("AGENT_PRIVATE_KEY environment variable is not set");
  process.exit(1);
}

if (!facilitatorUrl || !payTo) {
  console.error("Missing required environment variables");
  process.exit(1);
}

const agentAccount = privateKeyToAccount(agentPrivateKey);
console.log("agent address:", agentAccount.address);

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
async function generateSerializedRegistrationAuthorization(
  delegateContractAddress: Address,
  agentPrivateKey: `0x${string}`,
  chainId: number,
): Promise<{
  chainId: string;
  address: `0x${string}`;
  nonce: string;
  yParity: number | undefined;
  r: `0x${string}`;
  s: `0x${string}`;
}> {
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

  const serializedAuthorization = {
    chainId: authorization.chainId.toString(),
    address: authorization.address,
    nonce: authorization.nonce.toString(),
    yParity: authorization.yParity,
    r: authorization.r,
    s: authorization.s,
  };
  return serializedAuthorization;
}

// ============================================================================
// Express App Setup
// ============================================================================

const app = express();
app.use(express.json());

// Initialize x402 facilitator client and service
const facilitatorClient = new HTTPFacilitatorClient({ url: facilitatorUrl });
const service = new x402ResourceServer(facilitatorClient);
registerExactEvmScheme(service);

const registerAuth = await generateSerializedRegistrationAuthorization(
  delegateContractAddress as Address,
  agentPrivateKey,
  84532,
);

// Configure payment middleware
app.use(
  paymentMiddleware(
    {
      "/weather": {
        accepts: {
          payTo,
          scheme: "exact",
          price: "$0.001",
          network: "eip155:8453",
        },
        extensions: {
          "erc-8004": {
            registerAuth: registerAuth,
            tokenURI: "https://example.com/tokenURI",
            metadata: [{ key: "name", value: "Example" }],
            feedbackAuthEndpoint: "/signFeedbackAuth",
            feedbackEnabled: true,
          },
        },
      },
    },
    service,
  ),
);

// ============================================================================
// Routes
// ============================================================================

/**
 * GET /weather
 * Protected resource endpoint that requires payment
 */
app.get("/weather", (req, res) => {
  res.send({
    report: {
      weather: "sunny",
      temperature: 70,
    },
  });
});

/**
 * POST /signFeedbackAuth
 * Sign feedback authorization hash for ERC-8004 feedback
 */
app.post("/signFeedbackAuth", async (req, res) => {
  try {
    const { hash } = req.body;

    if (!hash) {
      return res.status(400).json({
        success: false,
        error: "Missing required field: hash",
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

    // Normalize hash - ensure it's a valid hex string
    const normalizedHash = hash.startsWith("0x") ? (hash as Hex) : (`0x${hash}` as Hex);

    // Sign the hash with the agent's private key
    const agentAccount = privateKeyToAccount(normalizedPrivateKey);
    const signature = await agentAccount.sign({ hash: normalizedHash });

    console.log(`✅ Signed feedback auth hash: ${hash.substring(0, 10)}...`);

    res.json({
      success: true,
      signature,
    });
  } catch (error) {
    console.error("Sign feedback auth error:", error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
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

const PORT = 4021;

app.listen(PORT, () => {
  console.log(`Server listening at http://localhost:${PORT}`);
});
