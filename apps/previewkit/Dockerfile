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
# railpack pins a specific mise version (see core/mise/version.txt in the railpack repo).
ARG RAILPACK_VERSION=0.23.0
ARG MISE_VERSION=2026.3.17
ARG BUN_VERSION=1.2.20
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl tar bash git unzip \
    && rm -rf /var/lib/apt/lists/* \
    && ARCH=$(uname -m | sed 's/x86_64/amd64/;s/aarch64/arm64/') \
    && BUN_ARCH=$(uname -m | sed 's/x86_64/x64/;s/aarch64/aarch64/') \
    && MISE_ARCH=$(uname -m | sed 's/x86_64/x64/;s/aarch64/arm64/') \
    # buildctl - sends Dockerfile builds to the external BuildKit daemon (static Go binary) \
    && curl -sSL "https://github.com/moby/buildkit/releases/download/v${BUILDKIT_VERSION}/buildkit-v${BUILDKIT_VERSION}.linux-${ARCH}.tar.gz" \
    | tar -xz -C /usr/local bin/buildctl \
    # railpack - auto-detects language/framework for projects without a Dockerfile \
    && curl -sSfL https://raw.githubusercontent.com/railwayapp/railpack/main/install.sh | RAILPACK_VERSION="${RAILPACK_VERSION}" sh \
    # bun - glibc build, used to evaluate .ts next.config files \
    && curl -sSfL -o /tmp/bun.zip "https://github.com/oven-sh/bun/releases/download/bun-v${BUN_VERSION}/bun-linux-${BUN_ARCH}.zip" \
    && unzip -q /tmp/bun.zip -d /tmp/bun \
    && mv "/tmp/bun/bun-linux-${BUN_ARCH}/bun" /usr/local/bin/bun \
    && chmod 0755 /usr/local/bin/bun \
    && rm -rf /tmp/bun /tmp/bun.zip \
    # Seed railpack's mise cache with the glibc build so it skips the download \
    && mkdir -p /tmp/railpack/mise \
    && curl -sSfL -o "/tmp/railpack/mise/mise-${MISE_VERSION}" \
        "https://github.com/jdx/mise/releases/download/v${MISE_VERSION}/mise-v${MISE_VERSION}-linux-${MISE_ARCH}" \
    && chmod 0755 "/tmp/railpack/mise/mise-${MISE_VERSION}" \
    && chown -R node:node /tmp/railpack

WORKDIR /app
# The bundle is self-contained - the whole dependency graph is inlined into
# dist/ (entry + code-split chunks incl. the Prisma wasm compiler and the
# copied read-next-config.mjs), so no node_modules is needed at runtime.
COPY --from=builder /app/apps/previewkit/dist ./dist

ENV NODE_ENV=production
USER node
CMD ["node", "--enable-source-maps", "dist/index.js"]
