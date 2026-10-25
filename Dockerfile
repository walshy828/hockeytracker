FROM node:24-alpine
WORKDIR /app
COPY package.json server.js ./
COPY public ./public
ENV PORT=3000 DB_PATH=/data/hockey.db NODE_ENV=production
VOLUME /data
EXPOSE 3000
CMD ["node", "--disable-warning=ExperimentalWarning", "server.js"]
