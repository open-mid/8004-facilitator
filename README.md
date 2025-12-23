# x402 8004 Facilitator

A facilitator acts as the service access point for x402 payments: verifying user requests, settling payments on-chain. This implementation extends that flow with ERC-8004 identity and feedback primitives, enabling fully onchain agent registration and authenticated service evaluation.

**Payment Network**: Base Mainnet, Base Sepolia  
**Facilitator URL**: https://facilitator.openmid.xyz  
**Documentation**: https://www.openmid.xyz/docs  
**ERC-8004 Network**: Base Sepolia  
**Delegation Contract**: `0xFdc90fCC6929a2f42a9D714bD10520eEE98bD378`

## Features

- **Payment Processing**: Verify and settle payments for both x402 v1 and v2
- **ERC-8004 Integration**: Agent registration via EIP-7702 delegation
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

## Quick Start

### Prerequisites

- Node.js 18+
- Environment variables configured (see `.env`)

### Installation

```bash
npm install
```

### Configuration

Create a `.env` file with the following variables:

```env
# Required
FACILITATOR_PRIVATE_KEY=0x...
ERC8004_IDENTITY_REGISTRY_ADDRESS=0x...
DELEGATE_CONTRACT_ADDRESS=0xFdc90fCC6929a2f42a9D714bD10520eEE98bD378
```

**Note**: The delegation contract address above is for Base Sepolia. The facilitator is available at https://facilitator-testnet.openmid.xyz

### Run

```bash
npm run dev
```

## API Endpoints

- `POST /verify` - Verify a payment
- `POST /settle` - Settle a payment on-chain
- `POST /register` - Register an agent with ERC-8004 (EIP-7702)
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
