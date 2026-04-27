FROM node:24-slim

RUN apt-get update && apt-get install -y --no-install-recommends git ripgrep ca-certificates && rm -rf /var/lib/apt/lists/*

RUN corepack enable

WORKDIR /app
COPY . .

RUN git config --global --add safe.directory /tmp/repo
RUN git config --global --add safe.directory /tmp/repo-resolution

RUN pnpm install --frozen-lockfile
RUN pnpm --filter @autonoma/worker-diffs run build

ENV NODE_ENV=production
WORKDIR /app/apps/workers/diffs
CMD ["/app/node_modules/.bin/tsx", "--import", "./src/preload.ts", "src/index.ts"]
