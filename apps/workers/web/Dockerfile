# Use Microsoft's official Playwright image: Chromium + all system deps are
# pre-installed and version-locked to the Playwright tag, so we don't run
# `playwright install --with-deps` at build time (it hangs in containerized
# arm64 environments during the post-download validation step).
# Tag must match `playwright` in pnpm-workspace.yaml; bump both together.
FROM mcr.microsoft.com/playwright:v1.56.1-noble

RUN corepack enable

WORKDIR /app
COPY . .

RUN pnpm install --frozen-lockfile
RUN pnpm --filter @autonoma/worker-web run build

ENV NODE_ENV=production
CMD ["pnpm", "--filter", "@autonoma/worker-web", "start"]
