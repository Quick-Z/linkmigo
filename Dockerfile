ARG NODE_IMAGE=node:22-bookworm-slim

FROM ${NODE_IMAGE} AS deps
WORKDIR /app
COPY package*.json ./
RUN npm ci

FROM ${NODE_IMAGE} AS builder
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

FROM ${NODE_IMAGE} AS runner
WORKDIR /app

ARG APT_MIRROR=
ARG INSTALL_CHROMIUM=0

RUN if [ "$INSTALL_CHROMIUM" = "1" ]; then \
      if [ -n "$APT_MIRROR" ]; then \
        mirror="${APT_MIRROR%/}"; \
        sed -i \
          -e "s|http://deb.debian.org/debian-security|${mirror}/debian-security|g" \
          -e "s|http://deb.debian.org/debian|${mirror}/debian|g" \
          /etc/apt/sources.list.d/debian.sources; \
      fi \
      && apt-get -o Acquire::Retries=8 -o Acquire::http::Timeout=60 update \
      && apt-get -o Acquire::Retries=8 -o Acquire::http::Timeout=60 install -y --no-install-recommends chromium ca-certificates fonts-liberation \
      && rm -rf /var/lib/apt/lists/*; \
    else \
      echo "Skipping Chromium install. Set INSTALL_CHROMIUM=1 to include /usr/bin/chromium."; \
    fi

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV HOSTNAME=0.0.0.0
ENV PORT=3000
ENV YTDL_NO_DEBUG_FILE=1
ENV SOCIAL_CACHE_DIR=/data/social-downloader

RUN mkdir -p /data/social-downloader /app/logs && chown -R node:node /data /app/logs

COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/public ./public
COPY --from=builder /app/node_modules/ffmpeg-static ./node_modules/ffmpeg-static

USER node
EXPOSE 3000

CMD ["node", "server.js"]
