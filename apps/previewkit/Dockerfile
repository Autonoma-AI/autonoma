# --- Stage 1: bundle the runner ------------------------------------------------
FROM node:24-alpine AS builder

# node-gyp toolchain so `pnpm install` can compile any monorepo dependency that
# lacks a musl prebuilt binary (Alpine is musl, not glibc).
RUN apk add --no-cache python3 make g++

RUN corepack enable

WORKDIR /app
COPY . .

RUN pnpm install --frozen-lockfile
RUN pnpm --filter @autonoma/previewkit build

# --- Stage 2: runtime ----------------------------------------------------------
FROM node:24-alpine

ARG BUILDKIT_VERSION=0.31.2
# buildctl - sends Dockerfile builds to the external BuildKit daemon (static Go binary)
RUN apk add --no-cache ca-certificates curl tar bash git unzip \
    && curl -sSL "https://github.com/moby/buildkit/releases/download/v${BUILDKIT_VERSION}/buildkit-v${BUILDKIT_VERSION}.linux-arm64.tar.gz" \
    | tar -xz -C /usr/local bin/buildctl

WORKDIR /app
COPY --from=builder /app/apps/previewkit/dist ./dist

ENV NODE_ENV=production
USER node
CMD ["node", "--enable-source-maps", "dist/index.js"]
