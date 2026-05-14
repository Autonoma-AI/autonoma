FROM node:24-alpine

ARG BUILDKIT_VERSION=0.30.0
RUN apk add --no-cache ca-certificates curl tar bash libc6-compat \
    # buildctl - sends Dockerfile builds to the external BuildKit daemon \
    && ARCH=$(uname -m | sed 's/x86_64/amd64/;s/aarch64/arm64/') \
    && curl -sSL "https://github.com/moby/buildkit/releases/download/v${BUILDKIT_VERSION}/buildkit-v${BUILDKIT_VERSION}.linux-${ARCH}.tar.gz" \
    | tar -xz -C /usr/local bin/buildctl \
    # railpack - auto-detects language/framework for projects without a Dockerfile \
    && curl -sSfL https://raw.githubusercontent.com/railwayapp/railpack/main/install.sh | sh

WORKDIR /app
COPY . .

ENV NODE_ENV=production
USER node
EXPOSE 3000
CMD ["node", "--enable-source-maps", "dist/index.js"]
