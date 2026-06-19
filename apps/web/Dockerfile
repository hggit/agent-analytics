FROM node:20-alpine
WORKDIR /app

# Copy root workspace and package manifests
COPY package*.json ./
COPY tsconfig*.json ./
COPY packages/sdk/package*.json ./packages/sdk/
COPY apps/web/package*.json ./apps/web/

# Install dependencies
RUN npm install

# Copy SDK package and frontend app
COPY packages/sdk/ ./packages/sdk/
COPY apps/web/ ./apps/web/

EXPOSE 5173

# Start Vite React server with --host flag so it exposes port to host machine
CMD ["npm", "run", "dev:web", "--", "--host"]
