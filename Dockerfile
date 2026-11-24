FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production PORT=8080 DB_PATH=/app/data/we-eat.sqlite
RUN mkdir -p /app/data && chown node:node /app/data
COPY package.json server.js restaurants.json catalog.json 今天吃什么.html ./
COPY public ./public
USER node
EXPOSE 8080
CMD ["node", "server.js"]
