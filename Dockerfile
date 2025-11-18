# Use Node.js base image
FROM node:20

# Install pnpm globally
RUN npm install -g pnpm

# Set working directory
WORKDIR /app

# Clone x402 repo and build it
RUN git clone --depth 1 --branch v2-development https://github.com/coinbase/x402.git x402 && \
    cd x402/typescript && \
    pnpm install && \
    pnpm build && \
    cd ../..

# Copy facilitator repo files
COPY package*.json ./
COPY tsconfig.json ./
COPY index.ts ./
COPY eslint.config.js ./
COPY .prettierrc* ./

# Install facilitator dependencies
RUN npm install

# Build facilitator
RUN npm run build

# Expose port (adjust if needed based on your PORT env var)
EXPOSE 4022

# Start the application
CMD ["npm", "run", "dev"]

