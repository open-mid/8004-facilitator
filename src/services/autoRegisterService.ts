/**
 * Auto-Register Service - Generate ERC-8004 metadata from x402 discovery extension
 *
 * When an agent registers without providing tokenURI:
 * 1. Extract discovery metadata from extensions.bazaar (from x402 route config)
 * 2. Generate ERC-8004 registration metadata
 * 3. Upload to IPFS
 * 4. Return the IPFS URL as tokenURI
 */

import { uploadToIPFS } from "./ipfsService";
import { PINATA_JWT, ERC8004_IDENTITY_REGISTRY_ADDRESS } from "../config/env";

/**
 * Bazaar discovery extension data (from declareDiscoveryExtension)
 */
export interface BazaarDiscoveryExtension {
  input?: Record<string, unknown>;
  inputSchema?: {
    properties?: Record<string, { type: string; description?: string }>;
    required?: string[];
  };
  output?: {
    example?: Record<string, unknown>;
    schema?: {
      type?: string;
      properties?: Record<string, { type: string; description?: string }>;
      required?: string[];
    };
  };
  bodyType?: "json" | "form";
}

/**
 * ERC-8004 Registration Metadata format
 */
export interface ERC8004Metadata {
  type: "https://eips.ethereum.org/EIPS/eip-8004#registration-v1";
  name: string;
  description: string;
  image?: string;
  x402Support: boolean;
  active: boolean;
  services: Array<{
    name: string;
    endpoint: string;
    version?: string;
    description?: string;
  }>;
  supportedTrust: string[];
  registrations: Array<{
    agentRegistry: string;
  }>;
}

export interface AutoRegisterOptions {
  payToAddress: string;
  resource?: string; // The endpoint URL from payment requirements
  bazaarExtension?: BazaarDiscoveryExtension;
  // Fallback fields if no bazaar extension
  name?: string;
  description?: string;
  imageUrl?: string;
}

export interface AutoRegisterResult {
  success: boolean;
  tokenURI?: string;
  metadata?: ERC8004Metadata;
  source?: "bazaar-extension" | "minimal";
  error?: string;
}

/**
 * Generate ERC-8004 metadata from bazaar discovery extension
 */
function generateMetadataFromBazaar(
  resource: string,
  bazaar: BazaarDiscoveryExtension,
  payToAddress: string,
  registryChainAddress: string
): ERC8004Metadata {
  // Extract name from resource URL
  let name = "x402 Agent";
  try {
    const url = new URL(resource);
    name = url.hostname.replace(/^www\./, "");
  } catch {
    // Use default name
  }

  // Build description from input/output schemas
  let description = `x402-enabled API endpoint at ${resource}`;
  
  if (bazaar.output?.schema?.properties) {
    const outputFields = Object.keys(bazaar.output.schema.properties).join(", ");
    description += `. Returns: ${outputFields}`;
  }
  
  if (bazaar.inputSchema?.properties) {
    const inputFields = Object.keys(bazaar.inputSchema.properties).join(", ");
    description += `. Accepts: ${inputFields}`;
  }

  // Build service entry
  const service: ERC8004Metadata["services"][0] = {
    name: "x402",
    endpoint: resource,
    version: "2.0.0",
  };

  if (bazaar.output?.schema) {
    service.description = `Output schema: ${JSON.stringify(bazaar.output.schema.properties || {})}`;
  }

  const metadata: ERC8004Metadata = {
    type: "https://eips.ethereum.org/EIPS/eip-8004#registration-v1",
    name,
    description,
    x402Support: true,
    active: true,
    services: [service],
    supportedTrust: ["reputation"],
    registrations: [
      {
        agentRegistry: registryChainAddress,
      },
    ],
  };

  // Add image from domain
  try {
    const url = new URL(resource);
    metadata.image = `${url.origin}/logo.png`;
  } catch {
    // Skip image
  }

  return metadata;
}

/**
 * Generate minimal ERC-8004 metadata when no bazaar extension is available
 */
function generateMinimalMetadata(
  resource: string,
  payToAddress: string,
  registryChainAddress: string,
  options: { name?: string; description?: string; imageUrl?: string } = {}
): ERC8004Metadata {
  let name = options.name;
  if (!name && resource) {
    try {
      const url = new URL(resource);
      name = url.hostname.replace(/^www\./, "");
    } catch {
      name = `Agent ${payToAddress.slice(0, 8)}...${payToAddress.slice(-6)}`;
    }
  }

  const description = options.description || `x402-enabled API agent at ${resource || payToAddress}`;

  const metadata: ERC8004Metadata = {
    type: "https://eips.ethereum.org/EIPS/eip-8004#registration-v1",
    name: name || "Unknown Agent",
    description,
    x402Support: true,
    active: true,
    services: resource
      ? [
          {
            name: "x402",
            endpoint: resource,
            version: "2.0.0",
          },
        ]
      : [],
    supportedTrust: ["reputation"],
    registrations: [
      {
        agentRegistry: registryChainAddress,
      },
    ],
  };

  if (options.imageUrl) {
    metadata.image = options.imageUrl;
  } else if (resource) {
    try {
      const url = new URL(resource);
      metadata.image = `${url.origin}/logo.png`;
    } catch {
      // Skip image
    }
  }

  return metadata;
}

/**
 * Auto-generate tokenURI for ERC-8004 registration
 *
 * Uses discovery metadata from x402 bazaar extension if available,
 * otherwise falls back to minimal metadata.
 */
export async function autoGenerateTokenURI(
  options: AutoRegisterOptions
): Promise<AutoRegisterResult> {
  const { payToAddress, resource, bazaarExtension, name, description, imageUrl } = options;

  console.log(`🤖 [autoRegister] Auto-generating tokenURI for ${payToAddress}`);
  if (resource) {
    console.log(`   Resource: ${resource}`);
  }
  console.log(`   Has bazaar extension: ${!!bazaarExtension}`);

  // Check if IPFS upload is configured
  if (!PINATA_JWT) {
    console.log(`⚠️ [autoRegister] PINATA_JWT not configured, skipping auto-register`);
    return {
      success: false,
      error: "IPFS upload not configured (missing PINATA_JWT)",
    };
  }

  // Generate metadata
  let metadata: ERC8004Metadata;
  let source: "bazaar-extension" | "minimal";
  const registryChainAddress = `eip155:11155111:${ERC8004_IDENTITY_REGISTRY_ADDRESS}`;

  if (bazaarExtension && resource) {
    console.log(`✅ [autoRegister] Using bazaar extension metadata`);
    metadata = generateMetadataFromBazaar(resource, bazaarExtension, payToAddress, registryChainAddress);
    source = "bazaar-extension";
  } else {
    console.log(`⚠️ [autoRegister] No bazaar extension, generating minimal metadata`);
    metadata = generateMinimalMetadata(resource || "", payToAddress, registryChainAddress, {
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

  // Upload to IPFS
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
