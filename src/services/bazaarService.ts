/**
 * Bazaar Service - Fetches endpoint/agent discovery info from the Bazaar directory API
 */

export interface BazaarEndpoint {
  url: string;
  name: string;
  description: string;
  provider: string;
  tags: string[];
  network: string;
  payTo: string;
  status: string;
  trustScore: number;
  healthStatus: "healthy" | "degraded" | "down" | "unknown";
  avgResponseTimeMs: number | null;
  successRate: number | null;
  evaluationCount: number;
  is8004: boolean;
  allUrls: Array<{
    url: string;
    priceUsdc: string;
    status: string;
    description: string;
    payTo: string;
  }>;
}

export interface BazaarDiscoveryResult {
  endpoints: BazaarEndpoint[];
  totalEndpoints: number;
  totalProviders: number;
}

const DEFAULT_BAZAAR_URL = "https://bazaar.openmid.xyz";

/**
 * Fetch agent/endpoint info from Bazaar by payTo address
 */
export async function fetchBazaarInfo(
  payToAddress: string,
  bazaarUrl: string = DEFAULT_BAZAAR_URL,
): Promise<BazaarEndpoint | null> {
  try {
    const normalizedAddress = payToAddress.toLowerCase();
    console.log(`📡 [bazaarService] Fetching info for payTo: ${normalizedAddress}`);

    // Fetch from Bazaar directory API with high limit to find the endpoint
    const response = await fetch(`${bazaarUrl}/api/directory?limit=1000`, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(15000),
    });

    if (!response.ok) {
      console.error(`❌ [bazaarService] Bazaar API error: ${response.status}`);
      return null;
    }

    const data = (await response.json()) as BazaarDiscoveryResult;

    // Find endpoint matching the payTo address
    const matchingEndpoint = data.endpoints.find(
      ep =>
        ep.payTo.toLowerCase() === normalizedAddress ||
        ep.allUrls?.some(u => u.payTo.toLowerCase() === normalizedAddress),
    );

    if (!matchingEndpoint) {
      console.log(`⚠️ [bazaarService] No endpoint found for payTo: ${normalizedAddress}`);
      return null;
    }

    console.log(
      `✅ [bazaarService] Found endpoint: ${matchingEndpoint.name || matchingEndpoint.url}`,
    );
    return matchingEndpoint;
  } catch (error) {
    console.error(`❌ [bazaarService] Failed to fetch Bazaar info:`, error);
    return null;
  }
}

/**
 * Fetch agent/endpoint info from Bazaar by endpoint URL
 */
export async function fetchBazaarInfoByUrl(
  endpointUrl: string,
  bazaarUrl: string = DEFAULT_BAZAAR_URL,
): Promise<BazaarEndpoint | null> {
  try {
    console.log(`📡 [bazaarService] Fetching info for URL: ${endpointUrl}`);

    // Use search to find the specific endpoint
    const searchParam = encodeURIComponent(new URL(endpointUrl).hostname);
    const response = await fetch(`${bazaarUrl}/api/directory?search=${searchParam}&limit=100`, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(15000),
    });

    if (!response.ok) {
      console.error(`❌ [bazaarService] Bazaar API error: ${response.status}`);
      return null;
    }

    const data = (await response.json()) as BazaarDiscoveryResult;

    // Find exact match or closest match
    const matchingEndpoint = data.endpoints.find(
      ep => ep.url === endpointUrl || ep.allUrls?.some(u => u.url === endpointUrl),
    );

    if (!matchingEndpoint) {
      // Return first result from search if no exact match
      if (data.endpoints.length > 0) {
        console.log(`⚠️ [bazaarService] No exact match, using first search result`);
        return data.endpoints[0];
      }
      console.log(`⚠️ [bazaarService] No endpoint found for URL: ${endpointUrl}`);
      return null;
    }

    console.log(
      `✅ [bazaarService] Found endpoint: ${matchingEndpoint.name || matchingEndpoint.url}`,
    );
    return matchingEndpoint;
  } catch (error) {
    console.error(`❌ [bazaarService] Failed to fetch Bazaar info:`, error);
    return null;
  }
}
