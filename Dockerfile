FROM node:22-alpine
WORKDIR /questhr
COPY app ./app
COPY server ./server
COPY icons ./icons
COPY docs ./docs
COPY config.json ./config.json
ENV QUESTHR_DATA=/data PORT=8080
VOLUME /data
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s CMD wget -qO- http://localhost:8080/api/health || exit 1
CMD ["node", "server/server.js"]
