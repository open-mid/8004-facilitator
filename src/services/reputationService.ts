import {
  createPublicClient,
  createWalletClient,
  http,
  type Address,
  zeroHash,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  ETH_SEPOLIA_RPC_URL,
  ERC8004_REPUTATION_REGISTRY_ADDRESS,
  FACILITATOR_PRIVATE_KEY,
} from "../config/env";
import { reputationRegistryAbi } from "../config/contracts";
import { mapX402NetworkToChain } from "../utils/network";

export type GiveFeedbackParams = {
  agentId: string;
  score: number; // 0-100
  tag1?: string;
  tag2?: string;
  endpoint?: string;
  feedbackURI?: string;
  feedbackHash?: `0x${string}`;
  network: string;
};

export type FeedbackResult = {
  success: boolean;
  txHash?: string;
  error?: string;
};

export type ReputationSummary = {
  count: bigint;
  summaryValue: bigint;
  summaryValueDecimals: number;
  averageScore: number;
};

/**
 * Submit feedback for an agent to the Reputation Registry
 * Uses Ethereum Sepolia - new contract with int128 value and valueDecimals
 */
export async function giveFeedback(params: GiveFeedbackParams): Promise<FeedbackResult> {
  const {
    agentId,
    score,
    tag1 = "",
    tag2 = "",
    endpoint = "",
    feedbackURI = "",
    feedbackHash = zeroHash,
    network,
  } = params;

  // Force Ethereum Sepolia for reputation registry
  const registryNetwork = "eip155:11155111";
  const chain = mapX402NetworkToChain(registryNetwork, ETH_SEPOLIA_RPC_URL);
  if (!chain) {
    return { success: false, error: `Unsupported network: ${registryNetwork}` };
  }

  // Validate score
  if (score < 0 || score > 100) {
    return { success: false, error: "Score must be between 0 and 100" };
  }

  try {
    const account = privateKeyToAccount(FACILITATOR_PRIVATE_KEY as `0x${string}`);
    const walletClient = createWalletClient({ account, chain, transport: http(ETH_SEPOLIA_RPC_URL) });
    const publicClient = createPublicClient({ chain, transport: http(ETH_SEPOLIA_RPC_URL) });

    // Convert score (0-100) to new contract format: int128 value with uint8 valueDecimals
    // score: 85 -> value: 85n, valueDecimals: 0
    const value = BigInt(score);
    const valueDecimals = 0;

    console.log(`📝 Submitting feedback for agent ${agentId}: value=${value}, decimals=${valueDecimals}, tag1=${tag1}, tag2=${tag2}`);

    const hash = await walletClient.writeContract({
      address: ERC8004_REPUTATION_REGISTRY_ADDRESS,
      abi: reputationRegistryAbi,
      functionName: "giveFeedback",
      args: [BigInt(agentId), value, valueDecimals, tag1, tag2, endpoint, feedbackURI, feedbackHash],
    });

    const receipt = await publicClient.waitForTransactionReceipt({ hash });

    if (receipt.status === "success") {
      console.log(`✅ Feedback submitted successfully, tx: ${hash}`);
      return { success: true, txHash: hash };
    } else {
      return { success: false, error: "Transaction reverted", txHash: hash };
    }
  } catch (e: any) {
    console.error("Failed to submit feedback:", e?.message || e);
    return { success: false, error: e?.message || "Failed to submit feedback" };
  }
}

/**
 * Get reputation summary for an agent
 * Uses Ethereum Sepolia - new contract with filtering parameters
 */
export async function getReputationSummary(
  agentId: string,
  network: string,
): Promise<ReputationSummary | null> {
  // Force Ethereum Sepolia for reputation registry
  const registryNetwork = "eip155:11155111";
  const chain = mapX402NetworkToChain(registryNetwork, ETH_SEPOLIA_RPC_URL);
  if (!chain) {
    console.error(`Unsupported network: ${registryNetwork}`);
    return null;
  }

  const publicClient = createPublicClient({ chain, transport: http(ETH_SEPOLIA_RPC_URL) });

  try {
    // New contract signature: getSummary(agentId, clientAddresses[], tag1, tag2)
    // Pass empty arrays/strings to get all feedback
    const result = (await publicClient.readContract({
      address: ERC8004_REPUTATION_REGISTRY_ADDRESS,
      abi: reputationRegistryAbi,
      functionName: "getSummary",
      args: [BigInt(agentId), [], "", ""],
    })) as [bigint, bigint, number];

    const [count, summaryValue, summaryValueDecimals] = result;

    // Calculate average considering decimals
    const divisor = 10 ** summaryValueDecimals;
    const averageScore = count > 0n ? Number(summaryValue) / divisor / Number(count) : 0;

    return {
      count,
      summaryValue,
      summaryValueDecimals,
      averageScore,
    };
  } catch (e: any) {
    console.error("Failed to get reputation summary:", e?.message || e);
    return null;
  }
}

/**
 * Get last feedback index for an agent from a specific client
 * Uses Ethereum Sepolia - new contract uses getLastIndex instead of getFeedbackCount
 */
export async function getLastFeedbackIndex(
  agentId: string,
  clientAddress: Address,
  network: string,
): Promise<number | null> {
  // Force Ethereum Sepolia for reputation registry
  const registryNetwork = "eip155:11155111";
  const chain = mapX402NetworkToChain(registryNetwork, ETH_SEPOLIA_RPC_URL);
  if (!chain) return null;

  const publicClient = createPublicClient({ chain, transport: http(ETH_SEPOLIA_RPC_URL) });

  try {
    const lastIndex = (await publicClient.readContract({
      address: ERC8004_REPUTATION_REGISTRY_ADDRESS,
      abi: reputationRegistryAbi,
      functionName: "getLastIndex",
      args: [BigInt(agentId), clientAddress],
    })) as bigint;

    return Number(lastIndex);
  } catch (e: any) {
    console.error("Failed to get last feedback index:", e?.message || e);
    return null;
  }
}

/**
 * Get all clients who have given feedback to an agent
 * Uses Ethereum Sepolia
 */
export async function getClients(agentId: string, network: string): Promise<Address[] | null> {
  // Force Ethereum Sepolia for reputation registry
  const registryNetwork = "eip155:11155111";
  const chain = mapX402NetworkToChain(registryNetwork, ETH_SEPOLIA_RPC_URL);
  if (!chain) return null;

  const publicClient = createPublicClient({ chain, transport: http(ETH_SEPOLIA_RPC_URL) });

  try {
    const clients = (await publicClient.readContract({
      address: ERC8004_REPUTATION_REGISTRY_ADDRESS,
      abi: reputationRegistryAbi,
      functionName: "getClients",
      args: [BigInt(agentId)],
    })) as Address[];

    return clients;
  } catch (e: any) {
    console.error("Failed to get clients:", e?.message || e);
    return null;
  }
}
