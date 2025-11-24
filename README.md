# x402 8004 Facilitator

A TypeScript facilitator for the x402 payment protocol, supporting both v1 and v2 x402 specifications with ERC-8004 agent registration and feedback capabilities.

**Network**: Base Sepolia  
**Facilitator URL**: https://facilitator.openmid.xyz  
**Delegation Contract**: `0xFdc90fCC6929a2f42a9D714bD10520eEE98bD378`

## Features

- **Payment Processing**: Verify and settle payments for both x402 v1 and v2
- **ERC-8004 Integration**: Agent registration via EIP-7702 delegation
- **Feedback System**: Submit agent feedback using EIP-7702 authorization

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
RPC_URL=https://sepolia.base.org
ERC8004_IDENTITY_REGISTRY_ADDRESS=0x...
ERC8004_REPUTATION_REGISTRY_ADDRESS=0x...
DELEGATE_CONTRACT_ADDRESS=0xFdc90fCC6929a2f42a9D714bD10520eEE98bD378
```

**Note**: The delegation contract address above is for Base Sepolia. The facilitator is available at https://facilitator.openmid.xyz

### Run

```bash
npm run dev
```

## API Endpoints

- `POST /verify` - Verify a payment
- `POST /settle` - Settle a payment on-chain
- `POST /register` - Register an agent with ERC-8004 (EIP-7702)
- `POST /feedback` - Submit feedback for an agent (EIP-7702)
- `GET /supported` - Get supported payment schemes

## Example Server Integrations

This repository includes example server implementations demonstrating how to integrate with the facilitator:

- **`examples/v1-server/`** - Example server using x402 v1 specification with legacy `x402-express` middleware
- **`examples/v2-server/`** - Example server using x402 v2 specification with `@x402/core` and `@x402/express`

Both examples include:
- Payment-protected resource endpoints
- Agent registration via EIP-7702
- Feedback authorization signing endpoints

See the `examples/` directory for complete working implementations.
