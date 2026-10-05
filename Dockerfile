FROM node:24-alpine

WORKDIR /app
ENV NODE_ENV=production \
    PORT=8080 \
    DB_PATH=/data/kanban.db

# No npm dependencies: the server uses only Node built-ins (http, sqlite).
# git is used read-only, for projects that set repo_path.
RUN apk add --no-cache git
COPY package.json ./
COPY src ./src
COPY public ./public
COPY docs ./docs

RUN mkdir -p /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD wget -qO- http://127.0.0.1:8080/api/health >/dev/null || exit 1

CMD ["node", "--disable-warning=ExperimentalWarning", "src/index.js"]
