# Previewkit runner image.
#
# The one-shot deploy/teardown/redeploy runner (src/runner) runs from source via
# tsx (not bundled) and needs the real build tooling - buildctl, railpack, mise,
# bun - because it drives real container image builds. Those tools are installed
# as glibc builds, so this image uses a glibc base (node:24-slim / Debian), like
# apps/workers/{diffs,general}. The API launches it as a Kubernetes Job
# (PreviewkitJobLauncher), overriding the command with the runner entrypoint and
# injecting the PREVIEWKIT_JOB_SPEC payload.
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

RUN corepack enable

WORKDIR /app
COPY . .

RUN pnpm install --frozen-lockfile

ENV NODE_ENV=production
WORKDIR /app/apps/previewkit
CMD ["/app/node_modules/.bin/tsx", "src/runner/index.ts"]
