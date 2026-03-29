# syntax=docker/dockerfile:1
FROM node:20-bookworm-slim AS builder

# Enable pnpm via corepack
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable

WORKDIR /app

# Copy only dependency files first (critical for Docker layer caching)
COPY pnpm-lock.yaml ./
COPY package.json ./
COPY pnpm-workspace.yaml ./

# Copy all workspace package.json files so pnpm knows the structure
# Adjust these paths if your folders are different (e.g. apps/, packages/, artifacts/)
COPY */package.json ./
COPY **/*/package.json ./

# Install ALL dependencies (including devDependencies needed for build)
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile --prefer-offline

# Now copy the source code
COPY . .

# Build ONLY your Polymarket bot package (this is the key fix)
# Use the exact name from your package.json "name" field
RUN pnpm --filter "@workspace/polymarket-bot" build

# === Production Stage (much smaller image) ===
FROM node:20-bookworm-slim AS production

ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable

WORKDIR /app

# Copy only what's needed for running the bot
COPY --from=builder /app/pnpm-lock.yaml ./
COPY --from=builder /app/package.json ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/artifacts ./artifacts   # or wherever your build output lands (dist/, build/, etc.)

# Install only production dependencies
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --prod --frozen-lockfile

# If your bot has its own package.json in a subfolder, you can copy that too if needed

# Change this to your actual bot start command
# Common options for background bots:
CMD ["pnpm", "--filter", "@workspace/polymarket-bot", "start"]

# Alternative if you want to run the built JS directly (often better for bots):
# CMD ["node", "artifacts/polymarket-bot/dist/index.js"]   # adjust path to your actual entry file
