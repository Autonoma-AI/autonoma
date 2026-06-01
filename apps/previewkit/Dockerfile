FROM node:24-alpine

ARG BUILDKIT_VERSION=0.30.0
# railpack pins a specific mise version (see core/mise/version.txt in the railpack repo).
# When bumping RAILPACK_VERSION, check core/mise/version.txt at that tag and update
# MISE_VERSION to match. If they drift, railpack will silently ignore the seeded musl
# binary and try to download the glibc build from GitHub, which fails on Alpine with
# exit 127 ("command not found") because the loader can't run the glibc binary.
ARG RAILPACK_VERSION=0.23.0
ARG MISE_VERSION=2026.3.17
# bun is used as the fallback runtime for evaluating per-app next.config.{js,mjs,ts}
# files in the turbo-monorepo build path. Node handles .js + .mjs; bun handles
# .ts and ESM/CJS edge cases. The official install script targets glibc; on
# alpine we use the musl tarball.
ARG BUN_VERSION=1.2.20
RUN apk add --no-cache ca-certificates curl tar bash libc6-compat git unzip \
    # buildctl - sends Dockerfile builds to the external BuildKit daemon \
    && ARCH=$(uname -m | sed 's/x86_64/amd64/;s/aarch64/arm64/') \
    && BUN_ARCH=$(uname -m | sed 's/x86_64/x64/;s/aarch64/aarch64/') \
    && MISE_ARCH=$(uname -m | sed 's/x86_64/x64/;s/aarch64/arm64/') \
    && curl -sSL "https://github.com/moby/buildkit/releases/download/v${BUILDKIT_VERSION}/buildkit-v${BUILDKIT_VERSION}.linux-${ARCH}.tar.gz" \
    | tar -xz -C /usr/local bin/buildctl \
    # railpack - auto-detects language/framework for projects without a Dockerfile \
    && curl -sSfL https://raw.githubusercontent.com/railwayapp/railpack/main/install.sh | RAILPACK_VERSION="${RAILPACK_VERSION}" sh \
    # bun - musl build, used to evaluate .ts next.config files \
    && curl -sSfL -o /tmp/bun.zip "https://github.com/oven-sh/bun/releases/download/bun-v${BUN_VERSION}/bun-linux-${BUN_ARCH}-musl.zip" \
    && unzip -q /tmp/bun.zip -d /tmp/bun \
    && mv "/tmp/bun/bun-linux-${BUN_ARCH}-musl/bun" /usr/local/bin/bun \
    && chmod 0755 /usr/local/bin/bun \
    && rm -rf /tmp/bun /tmp/bun.zip \
    # Seed railpack's mise cache with the musl build so it skips the glibc download \
    && mkdir -p /tmp/railpack/mise \
    && curl -sSfL -o "/tmp/railpack/mise/mise-${MISE_VERSION}" \
        "https://github.com/jdx/mise/releases/download/v${MISE_VERSION}/mise-v${MISE_VERSION}-linux-${MISE_ARCH}-musl" \
    && chmod 0755 "/tmp/railpack/mise/mise-${MISE_VERSION}" \
    && chown -R node:node /tmp/railpack

WORKDIR /app
COPY . .

ENV NODE_ENV=production
USER node

EXPOSE 3000

CMD ["node", "--enable-source-maps", "dist/index.js"]
