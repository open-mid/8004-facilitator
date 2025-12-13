import {
  createPublicClient,
  http,
  encodeAbiParameters,
  keccak256,
  encodePacked,
  type Address,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { RPC_URL, ERC8004_IDENTITY_REGISTRY_ADDRESS, FACILITATOR_PRIVATE_KEY } from "../config/env";
import { identityRegistryAbi } from "../config/contracts";
import { mapX402NetworkToChain } from "../utils/network";
import type { KeyValueStore } from "./redisStore";

export type GenerateFeedbackAuthResult = {
  success: boolean;
  agentId?: string;
  feedbackAuth?: string;
  error?: string;
};

/**
 * Generate feedbackAuth for ERC-8004 feedback
 */
async function generateFeedbackAuth(
  agentId: string,
  clientAddress: Address,
  agentOwnerAddress: Address,
  agentOwnerPrivateKey: `0x${string}`,
  chainId: number,
  expiry?: bigint,
  indexLimit: bigint = 1000n,
  agentUrl?: string,
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

  // Sign the EIP-191 hash via the agent server's /signFeedbackAuth endpoint
  // Use agentUrl from context if provided, otherwise use local signing
  let signature: `0x${string}`;
  if (agentUrl) {
    try {
      // Extract base URL from agentUrl (remove path if present)
      let baseUrl: string;
      try {
        const url = new URL(agentUrl);
        baseUrl = url.origin; // Extract just the origin (protocol + host + port)
      } catch {
        // Throw
        throw new Error(`Invalid agent URL: ${agentUrl}`);
      }
      console.log(`📤 Requesting signature from agent server: ${baseUrl}/signFeedbackAuth`);
      const signResponse = await fetch(`${baseUrl}/signFeedbackAuth`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          hash: eip191Hash,
        }),
      });

      if (!signResponse.ok) {
        const errorData = await signResponse.json().catch(() => ({ error: "Unknown error" }));
        throw new Error(
          `Failed to get signature from agent server: ${errorData.error || signResponse.statusText}`,
        );
      }

      const signResult = await signResponse.json();
      if (!signResult.success || !signResult.signature) {
        throw new Error(
          `Agent server returned unsuccessful response: ${signResult.error || "No signature"}`,
        );
      }

      signature = signResult.signature as `0x${string}`;
      console.log(`✅ Received signature from agent server`);
    } catch (error) {
      console.error(`❌ Failed to get signature from agent server: ${error}`);
      // Fallback to local signing if server is unavailable
      console.log(`⚠️ Falling back to local signing with provided private key`);
      const account = privateKeyToAccount(agentOwnerPrivateKey);
      signature = await account.sign({ hash: eip191Hash });
    }
  } else {
    // No agent server URL configured, use local signing
    const account = privateKeyToAccount(agentOwnerPrivateKey);
    signature = await account.sign({ hash: eip191Hash });
  }

  // Encode: [struct bytes][signature (65 bytes: r=32, s=32, v=1)]
  const feedbackAuth = (feedbackAuthStruct + signature.slice(2)) as `0x${string}`;

  return feedbackAuth;
}

/**
 * Generate feedbackAuth for a client and store it
 */
export async function generateClientFeedbackAuth(
  agentId: string,
  clientAddress: Address,
  network: string,
  feedbackAuthStore: KeyValueStore<{ agentId: string; feedbackAuth: string }>,
  agentUrl?: string,
): Promise<GenerateFeedbackAuthResult> {
  const chain = mapX402NetworkToChain(network, RPC_URL);
  if (!chain) {
    return {
      success: false,
      error: `Unsupported network: ${network}`,
    };
  }

  try {
    const publicClient = createPublicClient({ chain, transport: http(RPC_URL) });

    // Get the actual chain ID from the blockchain
    const actualChainId = await publicClient.getChainId();

    // Check if agent exists and get owner
    try {
      const agentIdBigInt = BigInt(agentId);
      const owner = await publicClient.readContract({
        address: ERC8004_IDENTITY_REGISTRY_ADDRESS,
        abi: identityRegistryAbi,
        functionName: "ownerOf",
        args: [agentIdBigInt],
      });
      // Agent exists - generate feedbackAuth
      console.log(
        `ERC-8004: Agent ${agentId} exists and belongs to ${owner}, generating feedbackAuth`,
      );

      const feedbackAuth = await generateFeedbackAuth(
        agentId,
        clientAddress,
        owner,
        FACILITATOR_PRIVATE_KEY as `0x${string}`,
        actualChainId,
        undefined, // expiry
        undefined, // indexLimit
        agentUrl, // agentUrl
      );

      // Store feedbackAuth and agentId with 1 hour TTL (matches feedbackAuth expiry)
      await feedbackAuthStore.set(
        clientAddress.toLowerCase(),
        {
          agentId,
          feedbackAuth,
        },
        3600, // 1 hour TTL
      );

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
}
