# node-caged is the sandbox for the run_script harness (no process isolation; the caged runtime, its temp
# dir, scrubbed environment, and time bound are the gates - see PreviewEnvironment). MUST be the glibc
# (Debian) variant, NOT -alpine: @temporalio/core-bridge ships a glibc native binary that fails to load on
# musl ("__register_atfork: symbol not found").
FROM platformatic/node-caged:25-slim

# git + ripgrep back LocalCodebaseReader (file reads use Node fs; grep uses ripgrep; diff uses git).
RUN apt-get update && apt-get install -y --no-install-recommends git ripgrep ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# corepack is not bundled in the node-caged base image (unlike node:24-slim), so install the workspace's
# pinned pnpm (package.json packageManager) directly via the base's npm. Keep this version in sync.
RUN npm install -g pnpm@11.8.0

WORKDIR /app
COPY . .

# Codebase clones land in /tmp/codebase/<seed> (apps/workers/investigation/src/codebase/resolve.ts).
# git's safe.directory takes exact paths or "*", so trust all repos: the reader runs git on these clones
# and reads this global config via HOME.
RUN git config --global --add safe.directory '*'

RUN pnpm install --frozen-lockfile
RUN pnpm --filter @autonoma/worker-investigation run build

ENV NODE_ENV=production
WORKDIR /app/apps/workers/investigation
CMD ["/app/node_modules/.bin/tsx", "--import", "./src/preload.ts", "src/index.ts"]
