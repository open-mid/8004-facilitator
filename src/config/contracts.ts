import { parseAbi } from "viem";

// ERC-8004 v1 Identity Registry ABI
export const identityRegistryAbi = parseAbi([
  // Registration
  "function register() returns (uint256 agentId)",
  "function register(string calldata tokenURI_) returns (uint256 agentId)",
  "function register(string calldata tokenURI_, MetadataEntry[] calldata metadata) returns (uint256 agentId)",
  // Metadata
  "function getMetadata(uint256 agentId, string calldata key) view returns (bytes)",
  "function setMetadata(uint256 agentId, string calldata key, bytes calldata value)",
  "function setAgentURI(uint256 agentId, string calldata uri)",
  // Agent Wallet
  "function setAgentWallet(uint256 agentId, address wallet, bytes calldata signature)",
  "function getAgentWallet(uint256 agentId) view returns (address)",
  // ERC-721 standard
  "function balanceOf(address owner) view returns (uint256 balance)",
  "function ownerOf(uint256 tokenId) view returns (address owner)",
  "function tokenURI(uint256 tokenId) view returns (string)",
  "function transferFrom(address from, address to, uint256 tokenId)",
  // Events
  "event Registered(uint256 indexed agentId, string tokenURI, address indexed owner)",
  // Structs
  "struct MetadataEntry { string key; bytes value; }",
]);

// ERC-8004 v1 Reputation Registry ABI
export const reputationRegistryAbi = parseAbi([
  // Give feedback (v1: no feedbackAuth - direct submission)
  "function giveFeedback(uint256 agentId, uint8 score, string calldata tag1, string calldata tag2, string calldata endpoint, string calldata feedbackURI, bytes32 feedbackHash)",
  // Read feedback
  "function getFeedback(uint256 agentId, address client, uint256 index) view returns (uint8 score, string tag1, string tag2, string endpoint, string feedbackURI, bytes32 feedbackHash, bool revoked)",
  "function getFeedbackCount(uint256 agentId, address client) view returns (uint256)",
  "function getClients(uint256 agentId) view returns (address[])",
  // Reputation summary
  "function getSummary(uint256 agentId) view returns (uint256 count, uint256 totalScore)",
  // Events
  "event NewFeedback(uint256 indexed agentId, address indexed client, uint256 index, uint8 score, string tag1, string tag2, string endpoint, string feedbackURI, bytes32 feedbackHash)",
]);

// Delegate Contract ABI (for EIP-7702 gasless registration)
export const delegateContractAbi = parseAbi([
  // Registration
  "function register(address registry) returns (uint256 agentId)",
  "function register(address registry, string calldata tokenURI) returns (uint256 agentId)",
  "function register(address registry, string calldata tokenURI, MetadataEntry[] calldata metadata) returns (uint256 agentId)",
  "struct MetadataEntry { string key; bytes value; }",
  // Feedback (v1: no feedbackAuth, uses struct to avoid stack too deep)
  "struct FeedbackParams { uint256 agentId; uint8 score; string tag1; string tag2; string endpoint; string feedbackURI; bytes32 feedbackHash; }",
  "function giveFeedback(address registry, FeedbackParams calldata params)",
]);
