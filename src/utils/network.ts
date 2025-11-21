import { anvil, base, baseSepolia, type Chain } from "viem/chains";

export function isLocalRPC(rpcUrl?: string): boolean {
  if (!rpcUrl) return false;
  try {
    const url = new URL(rpcUrl);
    return url.hostname === "localhost" || url.hostname === "127.0.0.1";
  } catch {
    return rpcUrl?.includes("localhost") || rpcUrl?.includes("127.0.0.1");
  }
}

export function mapX402NetworkToChain(network?: string, rpcUrl?: string): Chain | undefined {
  // If RPC is local, always use anvil chain (chainId 31337)
  if (isLocalRPC(rpcUrl)) {
    console.log("Detected local RPC, using anvil chain (chainId: 31337)");
    return anvil;
  }

  if (!network) {
    return undefined;
  }

  // Handle CAIP-2 format (eip155:chainId)
  if (network.startsWith("eip155:")) {
    const chainId = parseInt(network.split(":")[1]);

    // Map known chain IDs to viem chains
    switch (chainId) {
      case 84532: // Base Sepolia
        return baseSepolia;
      case 8453: // Base Mainnet
        return base;
      case 31337: // Anvil (local)
        return anvil;
      default:
        // For unknown chain IDs, try to find in viem chains
        // This would require importing all chains, so for now just return undefined
        console.warn(`Unknown chain ID: ${chainId} for network: ${network}`);
        return undefined;
    }
  }

  // Handle simple network names (V1 format)
  switch (network) {
    case "base-sepolia":
      return baseSepolia;
    case "base":
      return base;
    default:
      return undefined;
  }
}

