FROM node:24-slim

RUN apt-get update && apt-get install -y --no-install-recommends git ripgrep ca-certificates && rm -rf /var/lib/apt/lists/*

RUN corepack enable

WORKDIR /app
COPY . .

RUN git config --global --add safe.directory /tmp/repo
RUN git config --global --add safe.directory /tmp/repo-resolution

RUN pnpm install --frozen-lockfile
RUN pnpm --filter @autonoma/worker-general run build

ENV NODE_ENV=production
CMD ["pnpm", "--filter", "@autonoma/worker-general", "start"]
