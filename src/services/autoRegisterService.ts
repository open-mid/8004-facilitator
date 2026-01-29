/**
 * Auto-Register Service - Automatically generate tokenURI from Bazaar discovery info
 *
 * When an agent registers without providing tokenURI/metadata:
 * 1. Fetch discovery info from Bazaar
 * 2. Generate ERC-8004 registration metadata
 * 3. Upload to IPFS
 * 4. Return the IPFS URL as tokenURI
 */

import { fetchBazaarInfo, fetchBazaarInfoByUrl, type BazaarEndpoint } from "./bazaarService";
import { uploadToIPFS } from "./ipfsService";
import {
  generateERC8004Metadata,
  generateMinimalERC8004Metadata,
  type ERC8004Metadata,
} from "./metadataService";
import { PINATA_JWT, BAZAAR_URL, ERC8004_IDENTITY_REGISTRY_ADDRESS } from "../config/env";

export interface AutoRegisterOptions {
  payToAddress: string;
  endpointUrl?: string;
  name?: string;
  description?: string;
  imageUrl?: string;
}

export interface AutoRegisterResult {
  success: boolean;
  tokenURI?: string;
  metadata?: ERC8004Metadata;
  source?: "bazaar" | "minimal";
  error?: string;
}

/**
 * Auto-generate tokenURI for ERC-8004 registration
 *
 * Attempts to:
 * 1. Fetch info from Bazaar using payTo address or endpoint URL
 * 2. Generate ERC-8004 metadata from Bazaar info (or minimal fallback)
 * 3. Upload metadata to IPFS
 * 4. Return the IPFS URI
 */
export async function autoGenerateTokenURI(
  options: AutoRegisterOptions,
): Promise<AutoRegisterResult> {
  const { payToAddress, endpointUrl, name, description, imageUrl } = options;

  console.log(`🤖 [autoRegister] Auto-generating tokenURI for ${payToAddress}`);
  if (endpointUrl) {
    console.log(`   Endpoint URL hint: ${endpointUrl}`);
  }

  // Check if IPFS upload is configured
  if (!PINATA_JWT) {
    console.log(`⚠️ [autoRegister] PINATA_JWT not configured, skipping auto-register`);
    return {
      success: false,
      error: "IPFS upload not configured (missing PINATA_JWT)",
    };
  }

  // Step 1: Try to fetch info from Bazaar
  let bazaarEndpoint: BazaarEndpoint | null = null;
  let source: "bazaar" | "minimal" = "minimal";

  // First try by endpoint URL if provided
  if (endpointUrl && BAZAAR_URL) {
    bazaarEndpoint = await fetchBazaarInfoByUrl(endpointUrl, BAZAAR_URL);
  }

  // Fall back to payTo address lookup
  if (!bazaarEndpoint && BAZAAR_URL) {
    bazaarEndpoint = await fetchBazaarInfo(payToAddress, BAZAAR_URL);
  }

  // Step 2: Generate ERC-8004 metadata
  let metadata: ERC8004Metadata;
  const registryChainAddress = `eip155:11155111:${ERC8004_IDENTITY_REGISTRY_ADDRESS}`;

  if (bazaarEndpoint) {
    console.log(
      `✅ [autoRegister] Found Bazaar info for: ${bazaarEndpoint.name || bazaarEndpoint.url}`,
    );
    metadata = generateERC8004Metadata(bazaarEndpoint, {
      registryChainAddress,
      imageUrl: imageUrl || undefined,
    });
    source = "bazaar";
  } else {
    console.log(`⚠️ [autoRegister] No Bazaar info found, generating minimal metadata`);
    metadata = generateMinimalERC8004Metadata(endpointUrl || "", payToAddress, {
      registryChainAddress,
      name,
      description,
      imageUrl,
    });
    source = "minimal";
  }

  console.log(`📋 [autoRegister] Generated metadata:`);
  console.log(`   Name: ${metadata.name}`);
  console.log(`   Description: ${metadata.description.slice(0, 100)}...`);
  console.log(`   Services: ${metadata.services.length}`);
  console.log(`   Source: ${source}`);

  // Step 3: Upload to IPFS
  const pinName = `erc8004-${metadata.name.replace(/[^a-zA-Z0-9]/g, "-").toLowerCase()}-${Date.now()}`;
  const tokenURI = await uploadToIPFS(metadata, PINATA_JWT, pinName);

  if (!tokenURI) {
    return {
      success: false,
      error: "Failed to upload metadata to IPFS",
    };
  }

  console.log(`✅ [autoRegister] Auto-generated tokenURI: ${tokenURI}`);

  return {
    success: true,
    tokenURI,
    metadata,
    source,
  };
}
