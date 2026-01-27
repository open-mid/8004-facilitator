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
  ETH_SEPOLIA_RPC_URL,
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
  const network = "eip155:11155111"; // force registration to Ethereum Sepolia

  if (!network) {
    console.log("Registration failed: missing network");
    return {
      success: false,
      error: "Missing required field: network",
    };
  }

  const chain = mapX402NetworkToChain(network, ETH_SEPOLIA_RPC_URL);
  if (!chain) {
    console.log("Registration failed: unsupported network:", network);
    return {
      success: false,
      error: `Unsupported network: ${network}`,
      network,
    };
  }

  try {
    const publicClient = createPublicClient({ chain, transport: http(ETH_SEPOLIA_RPC_URL) });

    const account = privateKeyToAccount(FACILITATOR_PRIVATE_KEY as `0x${string}`);
    const walletClient = createWalletClient({ account, chain, transport: http(ETH_SEPOLIA_RPC_URL) });

    // Prepare metadata entries if provided
    // Note: New contract uses metadataKey/metadataValue instead of key/value
    let metadataEntries: Array<{ metadataKey: string; metadataValue: `0x${string}` }> | undefined;
    if (metadata && metadata.length > 0) {
      metadataEntries = metadata.map((entry: { key: string; value: string }) => ({
        metadataKey: entry.key,
        metadataValue: entry.value.startsWith("0x")
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
    console.log(`   - ChainId: ${authorization.chainId} (type: ${typeof authorization.chainId})`);
    console.log(`   - Nonce: ${authorization.nonce} (type: ${typeof authorization.nonce})`);
    console.log(`   - yParity: ${(authorization as any).yParity} (type: ${typeof (authorization as any).yParity})`);
    console.log(`   - r: ${(authorization as any).r?.slice(0, 20)}...`);
    console.log(`   - s: ${(authorization as any).s?.slice(0, 20)}...`);
    console.log(`   - Agent Address: ${agentAddress}`);

    // Fetch current nonce from chain to compare
    const onChainNonce = await publicClient.getTransactionCount({ address: agentAddress });
    console.log(`   - On-chain nonce for agent: ${onChainNonce}`);
    if (onChainNonce !== authorization.nonce) {
      console.warn(`⚠️ Nonce mismatch! Auth nonce: ${authorization.nonce}, On-chain: ${onChainNonce}`);
    }

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
    console.log(`📋 [registerAgent] Transaction receipt has ${receipt.logs.length} logs`);

    // Log all events for debugging
    for (let i = 0; i < receipt.logs.length; i++) {
      const log = receipt.logs[i];
      console.log(`   Log ${i}: address=${log.address}, topics[0]=${log.topics[0]?.slice(0, 18)}...`);
    }

    const registeredEvent = receipt.logs.find(log => {
      try {
        const decoded = decodeEventLog({
          abi: identityRegistryAbi,
          data: log.data,
          topics: log.topics,
        });
        console.log(`   Found event: ${decoded.eventName}`);
        return decoded.eventName === "Registered";
      } catch (err) {
        // Only log if this looks like it might be the Registered event (from IdentityRegistry)
        if (log.address.toLowerCase() === ERC8004_IDENTITY_REGISTRY_ADDRESS.toLowerCase()) {
          console.log(`   Failed to decode log from IdentityRegistry: ${err}`);
        }
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
          console.log("✅ Registered event decoded:", decoded);
          console.log("   args:", JSON.stringify(decoded.args, (_, v) => typeof v === 'bigint' ? v.toString() : v));
          agentId = (decoded.args as any).agentId?.toString();
        }
      } catch (err) {
        console.log("❌ ERC-8004: Failed to decode Registered event", err);
      }
    } else {
      console.log("⚠️ No Registered event found in transaction logs");

      // Fallback: Try to extract from ERC-721 Transfer event (mint = Transfer from 0x0)
      const transferEvent = receipt.logs.find(log => {
        try {
          const decoded = decodeEventLog({
            abi: identityRegistryAbi,
            data: log.data,
            topics: log.topics,
          });
          // Look for Transfer from zero address (mint)
          return decoded.eventName === "Transfer" && (decoded.args as any).from === "0x0000000000000000000000000000000000000000";
        } catch {
          return false;
        }
      });

      if (transferEvent) {
        try {
          const decoded = decodeEventLog({
            abi: identityRegistryAbi,
            data: transferEvent.data,
            topics: transferEvent.topics,
          });
          if (decoded.eventName === "Transfer") {
            console.log("✅ Found Transfer (mint) event:", decoded);
            agentId = (decoded.args as any).tokenId?.toString();
            console.log(`   Extracted agentId from Transfer event: ${agentId}`);
          }
        } catch (err) {
          console.log("❌ Failed to decode Transfer event:", err);
        }
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
