# x402 8004 Facilitator

A TypeScript facilitator for the x402 payment protocol, supporting both v1 and v2 x402 specifications with ERC-8004 agent registration and feedback capabilities.

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
DELEGATE_CONTRACT_ADDRESS=0x...
```

### Run

```bash
npm run dev

## API Endpoints

- `POST /verify` - Verify a payment
- `POST /settle` - Settle a payment on-chain
- `POST /register` - Register an agent with ERC-8004 (EIP-7702)
- `POST /feedback` - Submit feedback for an agent (EIP-7702)
- `GET /supported` - Get supported payment schemes

```
