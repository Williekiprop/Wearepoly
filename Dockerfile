# Build stage
FROM node:20-bookworm-slim AS builder

# Enable Corepack for pnpm
RUN corepack enable

WORKDIR /app

# Copy monorepo config files first (for caching)
COPY pnpm-lock.yaml ./
COPY package.json ./
COPY pnpm-workspace.yaml ./
# COPY .npmrc ./   # only if you have a .npmrc file

# Pin your working pnpm version
ARG PNPM_VERSION=10.26.1
RUN corepack prepare pnpm@${PNPM_VERSION} --activate

# Install dependencies
RUN pnpm install --frozen-lockfile --prefer-offline

# Copy source code and build
COPY . .
RUN pnpm build
# If needed for specific workspace: RUN pnpm --filter @workspace/polymarket-bot build

# Runtime stage (smaller image)
FROM node:20-bookworm-slim

WORKDIR /app

COPY --from=builder /app /app

EXPOSE 5173

# Start command (binds to all interfaces for Railway)
CMD ["pnpm", "--filter", "@workspace/polymarket-bot", "serve", "--host", "0.0.0.0"]