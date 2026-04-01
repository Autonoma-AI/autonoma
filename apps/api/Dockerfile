FROM node:24-alpine
WORKDIR /app
COPY . .
RUN npm install sharp

ENV NODE_ENV=production
USER node
EXPOSE 4000
CMD ["node", "--enable-source-maps", "dist/index.js"]
