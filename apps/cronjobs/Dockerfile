FROM node:24-alpine

RUN corepack enable
RUN apk add --no-cache openssl

WORKDIR /app
COPY . .

RUN pnpm install --frozen-lockfile

ENV NODE_ENV=production
USER node

# The caller selects the job by overriding this command.
CMD ["pnpm", "--filter", "@autonoma/cronjobs", "run"]
