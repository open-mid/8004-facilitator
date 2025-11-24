// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import "../lib/openzeppelin-contracts/contracts/token/ERC721/IERC721Receiver.sol";

/**
 * @title AgentRegistrationDelegate
 * @dev Delegation contract for EIP-7702 agent registration
 * When an EOA delegates to this contract, it can call register() on IdentityRegistry
 * and msg.sender will be the EOA, not this contract
 */

interface IFiatTokenV2 {
    function transferWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        bytes memory signature) external;
}

interface IIdentityRegistry {
    struct MetadataEntry {
        string key;
        bytes value;
    }

    function register() external returns (uint256 agentId);
    function register(string memory tokenUri) external returns (uint256 agentId);
    function register(string memory tokenUri, MetadataEntry[] memory metadata) external returns (uint256 agentId);
}

interface IReputationRegistry {
    function giveFeedback(uint256 agentId, uint8 score, bytes32 tag1, bytes32 tag2, string calldata fileuri, bytes32 filehash, bytes memory feedbackAuth) external;
    function getIdentityRegistry() external view returns (address);
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

    function giveFeedback(address registry, uint256 agentId, uint8 score, bytes32 tag1, bytes32 tag2, string calldata fileuri, bytes32 filehash, bytes memory feedbackAuth) external {
        IReputationRegistry(registry).giveFeedback(agentId, score, tag1, tag2, fileuri, filehash, feedbackAuth);
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

