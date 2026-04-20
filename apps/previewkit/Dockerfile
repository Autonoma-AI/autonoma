FROM node:24-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    curl \
    && rm -rf /var/lib/apt/lists/*

# Install railpack
RUN curl -sSfL https://raw.githubusercontent.com/railwayapp/railpack/main/install.sh | bash

# Install buildctl (for Dockerfile-based builds)
ARG BUILDKIT_VERSION=0.17.2
RUN curl -sSL "https://github.com/moby/buildkit/releases/download/v${BUILDKIT_VERSION}/buildkit-v${BUILDKIT_VERSION}.linux-$(dpkg --print-architecture).tar.gz" \
    | tar -xz -C /usr/local bin/buildctl

RUN npm install -g tsx pnpm turbo

WORKDIR /app

COPY . .

ENV CI=true

RUN pnpm install --frozen-lockfile
RUN pnpm turbo run build --filter=@autonoma/previewkit...

ENV NODE_ENV=production

WORKDIR /app/apps/previewkit

EXPOSE 3000
