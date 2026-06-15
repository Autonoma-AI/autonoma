FROM node:24-slim

# git + ripgrep back the bash tool's read-only codebase exploration (see
# packages/diffs/.../bash-tool.ts). The tool has no process isolation; its command
# allowlist + scrubbed environment are the only gates.
RUN apt-get update && apt-get install -y --no-install-recommends git ripgrep ca-certificates && rm -rf /var/lib/apt/lists/*

RUN corepack enable

WORKDIR /app
COPY . .

# Codebase clones land in dynamically-seeded dirs under /tmp/codebase/<seed>
# (apps/workers/diffs/src/codebase/resolve.ts). git's safe.directory takes exact
# paths or "*", not a parent prefix, so trust all repos: the bash tool runs git as
# root directly on these clones and reads this global config via HOME.
RUN git config --global --add safe.directory '*'

RUN pnpm install --frozen-lockfile
RUN pnpm --filter @autonoma/worker-diffs run build

ENV NODE_ENV=production
WORKDIR /app/apps/workers/diffs
CMD ["/app/node_modules/.bin/tsx", "--import", "./src/preload.ts", "src/index.ts"]
