FROM node:24-slim
RUN apt-get update && apt-get install -y --no-install-recommends git ripgrep ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY . .
RUN npm install sharp

ENV NODE_ENV=production
USER node
RUN git config --global --add safe.directory /tmp/repo
CMD ["node", "dist/index.js"]
