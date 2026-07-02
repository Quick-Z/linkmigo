FROM node:22-bookworm-slim AS deps
WORKDIR /app
COPY package*.json ./
RUN npm ci

FROM node:22-bookworm-slim AS builder
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

FROM node:22-bookworm-slim AS runner
WORKDIR /app

RUN sed -i \
    -e 's|http://deb.debian.org/debian-security|http://mirrors.ustc.edu.cn/debian-security|g' \
    -e 's|http://deb.debian.org/debian|http://mirrors.ustc.edu.cn/debian|g' \
    /etc/apt/sources.list.d/debian.sources \
  && apt-get -o Acquire::Retries=8 -o Acquire::http::Timeout=60 update \
  && apt-get -o Acquire::Retries=8 -o Acquire::http::Timeout=60 install -y --no-install-recommends chromium ca-certificates fonts-liberation \
  && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV HOSTNAME=0.0.0.0
ENV PORT=3000
ENV YTDL_NO_DEBUG_FILE=1
ENV SOCIAL_CACHE_DIR=/data/social-downloader
ENV CHROME_PATH=/usr/bin/chromium

RUN mkdir -p /data/social-downloader /app/logs && chown -R node:node /data /app/logs

COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/public ./public
COPY --from=builder /app/node_modules/ffmpeg-static ./node_modules/ffmpeg-static

USER node
EXPOSE 3000

CMD ["node", "server.js"]
