import {
  createPublicClient,
  createWalletClient,
  http,
  type Address,
  zeroHash,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  RPC_URL,
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
  totalScore: bigint;
  averageScore: number;
};

/**
 * Submit feedback for an agent to the Reputation Registry
 * v1: No feedbackAuth required - direct submission
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

  const chain = mapX402NetworkToChain(network, RPC_URL);
  if (!chain) {
    return { success: false, error: `Unsupported network: ${network}` };
  }

  // Validate score
  if (score < 0 || score > 100) {
    return { success: false, error: "Score must be between 0 and 100" };
  }

  try {
    const account = privateKeyToAccount(FACILITATOR_PRIVATE_KEY as `0x${string}`);
    const walletClient = createWalletClient({ account, chain, transport: http(RPC_URL) });
    const publicClient = createPublicClient({ chain, transport: http(RPC_URL) });

    console.log(`📝 Submitting feedback for agent ${agentId}: score=${score}, tag1=${tag1}, tag2=${tag2}`);

    const hash = await walletClient.writeContract({
      address: ERC8004_REPUTATION_REGISTRY_ADDRESS,
      abi: reputationRegistryAbi,
      functionName: "giveFeedback",
      args: [BigInt(agentId), score, tag1, tag2, endpoint, feedbackURI, feedbackHash],
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
 */
export async function getReputationSummary(
  agentId: string,
  network: string,
): Promise<ReputationSummary | null> {
  const chain = mapX402NetworkToChain(network, RPC_URL);
  if (!chain) {
    console.error(`Unsupported network: ${network}`);
    return null;
  }

  const publicClient = createPublicClient({ chain, transport: http(RPC_URL) });

  try {
    const result = (await publicClient.readContract({
      address: ERC8004_REPUTATION_REGISTRY_ADDRESS,
      abi: reputationRegistryAbi,
      functionName: "getSummary",
      args: [BigInt(agentId)],
    })) as [bigint, bigint];

    const [count, totalScore] = result;
    return {
      count,
      totalScore,
      averageScore: count > 0n ? Number(totalScore) / Number(count) : 0,
    };
  } catch (e: any) {
    console.error("Failed to get reputation summary:", e?.message || e);
    return null;
  }
}

/**
 * Get feedback count for an agent from a specific client
 */
export async function getFeedbackCount(
  agentId: string,
  clientAddress: Address,
  network: string,
): Promise<number | null> {
  const chain = mapX402NetworkToChain(network, RPC_URL);
  if (!chain) return null;

  const publicClient = createPublicClient({ chain, transport: http(RPC_URL) });

  try {
    const count = (await publicClient.readContract({
      address: ERC8004_REPUTATION_REGISTRY_ADDRESS,
      abi: reputationRegistryAbi,
      functionName: "getFeedbackCount",
      args: [BigInt(agentId), clientAddress],
    })) as bigint;

    return Number(count);
  } catch (e: any) {
    console.error("Failed to get feedback count:", e?.message || e);
    return null;
  }
}

/**
 * Get all clients who have given feedback to an agent
 */
export async function getClients(agentId: string, network: string): Promise<Address[] | null> {
  const chain = mapX402NetworkToChain(network, RPC_URL);
  if (!chain) return null;

  const publicClient = createPublicClient({ chain, transport: http(RPC_URL) });

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
