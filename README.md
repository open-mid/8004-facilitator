# x402 8004 Facilitator

A facilitator acts as the service access point for x402 payments: verifying user requests, settling payments on-chain. This implementation extends that flow with ERC-8004 identity and feedback primitives, enabling fully onchain agent registration and authenticated service evaluation.

**Payment Network**: Base Mainnet, Base Sepolia
**ERC-8004 Registry Network**: Configurable (default: Ethereum Sepolia)
**Facilitator URL**: https://facilitator.openmid.xyz
**Documentation**: https://www.openmid.xyz/docs

### ERC-8004 Contract Addresses

Defaults come from the official ERC-8004 contracts repo: https://github.com/erc-8004/erc-8004-contracts

#### Ethereum Sepolia

| Contract | Address |
|----------|---------|
| Identity Registry | `0x8004A818BFB912233c491871b3d84c89A494BD9e` |
| Reputation Registry | `0x8004B663056A597Dffe9eCcC1965A193B7388713` |
| Delegation Contract | `0x252367B463f77EFe33c151E9d9821788090EC4b5` |

#### Base Mainnet

| Contract | Address |
|----------|---------|
| Identity Registry | `0x8004A169FB4a3325136EB29fA0ceB6D2e539a432` |
| Reputation Registry | `0x8004BAa17C55a88189AE136b182e5fdA19dE9b63` |
| Delegation Contract | `0x097f9491a25c1D5087298db04B11c9A461dD0661` |

## Features

- **Payment Processing**: Verify and settle payments for both x402 v1 and v2 (Base Sepolia / Base Mainnet)
- **ERC-8004 Integration**: Agent registration via EIP-7702 delegation (configurable registry network)
- **Feedback System**: Enables agent signing feedback auth within the x402 payment flow

### ERC-8004 Registration with x402 V2 extension

Openmid facilitator fully integrates x402 V2. It uses the extension feature to allow 8004 registration in a very convenient fashion.

```
app.use(
  paymentMiddleware(
    {
      "/weather": {
        accepts: {
          payTo,
          scheme: "exact",
          price: "$0.001",
          network: "eip155:8453",
        },
        extensions: {
          "erc-8004": {
            registerAuth: registerAuth,
            tokenURI: "https://example.com/tokenURI",
            metadata: [{ key: "name", value: "Example" }],
          },
        },
      },
    },
    service,
  ),
);
```

Simply by passing "erc-8004" key and the 7702 auth, the facilitator can register the agent automatically to the 8004 registry. For full example, please see `examples/v2-server`.

**Note**: The `registerAuth` must be signed for the configured ERC-8004 registry network (see `ERC8004_NETWORK`), while x402 payments are processed on Base networks.

## Quick Start

### Prerequisites

- Node.js 18+
- Environment variables configured (see `.env.example`)

### Installation

```bash
npm install
```

### Configuration

Create a `.env` file with the following variables:

```env
# Required
FACILITATOR_PRIVATE_KEY=0x...

# x402 Payment Network (Base Sepolia)
RPC_URL=https://sepolia.base.org

# ERC-8004 Registry Network (defaults to Ethereum Sepolia)
ERC8004_NETWORK=eip155:11155111
ERC8004_RPC_URL=https://ethereum-sepolia-rpc.publicnode.com
# Optional overrides (defaults depend on ERC8004_NETWORK)
# ERC8004_IDENTITY_REGISTRY_ADDRESS=0x...
# ERC8004_REPUTATION_REGISTRY_ADDRESS=0x...
DELEGATE_CONTRACT_ADDRESS=0x252367B463f77EFe33c151E9d9821788090EC4b5
```

### Run

```bash
npm run dev
```

## API Endpoints

- `POST /verify` - Verify a payment
- `POST /settle` - Settle a payment on-chain
- `POST /register` - Register an agent with ERC-8004 (EIP-7702)
- `GET /agent` - Get agent ID by address
- `GET /reputation` - Get reputation summary for an agent
- `POST /feedback` - Submit feedback for an agent
- `GET /supported` - Get supported payment schemes

## Example Server Integrations

This repository includes example server implementations demonstrating how to integrate with the facilitator:

- **`examples/v1-server/`** - Example server using x402 v1 specification with legacy `x402-express` middleware
- **`examples/v2-server/`** - Example server using x402 v2 specification with `@x402/core` and `@x402/express`
  - **Note**: Requires x402 v2-development branch

Both examples include:

- Payment-protected resource endpoints
- Agent registration via EIP-7702
- Feedback authorization signing endpoints

See the `examples/` directory for complete working implementations.

## Flow Diagram

![x402 Facilitator Flow](flow.png)
