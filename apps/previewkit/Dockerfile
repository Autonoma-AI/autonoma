# --- Stage 1: bundle the runner ------------------------------------------------
FROM node:24-slim AS builder

RUN corepack enable

WORKDIR /app
COPY . .

# Installs dev deps (rolldown, tsx) and generates the Prisma client via
# @autonoma/db's postinstall, then bundles src/runner into dist/.
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @autonoma/previewkit build

# --- Stage 2: runtime ----------------------------------------------------------
FROM node:24-slim

ARG BUILDKIT_VERSION=0.30.0
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl tar bash git unzip \
    && rm -rf /var/lib/apt/lists/* \
    && ARCH=$(uname -m | sed 's/x86_64/amd64/;s/aarch64/arm64/') \
    # buildctl - sends Dockerfile builds to the external BuildKit daemon (static Go binary) \
    && curl -sSL "https://github.com/moby/buildkit/releases/download/v${BUILDKIT_VERSION}/buildkit-v${BUILDKIT_VERSION}.linux-${ARCH}.tar.gz" \
    | tar -xz -C /usr/local bin/buildctl

WORKDIR /app
# The bundle is self-contained - the whole dependency graph is inlined into
# dist/ (entry + code-split chunks incl. the Prisma wasm compiler), so no
# node_modules is needed at runtime.
COPY --from=builder /app/apps/previewkit/dist ./dist

ENV NODE_ENV=production
USER node
CMD ["node", "--enable-source-maps", "dist/index.js"]
