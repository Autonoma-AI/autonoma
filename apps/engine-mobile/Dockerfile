FROM node:24-alpine
WORKDIR /app
COPY . .
RUN npm install --os=linux --libc=musl --cpu=arm64 sharp && npm install webdriverio

ENV NODE_ENV=production
USER node
EXPOSE 4000
CMD ["node", "--enable-source-maps", "dist/index.js"]
