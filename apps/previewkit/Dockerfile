FROM node:24-slim

ARG BUILDKIT_VERSION=0.29.0
ARG CRANE_VERSION=0.20.2
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl tar git \
    && rm -rf /var/lib/apt/lists/* \
    # buildctl — sends Dockerfile builds to the external BuildKit daemon
    && ARCH=$(uname -m | sed 's/x86_64/amd64/;s/aarch64/arm64/') \
    && curl -sSL "https://github.com/moby/buildkit/releases/download/v${BUILDKIT_VERSION}/buildkit-v${BUILDKIT_VERSION}.linux-${ARCH}.tar.gz" \
    | tar -xz -C /usr/local bin/buildctl \
    # railpack — auto-detects language/framework for projects without a Dockerfile
    && curl -sSfL https://raw.githubusercontent.com/railwayapp/railpack/main/install.sh | sh \
    # crane — pushes the Docker image tarball that railpack produces to ECR
    && CRANE_ARCH=$(uname -m | sed 's/x86_64/x86_64/;s/aarch64/arm64/') \
    && curl -sSL "https://github.com/google/go-containerregistry/releases/download/v${CRANE_VERSION}/go-containerregistry_Linux_${CRANE_ARCH}.tar.gz" \
    | tar -xz -C /usr/local/bin crane

WORKDIR /app
COPY . .

ENV NODE_ENV=production
USER node
EXPOSE 3000
CMD ["node", "--enable-source-maps", "dist/index.js"]
