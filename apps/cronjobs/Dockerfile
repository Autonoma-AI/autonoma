FROM node:24-slim

RUN corepack enable

WORKDIR /app
COPY . .

RUN pnpm install --frozen-lockfile

ENV NODE_ENV=production

# Overridden per-job by the CronJob manifest's `command:` (billing-invoicer or
# usage-reporter) - this default only matters if the image is run directly.
CMD ["pnpm", "--filter", "@autonoma/cronjobs", "run", "billing-invoicer"]
