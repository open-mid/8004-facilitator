import { parseAbi } from "viem";

// ERC-8004 Identity Registry ABI (Ethereum Sepolia - IdentityRegistryUpgradeable)
export const identityRegistryAbi = parseAbi([
  // Registration
  "function register() external returns (uint256 agentId)",
  "function register(string memory agentURI) external returns (uint256 agentId)",
  "function register(string memory agentURI, MetadataEntry[] memory metadata) external returns (uint256 agentId)",
  // Metadata
  "function getMetadata(uint256 agentId, string memory metadataKey) external view returns (bytes memory)",
  "function setMetadata(uint256 agentId, string memory metadataKey, bytes memory metadataValue) external",
  "function setAgentURI(uint256 agentId, string calldata newURI) external",
  // Agent Wallet
  "function setAgentWallet(uint256 agentId, address newWallet, uint256 deadline, bytes calldata signature) external",
  "function getAgentWallet(uint256 agentId) external view returns (address)",
  "function unsetAgentWallet(uint256 agentId) external",
  // Authorization
  "function isAuthorizedOrOwner(address spender, uint256 agentId) external view returns (bool)",
  // ERC-721 standard
  "function balanceOf(address owner) view returns (uint256 balance)",
  "function ownerOf(uint256 tokenId) view returns (address owner)",
  "function tokenURI(uint256 tokenId) view returns (string)",
  "function transferFrom(address from, address to, uint256 tokenId)",
  // Version
  "function getVersion() external pure returns (string memory)",
  // Events
  "event Registered(uint256 indexed agentId, string tokenURI, address indexed owner)",
  "event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)",
  // Structs - Note: field names changed to metadataKey/metadataValue
  "struct MetadataEntry { string metadataKey; bytes metadataValue; }",
]);

// ERC-8004 Reputation Registry ABI (Ethereum Sepolia - ReputationRegistryUpgradeable)
export const reputationRegistryAbi = parseAbi([
  // Give feedback - Note: uses int128 value with decimals instead of uint8 score
  "function giveFeedback(uint256 agentId, int128 value, uint8 valueDecimals, string calldata tag1, string calldata tag2, string calldata endpoint, string calldata feedbackURI, bytes32 feedbackHash) external",
  // Revoke feedback
  "function revokeFeedback(uint256 agentId, uint64 feedbackIndex) external",
  // Read feedback
  "function readFeedback(uint256 agentId, address clientAddress, uint64 feedbackIndex) external view returns (int128 value, uint8 valueDecimals, bool isRevoked, string memory tag1, string memory tag2)",
  "function readAllFeedback(uint256 agentId, address[] calldata clientAddresses, string calldata tag1, string calldata tag2, bool includeRevoked) external view",
  "function getLastIndex(uint256 agentId, address clientAddress) external view returns (uint64)",
  "function getClients(uint256 agentId) external view returns (address[] memory)",
  // Response tracking
  "function appendResponse(uint256 agentId, address clientAddress, uint64 feedbackIndex, string calldata responseURI, bytes32 responseHash) external",
  "function getResponseCount(uint256 agentId, address clientAddress, uint64 feedbackIndex, address[] calldata responders) external view returns (uint64)",
  // Reputation summary - Note: new signature with filtering parameters
  "function getSummary(uint256 agentId, address[] calldata clientAddresses, string calldata tag1, string calldata tag2) external view returns (uint64 count, int128 summaryValue, uint8 summaryValueDecimals)",
  // Version
  "function getVersion() external pure returns (string memory)",
  // Identity registry reference
  "function getIdentityRegistry() external view returns (address)",
  // Structs
  "struct Feedback { int128 value; uint8 valueDecimals; bool isRevoked; string tag1; string tag2; }",
]);

// Delegate Contract ABI (for EIP-7702 gasless registration on Ethereum Sepolia)
export const delegateContractAbi = parseAbi([
  // Registration - Note: MetadataEntry uses metadataKey/metadataValue
  "function register(address registry) returns (uint256 agentId)",
  "function register(address registry, string calldata tokenURI) returns (uint256 agentId)",
  "function register(address registry, string calldata tokenURI, MetadataEntry[] calldata metadata) returns (uint256 agentId)",
  "struct MetadataEntry { string metadataKey; bytes metadataValue; }",
  // Feedback - Note: uses int128 value with decimals
  "struct FeedbackParams { uint256 agentId; int128 value; uint8 valueDecimals; string tag1; string tag2; string endpoint; string feedbackURI; bytes32 feedbackHash; }",
  "function giveFeedback(address registry, FeedbackParams calldata params)",
]);
