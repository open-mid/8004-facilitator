/**
 * Metadata Service - Generate ERC-8004 registration metadata from Bazaar discovery info
 */

import type { BazaarEndpoint } from "./bazaarService";

/**
 * ERC-8004 Registration Metadata format
 * @see https://eips.ethereum.org/EIPS/eip-8004#registration-v1
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

// Default ERC-8004 registry address on Ethereum Sepolia
const DEFAULT_REGISTRY_CHAIN_ADDRESS = "eip155:11155111:0x8004A818BFB912233c491871b3d84c89A494BD9e";

/**
 * Generate ERC-8004 metadata from Bazaar endpoint info
 */
export function generateERC8004Metadata(
  bazaarEndpoint: BazaarEndpoint,
  options: {
    registryChainAddress?: string;
    imageUrl?: string;
  } = {},
): ERC8004Metadata {
  const { registryChainAddress = DEFAULT_REGISTRY_CHAIN_ADDRESS, imageUrl } = options;

  // Extract primary endpoint URL
  const primaryUrl = bazaarEndpoint.url || bazaarEndpoint.allUrls?.[0]?.url;

  // Generate name from provider or domain
  let name = bazaarEndpoint.name || bazaarEndpoint.provider;
  if (!name && primaryUrl) {
    try {
      const url = new URL(primaryUrl);
      name = url.hostname.replace(/^www\./, "");
    } catch {
      name = "Unknown Agent";
    }
  }

  // Generate description
  let description = bazaarEndpoint.description;
  if (!description) {
    description = `x402-enabled API agent${bazaarEndpoint.tags?.length ? ` providing ${bazaarEndpoint.tags.join(", ")} services` : ""}`;
  }

  // Build services array from all URLs
  const services: ERC8004Metadata["services"] = [];

  if (bazaarEndpoint.allUrls && bazaarEndpoint.allUrls.length > 0) {
    for (const urlInfo of bazaarEndpoint.allUrls) {
      services.push({
        name: "x402",
        endpoint: urlInfo.url,
        version: "2.0.0",
        description: urlInfo.description || undefined,
      });
    }
  } else if (primaryUrl) {
    services.push({
      name: "x402",
      endpoint: primaryUrl,
      version: "2.0.0",
    });
  }

  // Build metadata object
  const metadata: ERC8004Metadata = {
    type: "https://eips.ethereum.org/EIPS/eip-8004#registration-v1",
    name,
    description,
    x402Support: true,
    active: bazaarEndpoint.status !== "inactive" && bazaarEndpoint.healthStatus !== "down",
    services,
    supportedTrust: ["reputation"],
    registrations: [
      {
        agentRegistry: registryChainAddress,
      },
    ],
  };

  // Add image if provided or derive from domain
  if (imageUrl) {
    metadata.image = imageUrl;
  } else if (primaryUrl) {
    try {
      const url = new URL(primaryUrl);
      // Use common favicon/logo locations
      metadata.image = `${url.origin}/logo.png`;
    } catch {
      // Skip image if URL parsing fails
    }
  }

  return metadata;
}

/**
 * Generate minimal ERC-8004 metadata when no Bazaar info is available
 * Uses the provided endpoint URL and payTo address
 */
export function generateMinimalERC8004Metadata(
  endpointUrl: string,
  payToAddress: string,
  options: {
    registryChainAddress?: string;
    name?: string;
    description?: string;
    imageUrl?: string;
  } = {},
): ERC8004Metadata {
  const {
    registryChainAddress = DEFAULT_REGISTRY_CHAIN_ADDRESS,
    name,
    description,
    imageUrl,
  } = options;

  let agentName = name;
  let agentDescription = description;

  if (!agentName && endpointUrl) {
    try {
      const url = new URL(endpointUrl);
      agentName = url.hostname.replace(/^www\./, "");
    } catch {
      agentName = `Agent ${payToAddress.slice(0, 8)}...${payToAddress.slice(-6)}`;
    }
  }

  if (!agentDescription) {
    agentDescription = `x402-enabled API agent at ${endpointUrl || payToAddress}`;
  }

  const metadata: ERC8004Metadata = {
    type: "https://eips.ethereum.org/EIPS/eip-8004#registration-v1",
    name: agentName || "Unknown Agent",
    description: agentDescription,
    x402Support: true,
    active: true,
    services: endpointUrl
      ? [
          {
            name: "x402",
            endpoint: endpointUrl,
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

  if (imageUrl) {
    metadata.image = imageUrl;
  } else if (endpointUrl) {
    try {
      const url = new URL(endpointUrl);
      metadata.image = `${url.origin}/logo.png`;
    } catch {
      // Skip image
    }
  }

  return metadata;
}
