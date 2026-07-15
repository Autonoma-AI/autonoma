FROM platformatic/node-caged:25-alpine
WORKDIR /app

# Install pnpm
RUN npm install -g pnpm@10

# Copy package files
COPY package.json pnpm-lock.yaml* ./
COPY scripts ./scripts

# Install dependencies
RUN pnpm install --frozen-lockfile --prod

# Copy workspace dependencies (if built)
COPY node_modules ./node_modules

ENV NODE_ENV=production

# Create non-root user
RUN adduser -D -u 1000 node
USER node

# Default command (can be overridden in k8s)
CMD ["pnpm", "billing-invoicer"]
