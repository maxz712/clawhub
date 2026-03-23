# Stage 1: Build
FROM node:20-slim AS builder

WORKDIR /app

# Install git (needed for simple-git during build/runtime)
RUN apt-get update && apt-get install -y git && rm -rf /var/lib/apt/lists/*

# Copy workspace root files
COPY package.json package-lock.json* ./
COPY tsconfig.base.json ./

# Copy package manifests for all workspaces
COPY packages/api/package.json packages/api/
COPY packages/dashboard/package.json packages/dashboard/
COPY packages/openclaw-skill/package.json packages/openclaw-skill/
COPY packages/cli/package.json packages/cli/

# Install dependencies
RUN npm install --ignore-scripts

# Copy source code
COPY packages/api/ packages/api/

# Build the API package
RUN npm -w @clawforge/api run build

# Stage 2: Production
FROM node:20-slim

WORKDIR /app

# Install git — provides git-http-backend at /usr/lib/git-core/git-http-backend
RUN apt-get update && apt-get install -y git && rm -rf /var/lib/apt/lists/*

# Verify git-http-backend exists
RUN test -f /usr/lib/git-core/git-http-backend

# Copy workspace root files
COPY package.json package-lock.json* ./
COPY tsconfig.base.json ./

# Copy package manifests
COPY packages/api/package.json packages/api/
COPY packages/dashboard/package.json packages/dashboard/
COPY packages/openclaw-skill/package.json packages/openclaw-skill/
COPY packages/cli/package.json packages/cli/

# Install production dependencies only
RUN npm install --omit=dev --ignore-scripts

# Copy built output from builder
COPY --from=builder /app/packages/api/dist packages/api/dist

# Create data directory for git repos
RUN mkdir -p /app/data/repos

ENV NODE_ENV=production
ENV GIT_REPOS_BASE_PATH=/app/data/repos

EXPOSE 3000

CMD ["node", "packages/api/dist/index.js"]
