# --- Stage 1: bundle the cronjob scripts ---------------------------------------
FROM node:24-alpine AS builder

RUN corepack enable

WORKDIR /app
COPY . .

RUN pnpm install --frozen-lockfile
RUN pnpm --filter @autonoma/cronjobs build

# --- Stage 2: runtime ------------------------------------------------------------
FROM node:24-alpine

RUN apk add --no-cache openssl

WORKDIR /app
COPY --from=builder /app/apps/cronjobs/dist ./dist

ENV NODE_ENV=production
USER node

# The caller selects the job by overriding this command, e.g.
# ["node", "--enable-source-maps", "dist/billing-invoicer.js"].
CMD ["node", "--enable-source-maps", "dist/billing-invoicer.js"]
