/**
 * IPFS Service - Upload metadata to IPFS via Pinata
 */

const PINATA_API_URL = "https://api.pinata.cloud/pinning/pinJSONToIPFS";

export interface PinataResponse {
  IpfsHash: string;
  PinSize: number;
  Timestamp: string;
}

/**
 * Upload JSON metadata to IPFS via Pinata
 * Returns the IPFS URI (ipfs://CID)
 */
export async function uploadToIPFS(
  metadata: object,
  pinataJwt: string,
  name?: string
): Promise<string | null> {
  if (!pinataJwt) {
    console.error("❌ [ipfsService] PINATA_JWT not configured");
    return null;
  }

  try {
    console.log(`📤 [ipfsService] Uploading metadata to IPFS...`);

    const response = await fetch(PINATA_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${pinataJwt}`,
      },
      body: JSON.stringify({
        pinataContent: metadata,
        pinataMetadata: {
          name: name || `erc8004-agent-${Date.now()}`,
        },
      }),
      signal: AbortSignal.timeout(30000),
    });

    if (!response.ok) {
      const error = await response.text();
      console.error(`❌ [ipfsService] Pinata API error: ${response.status} - ${error}`);
      return null;
    }

    const result = (await response.json()) as PinataResponse;

    const ipfsUri = `ipfs://${result.IpfsHash}`;
    console.log(`✅ [ipfsService] Uploaded to IPFS: ${ipfsUri}`);
    console.log(`   Gateway URL: https://gateway.pinata.cloud/ipfs/${result.IpfsHash}`);

    return ipfsUri;
  } catch (error) {
    console.error(`❌ [ipfsService] Failed to upload to IPFS:`, error);
    return null;
  }
}
