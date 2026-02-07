import { config } from "dotenv";

config();

// Normalize private keys - add 0x prefix if missing
function normalizePrivateKey(key: string | undefined): string | undefined {
  if (!key) return undefined;
  return key.startsWith("0x") ? key : `0x${key}`;
}

// Base network RPC (for x402 payment facilitation)
export const RPC_URL = process.env.RPC_URL as string;

function normalizeErc8004Network(network: string): string {
  // Prefer CAIP-2.
  if (network.startsWith("eip155:")) return network;

  // Back-compat for older env/config naming.
  switch (network) {
    case "eth-mainnet":
    case "ethereum":
    case "mainnet":
      return "eip155:1";
    case "eth-sepolia":
    case "sepolia":
      return "eip155:11155111";
    case "base":
    case "base-mainnet":
      return "eip155:8453";
    case "base-sepolia":
      return "eip155:84532";
    default:
      return network;
  }
}

function getChainIdFromNetwork(network: string): number | undefined {
  if (!network.startsWith("eip155:")) return undefined;
  const chainId = Number(network.split(":")[1]);
  return Number.isFinite(chainId) ? chainId : undefined;
}

function getDefaultErc8004Addresses(network: string): {
  identityRegistry: `0x${string}`;
  reputationRegistry: `0x${string}`;
} {
  // Source of truth: https://github.com/erc-8004/erc-8004-contracts
  const chainId = getChainIdFromNetwork(network);

  // Sepolia deployments (Ethereum Sepolia + Base Sepolia) share the same vanity addresses.
  if (chainId === 11155111 || chainId === 84532) {
    return {
      identityRegistry: "0x8004A818BFB912233c491871b3d84c89A494BD9e",
      reputationRegistry: "0x8004B663056A597Dffe9eCcC1965A193B7388713",
    };
  }

  // Mainnet deployments (Ethereum Mainnet + Base Mainnet) share the same vanity addresses.
  if (chainId === 1 || chainId === 8453) {
    return {
      identityRegistry: "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432",
      reputationRegistry: "0x8004BAa17C55a88189AE136b182e5fdA19dE9b63",
    };
  }

  // Fallback to Sepolia addresses so existing local dev doesn't break.
  return {
    identityRegistry: "0x8004A818BFB912233c491871b3d84c89A494BD9e",
    reputationRegistry: "0x8004B663056A597Dffe9eCcC1965A193B7388713",
  };
}

// ERC-8004 registry network + RPC (defaults to Ethereum Sepolia)
// - Use CAIP-2 format: e.g. eip155:8453 (Base Mainnet)
// - Back-compat: ETH_SEPOLIA_RPC_URL is still honored if ERC8004_RPC_URL is not set
export const ERC8004_NETWORK = normalizeErc8004Network(
  process.env.ERC8004_NETWORK || process.env.ERC8004_REGISTRY_NETWORK || "eip155:11155111",
);

export const ERC8004_RPC_URL =
  process.env.ERC8004_RPC_URL ||
  process.env.ERC8004_REGISTRY_RPC_URL ||
  process.env.ETH_SEPOLIA_RPC_URL ||
  "https://ethereum-sepolia-rpc.publicnode.com";

// Back-compat export (older code paths / docs)
export const ETH_SEPOLIA_RPC_URL = process.env.ETH_SEPOLIA_RPC_URL || ERC8004_RPC_URL;

const default8004 = getDefaultErc8004Addresses(ERC8004_NETWORK);

// ERC-8004 Contract Addresses
export const ERC8004_IDENTITY_REGISTRY_ADDRESS = (process.env.ERC8004_IDENTITY_REGISTRY_ADDRESS ||
  default8004.identityRegistry) as `0x${string}`;
export const ERC8004_REPUTATION_REGISTRY_ADDRESS = (process.env.ERC8004_REPUTATION_REGISTRY_ADDRESS ||
  default8004.reputationRegistry) as `0x${string}`;
export const DELEGATE_CONTRACT_ADDRESS = process.env.DELEGATE_CONTRACT_ADDRESS as `0x${string}`;
export const PORT = process.env.PORT || "4022";
export const REDIS_URL = process.env.REDIS_URL;

export const FACILITATOR_PRIVATE_KEY = normalizePrivateKey(process.env.FACILITATOR_PRIVATE_KEY);

if (!FACILITATOR_PRIVATE_KEY) {
  console.error("❌ FACILITATOR_PRIVATE_KEY environment variable is required");
  process.exit(1);
}

if (!RPC_URL) {
  console.error("❌ RPC_URL environment variable is required");
  process.exit(1);
}

if (!DELEGATE_CONTRACT_ADDRESS) {
  console.error("❌ DELEGATE_CONTRACT_ADDRESS environment variable is required");
  process.exit(1);
}

console.log("📋 ERC-8004 Configuration:");
console.log(`   Network: ${ERC8004_NETWORK}`);
console.log(`   Identity Registry: ${ERC8004_IDENTITY_REGISTRY_ADDRESS}`);
console.log(`   Reputation Registry: ${ERC8004_REPUTATION_REGISTRY_ADDRESS}`);
console.log(`   Delegate Contract: ${DELEGATE_CONTRACT_ADDRESS}`);
console.log(`   RPC URL: ${ERC8004_RPC_URL}`);
