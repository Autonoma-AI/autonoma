FROM node:24-alpine
WORKDIR /app
COPY . .

# @workflow/core does require(process.env.WORKFLOW_TARGET_WORLD) at runtime.
# This dynamic CJS require cannot be bundled by Nitro so the package must be
# present on disk in the container.
RUN npm install --no-save @workflow/world-postgres@4.1.0-beta.49

ENV NODE_ENV=production
USER node
EXPOSE 4000
CMD ["node", "--enable-source-maps", ".output/server/index.mjs"]
