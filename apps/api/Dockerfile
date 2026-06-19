FROM node:20-alpine
WORKDIR /app

# Copy root workspace and package manifests
COPY package*.json ./
COPY tsconfig*.json ./
COPY packages/sdk/package*.json ./packages/sdk/
COPY apps/api/package*.json ./apps/api/

# Install dependencies (workspaces automatically resolve)
RUN npm install

# Copy SDK package and API app
COPY packages/sdk/ ./packages/sdk/
COPY apps/api/ ./apps/api/

EXPOSE 3000

# Start API inside monorepo
CMD ["npm", "run", "dev:api"]
