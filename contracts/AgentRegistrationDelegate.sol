// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";

/**
 * @title AgentRegistrationDelegate
 * @dev Delegation contract for EIP-7702 agent registration on Ethereum Sepolia
 * When an EOA delegates to this contract, it can call register() on IdentityRegistry
 * and msg.sender will be the EOA, not this contract
 *
 * Updated for new ERC-8004 contract ABIs:
 * - MetadataEntry uses metadataKey/metadataValue instead of key/value
 * - giveFeedback uses int128 value + uint8 valueDecimals instead of uint8 score
 */

interface IFiatTokenV2 {
    function transferWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        bytes memory signature
    ) external;
}

interface IIdentityRegistry {
    // Updated struct: field names changed to metadataKey/metadataValue
    struct MetadataEntry {
        string metadataKey;
        bytes metadataValue;
    }

    function register() external returns (uint256 agentId);
    function register(string memory agentURI) external returns (uint256 agentId);
    function register(string memory agentURI, MetadataEntry[] memory metadata) external returns (uint256 agentId);
}

interface IReputationRegistry {
    // Updated: uses int128 value with uint8 valueDecimals instead of uint8 score
    function giveFeedback(
        uint256 agentId,
        int128 value,
        uint8 valueDecimals,
        string calldata tag1,
        string calldata tag2,
        string calldata endpoint,
        string calldata feedbackURI,
        bytes32 feedbackHash
    ) external;
}

// Struct to avoid stack too deep - updated for new contract ABI
struct FeedbackParams {
    uint256 agentId;
    int128 value;
    uint8 valueDecimals;
    string tag1;
    string tag2;
    string endpoint;
    string feedbackURI;
    bytes32 feedbackHash;
}

contract AgentRegistrationDelegate {
    /**
     * @dev Register an agent with tokenURI and metadata
     * @param registry The IdentityRegistry contract address
     * @param tokenURI The token URI for the agent
     * @param metadata Array of metadata entries
     * @return agentId The registered agent ID
     */
    function register(
        address registry,
        string calldata tokenURI,
        IIdentityRegistry.MetadataEntry[] calldata metadata
    ) external returns (uint256 agentId) {
        // First, test that EIP-7702 delegation is working by calling a test contract
        // This helps debug if the issue is with delegation or with IdentityRegistry
        // You can deploy TestContract and pass its address here for testing
        // address testContract = 0x...; // Set this to your deployed TestContract address
        // ITestContract(testContract).testLogWithRegistry(registry, "EIP-7702 delegation working!");
        
        if (metadata.length > 0) {
            return IIdentityRegistry(registry).register(tokenURI, metadata);
        } else if (bytes(tokenURI).length > 0) {
            return IIdentityRegistry(registry).register(tokenURI);
        } else {
            return IIdentityRegistry(registry).register();
        }
    }

    /**
     * @dev Register an agent with tokenURI only
     * @param registry The IdentityRegistry contract address
     * @param tokenURI The token URI for the agent
     * @return agentId The registered agent ID
     */
    function register(address registry, string calldata tokenURI) external returns (uint256 agentId) {
        // Test delegation first (uncomment and set testContract address)
        // address testContract = 0x...;
        // ITestContract(testContract).testLog("EIP-7702 test before register");
        
        return IIdentityRegistry(registry).register(tokenURI);
    }

    /**
     * @dev Register an agent without tokenURI
     * @param registry The IdentityRegistry contract address
     * @return agentId The registered agent ID
     */
    function register(address registry) external returns (uint256 agentId) {
        // Test delegation first (uncomment and set testContract address)
        // address testContract = 0x...;
        // ITestContract(testContract).testLog("EIP-7702 test before register");
        
        return IIdentityRegistry(registry).register();
    }

    function onERC721Received(address /* operator */, address /* from */, uint256 /* tokenId */, bytes calldata /* data */) external pure returns (bytes4) {
        return IERC721Receiver.onERC721Received.selector;
    }

    // Updated for new contract ABI: uses int128 value with uint8 valueDecimals
    // Using struct to avoid stack too deep error
    function giveFeedback(address registry, FeedbackParams calldata params) external {
        IReputationRegistry(registry).giveFeedback(
            params.agentId,
            params.value,
            params.valueDecimals,
            params.tag1,
            params.tag2,
            params.endpoint,
            params.feedbackURI,
            params.feedbackHash
        );
    }

    function executeFiatTokenV2TransferWithAuthorization(
        address token,
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        bytes memory signature
    ) external {
        IFiatTokenV2(token).transferWithAuthorization(
            from,
            to,
            value,
            validAfter,
            validBefore,
            nonce,
            signature
        );
    }
}

