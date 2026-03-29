# Build stage
FROM node:20-bookworm-slim AS builder

# Enable Corepack for pnpm
RUN corepack enable

WORKDIR /app

# Copy monorepo config files first (for caching)
COPY pnpm-lock.yaml ./
COPY package.json ./
COPY pnpm-workspace.yaml ./


ARG PNPM_VERSION=10.26.1
RUN corepack prepare pnpm@${PNPM_VERSION} --activate


RUN pnpm install --frozen-lockfile --prefer-offline --recursive

COPY . .
RUN pnpm build

FROM node:20-bookworm-slim

WORKDIR /app

COPY --from=builder /app /app

EXPOSE 5173


CMD ["pnpm", "--filter", "@workspace/polymarket-bot", "serve", "--host", "0.0.0.0"]