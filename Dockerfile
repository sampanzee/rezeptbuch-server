FROM node:22-alpine
ENV NODE_ENV=production \
    DATA_DIR=/data \
    PORT=8080
WORKDIR /app
COPY server.js index.html sw.js manifest.webmanifest icon-192.png icon-512.png icon-maskable-512.png ./
RUN mkdir -p /data && chown node:node /data
USER node
EXPOSE 8080
VOLUME /data
CMD ["node", "server.js"]
