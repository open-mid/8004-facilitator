import { config } from "dotenv";

config();

// Normalize private keys - add 0x prefix if missing
function normalizePrivateKey(key: string | undefined): string | undefined {
  if (!key) return undefined;
  return key.startsWith("0x") ? key : `0x${key}`;
}

export const RPC_URL = process.env.RPC_URL as string;
export const ERC8004_IDENTITY_REGISTRY_ADDRESS = process.env
  .ERC8004_IDENTITY_REGISTRY_ADDRESS as `0x${string}`;
export const DELEGATE_CONTRACT_ADDRESS = process.env.DELEGATE_CONTRACT_ADDRESS as `0x${string}`;
export const PORT = process.env.PORT || "4022";

export const FACILITATOR_PRIVATE_KEY = normalizePrivateKey(process.env.FACILITATOR_PRIVATE_KEY);

if (!FACILITATOR_PRIVATE_KEY) {
  console.error("❌ FACILITATOR_PRIVATE_KEY environment variable is required");
  process.exit(1);
}

if (!RPC_URL) {
  console.error("❌ RPC_URL environment variable is required");
  process.exit(1);
}

if (!ERC8004_IDENTITY_REGISTRY_ADDRESS) {
  console.error("❌ ERC8004_IDENTITY_REGISTRY_ADDRESS environment variable is required");
  process.exit(1);
}

if (!DELEGATE_CONTRACT_ADDRESS) {
  console.error("❌ DELEGATE_CONTRACT_ADDRESS environment variable is required");
  process.exit(1);
}
