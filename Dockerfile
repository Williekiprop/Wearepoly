# Build stage
FROM node:20-bookworm-slim AS builder

# Enable Corepack (pnpm/yarn manager built into Node)
RUN corepack enable

WORKDIR /app

# Copy monorepo config files first (for caching)
COPY pnpm-lock.yaml ./
COPY package.json ./
COPY pnpm-workspace.yaml ./
COPY .npmrc ./                # remove this line if you don't have .npmrc

# Use the same pnpm version you have in Replit
ARG PNPM_VERSION=10.26.1
RUN corepack prepare pnpm@${PNPM_VERSION} --activate

# Install all dependencies (frozen = strict, matches your lockfile)
RUN pnpm install --frozen-lockfile --prefer-offline

# Now copy the rest of the source code
COPY . .

# Build your app (use filter if the build script is only in one workspace)
RUN pnpm build
# If the build needs to target your specific package:
# RUN pnpm --filter @workspace/polymarket-bot build

# Runtime stage (smaller final image)
FROM node:20-bookworm-slim

WORKDIR /app

# Copy only what's needed from builder
COPY --from=builder /app /app

# Expose the port your app uses (Vite default is 5173)
EXPOSE 5173

# Start the app
# For production preview (recommended for Railway):
CMD ["pnpm", "--filter", "@workspace/polymarket-bot", "serve"]
# For development/hot-reload (useful for testing):
# CMD ["pnpm", "--filter", "@workspace/polymarket-bot", "dev", "--host", "0.0.0.0"]