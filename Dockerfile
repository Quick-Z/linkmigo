ARG NODE_IMAGE=node:22-bookworm-slim
ARG TARGETARCH

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

ARG TARGETARCH

ARG APT_MIRROR=
ARG INSTALL_CHROMIUM=1

RUN if [ -n "$APT_MIRROR" ]; then \
      mirror="${APT_MIRROR%/}"; \
      sed -i \
        -e "s|http://deb.debian.org/debian-security|${mirror}/debian-security|g" \
        -e "s|http://deb.debian.org/debian|${mirror}/debian|g" \
        /etc/apt/sources.list.d/debian.sources; \
    fi \
    && sed -i 's/^Suites: bookworm bookworm-updates$/Suites: bookworm/' /etc/apt/sources.list.d/debian.sources \
    && apt-get -o Acquire::Retries=8 -o Acquire::http::Timeout=60 update \
    && if [ "$INSTALL_CHROMIUM" = "1" ]; then \
      apt-get -o Acquire::Retries=8 -o Acquire::http::Timeout=60 install -y --no-install-recommends ca-certificates curl gosu chromium fonts-liberation xvfb xauth; \
    else \
      apt-get -o Acquire::Retries=8 -o Acquire::http::Timeout=60 install -y --no-install-recommends ca-certificates curl gosu \
      && echo "Skipping Chromium install. Set INSTALL_CHROMIUM=1 to include /usr/bin/chromium."; \
    fi \
    && rm -rf /var/lib/apt/lists/*

# Keep YouTube extraction in the maintained yt-dlp project. LinkMigo invokes
# this standalone executable from Node; no Python runtime is required.
RUN set -eux; \
    case "${TARGETARCH}" in \
      amd64) YTDLP_ASSET="yt-dlp_linux" ;; \
      arm64) YTDLP_ASSET="yt-dlp_linux_aarch64" ;; \
      *) echo "Unsupported TARGETARCH: ${TARGETARCH}" >&2; exit 1 ;; \
    esac; \
    curl -fsSL "https://github.com/yt-dlp/yt-dlp/releases/latest/download/${YTDLP_ASSET}" -o /usr/local/bin/yt-dlp; \
    chmod 0755 /usr/local/bin/yt-dlp; \
    /usr/local/bin/yt-dlp --version

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV HOSTNAME=0.0.0.0
ENV PORT=3000
ENV YTDL_NO_DEBUG_FILE=1
ENV YTDLP_PATH=/usr/local/bin/yt-dlp
ENV SOCIAL_CACHE_DIR=/data/social-downloader
ENV CHROME_PATH=/usr/bin/chromium
ENV LINKMIGO_XHS_HEADLESS=0
ENV LINKMIGO_XHS_XVFB=1

RUN mkdir -p /data/social-downloader /app/logs && chown -R node:node /data /app/logs

COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/public ./public
COPY --from=builder /app/node_modules/ffmpeg-static ./node_modules/ffmpeg-static

USER root
EXPOSE 3000

CMD ["sh", "-c", "mkdir -p /data/social-downloader /app/logs && if chown -R node:node /data/social-downloader /app/logs; then exec gosu node node server.js; else echo 'Warning: failed to chown data/log directories; running as root.'; exec node server.js; fi"]
