import {
  createPublicClient,
  createWalletClient,
  http,
  decodeEventLog,
  encodeFunctionData,
  type Address,
  type Authorization,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  RPC_URL,
  ERC8004_IDENTITY_REGISTRY_ADDRESS,
  DELEGATE_CONTRACT_ADDRESS,
  FACILITATOR_PRIVATE_KEY,
} from "../config/env";
import { identityRegistryAbi, delegateContractAbi } from "../config/contracts";
import { mapX402NetworkToChain } from "../utils/network";

export type RegisterInfo = {
  agentAddress: Address;
  authorization: Authorization;
  tokenURI?: string;
  metadata?: { key: string; value: string }[];
  network?: string;
};

export type RegisterResult = {
  success: boolean;
  network?: string;
  agentId?: string;
  agentOwner?: string;
  txHash?: string;
  error?: string;
};

export async function registerAgent(info: RegisterInfo): Promise<RegisterResult> {
  const { tokenURI, metadata, agentAddress, authorization } = info;
  const network = "eip155:84532"; // force registration to base sepolia

  if (!network) {
    console.log("Registration failed: missing network");
    return {
      success: false,
      error: "Missing required field: network",
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
    const delegateAddress = DELEGATE_CONTRACT_ADDRESS;
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
}
