FROM node:24-slim

# bubblewrap (bwrap) is the process-isolation boundary for the bash tool's child
# (see packages/diffs/.../command-sandbox.ts). Without it the tool runs degraded.
RUN apt-get update && apt-get install -y --no-install-recommends git ripgrep ca-certificates bubblewrap && rm -rf /var/lib/apt/lists/*

RUN corepack enable

WORKDIR /app
COPY . .

# Codebase clones land in dynamically-seeded dirs under /tmp/codebase/<seed>
# (apps/workers/diffs/src/codebase/resolve.ts). git's safe.directory takes exact
# paths or "*", not a parent prefix, so trust all repos for the worker's own git
# invocations (it runs as root on its own clones). Inside the sandbox, git gets a
# matching safe.directory via GIT_CONFIG_* env injection instead.
RUN git config --global --add safe.directory '*'

RUN pnpm install --frozen-lockfile
RUN pnpm --filter @autonoma/worker-diffs run build

ENV NODE_ENV=production
WORKDIR /app/apps/workers/diffs
CMD ["/app/node_modules/.bin/tsx", "--import", "./src/preload.ts", "src/index.ts"]
