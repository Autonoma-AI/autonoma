FROM node:24-slim

# git + ripgrep back the bash tool's read-only codebase exploration (see
# packages/diffs/.../bash-tool.ts). The tool has no process isolation; its command
# allowlist + scrubbed environment are the only gates.
RUN apt-get update && apt-get install -y --no-install-recommends git ripgrep ca-certificates && rm -rf /var/lib/apt/lists/*

RUN corepack enable

WORKDIR /app
COPY . .

# Codebase clones land in dynamically-created temp dirs under /tmp
# (apps/workers/diffs/src/codebase/snapshot-context.ts, via mkdtemp). git's safe.directory takes exact
# paths or "*", not a parent prefix, so trust all repos: the bash tool runs git as
# root directly on these clones and reads this global config via HOME.
RUN git config --global --add safe.directory '*'

RUN pnpm install --frozen-lockfile

# Fails the build loudly if a workspace dependency didn't actually land in the image - the failure mode that has
# twice reached production as a crash-looping pod instead: a stale build cache served a COPY . . layer that
# predated @autonoma/billing, so pnpm install "succeeded" against a lockfile whose link target never arrived.
# A filesystem check, not an import: importing the real module runs its env validation, which has nothing to do
# with whether the workspace link resolved and legitimately fails without runtime secrets at build time. Checks
# this app's own dependency (run-analysis.ts's generation credit gate), not packages/diffs's - that one no longer
# depends on @autonoma/billing since AI-cost persistence there doesn't touch credits.
RUN test -e apps/workers/diffs/node_modules/@autonoma/billing/src/index.ts

RUN pnpm --filter @autonoma/worker-diffs run build

ENV NODE_ENV=production
WORKDIR /app/apps/workers/diffs
CMD ["/app/node_modules/.bin/tsx", "--import", "./src/preload.ts", "src/index.ts"]
