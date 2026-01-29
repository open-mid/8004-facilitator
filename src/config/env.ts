import { config } from "dotenv";

config();

// Normalize private keys - add 0x prefix if missing
function normalizePrivateKey(key: string | undefined): string | undefined {
  if (!key) return undefined;
  return key.startsWith("0x") ? key : `0x${key}`;
}

// Base network RPC (for x402 payment facilitation)
export const RPC_URL = process.env.RPC_URL as string;

// Ethereum Sepolia RPC (for ERC-8004 registry operations)
export const ETH_SEPOLIA_RPC_URL =
  process.env.ETH_SEPOLIA_RPC_URL || "https://ethereum-sepolia-rpc.publicnode.com";

// ERC-8004 Contract Addresses (Ethereum Sepolia)
// Identity Registry: 0x8004A818BFB912233c491871b3d84c89A494BD9e
// Reputation Registry: 0x8004B663056A597Dffe9eCcC1965A193B7388713
export const ERC8004_IDENTITY_REGISTRY_ADDRESS = (process.env.ERC8004_IDENTITY_REGISTRY_ADDRESS ||
  "0x8004A818BFB912233c491871b3d84c89A494BD9e") as `0x${string}`;
export const ERC8004_REPUTATION_REGISTRY_ADDRESS = (process.env
  .ERC8004_REPUTATION_REGISTRY_ADDRESS ||
  "0x8004B663056A597Dffe9eCcC1965A193B7388713") as `0x${string}`;
export const DELEGATE_CONTRACT_ADDRESS = process.env.DELEGATE_CONTRACT_ADDRESS as `0x${string}`;
export const PORT = process.env.PORT || "4022";
export const REDIS_URL = process.env.REDIS_URL;

export const FACILITATOR_PRIVATE_KEY = normalizePrivateKey(process.env.FACILITATOR_PRIVATE_KEY);

// Auto-register configuration
// PINATA_JWT: JWT token for uploading metadata to IPFS via Pinata
// Get your JWT from: https://app.pinata.cloud/developers/api-keys
export const PINATA_JWT = process.env.PINATA_JWT;

// BAZAAR_URL: Base URL for the Bazaar discovery API
// Used to fetch endpoint info for auto-generating ERC-8004 metadata
export const BAZAAR_URL = process.env.BAZAAR_URL || "https://bazaar.openmid.xyz";

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
console.log(`   Identity Registry: ${ERC8004_IDENTITY_REGISTRY_ADDRESS}`);
console.log(`   Reputation Registry: ${ERC8004_REPUTATION_REGISTRY_ADDRESS}`);
console.log(`   Delegate Contract: ${DELEGATE_CONTRACT_ADDRESS}`);
console.log(`   Ethereum Sepolia RPC: ${ETH_SEPOLIA_RPC_URL}`);
console.log(
  `   Auto-register enabled: ${PINATA_JWT ? "✅ Yes (IPFS via Pinata)" : "❌ No (missing PINATA_JWT)"}`,
);
console.log(`   Bazaar URL: ${BAZAAR_URL}`);
