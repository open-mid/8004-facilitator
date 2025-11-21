import { parseAbi } from "viem";

export const identityRegistryAbi = parseAbi([
  "function register() returns (uint256 agentId)",
  "function register(string calldata tokenURI_) returns (uint256 agentId)",
  "function register(string calldata tokenURI_, MetadataEntry[] calldata metadata) returns (uint256 agentId)",
  "function balanceOf(address owner) view returns (uint256 balance)",
  "function ownerOf(uint256 tokenId) view returns (address owner)",
  "event Registered(uint256 indexed agentId, string tokenURI, address indexed owner)",
  "struct MetadataEntry { string key; bytes value; }",
]);

export const delegateContractAbi = parseAbi([
  "function register(address registry) returns (uint256 agentId)",
  "function register(address registry, string calldata tokenURI) returns (uint256 agentId)",
  "function register(address registry, string calldata tokenURI, MetadataEntry[] calldata metadata) returns (uint256 agentId)",
  "struct MetadataEntry { string key; bytes value; }",
  "function giveFeedback(address registry, uint256 agentId, uint8 score, bytes32 tag1, bytes32 tag2, string calldata fileuri, bytes32 filehash, bytes memory feedbackAuth)",
]);
