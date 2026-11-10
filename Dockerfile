FROM node:20-bookworm-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates git tini \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY src ./src
COPY .env.example ./

RUN mkdir -p /app/auth_info_baileys /app/logs \
 && useradd -u 1001 -m bot \
 && chown -R bot:bot /app

USER bot

ENV NODE_ENV=production
ENV LOG_LEVEL=warn

VOLUME ["/app/auth_info_baileys"]

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "src/index.js"]
