FROM node:24-slim

RUN corepack enable

WORKDIR /app
COPY . .

RUN pnpm install --frozen-lockfile
RUN pnpm --filter @autonoma/worker-general run build

ENV NODE_ENV=production
CMD ["pnpm", "--filter", "@autonoma/worker-general", "start"]
