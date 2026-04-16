# syntax=docker/dockerfile:1
FROM node:20-bookworm-slim AS builder

ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable

WORKDIR /app

# Copy dependency definition files first
COPY pnpm-lock.yaml ./
COPY package.json ./
COPY pnpm-workspace.yaml ./

# Copy all package.json files from workspaces (this is crucial)
COPY artifacts/*/package.json ./artifacts/
COPY */package.json ./
COPY **/*/package.json ./

# Install root dependencies, then recursively install all workspace packages
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile --prefer-offline && pnpm install --frozen-lockfile -r

# Copy source code
COPY . .

# Build ONLY the Polymarket bot package
RUN pnpm --filter "@workspace/polymarket-bot" build   # ← confirm exact name

# === Prune to a production-ready folder using pnpm deploy ===
RUN pnpm deploy --filter "@workspace/polymarket-bot" --prod /prod/app

# === Final lightweight production stage ===
FROM node:20-bookworm-slim

ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable

WORKDIR /app

# Copy the pruned app from builder
COPY --from=builder /prod/app ./

# Your actual bot start command goes here
# Option 1: If your package.json has a "start" script
CMD ["pnpm", "start"]

# Option 2 (often better for background bots): Run the built file directly
# CMD ["node", "dist/index.js"]          # adjust path if your build outputs to dist/, build/, etc.
# CMD ["node", "artifacts/polymarket-bot/dist/index.js"]  # example if needed
