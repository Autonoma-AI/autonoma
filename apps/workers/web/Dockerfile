FROM node:24-slim

RUN corepack enable

WORKDIR /app
COPY . .

RUN pnpm install --frozen-lockfile
RUN pnpm --filter @autonoma/worker-web run build
RUN pnpm --filter @autonoma/engine-web exec playwright install --with-deps chromium

ENV NODE_ENV=production
CMD ["pnpm", "--filter", "@autonoma/worker-web", "start"]
