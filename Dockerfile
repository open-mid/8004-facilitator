# Use Node.js base image
FROM node:20

# Install pnpm globally
RUN npm install -g pnpm

# Create facilitator directory (so file:../x402 paths work correctly)
WORKDIR /app/facilitator

# Copy facilitator repo files
COPY package*.json ./
COPY tsconfig.json ./
COPY index.ts ./
COPY src ./src
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

