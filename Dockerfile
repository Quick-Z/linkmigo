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
# YouTube delivers video and audio as separate streams, so yt-dlp has to merge
# them with ffmpeg. Point the app straight at the bundled static binary: the
# standalone build rewrites ffmpeg-static's __dirname to "/ROOT", so asking the
# module for its path yields /ROOT/node_modules/ffmpeg-static/ffmpeg, and yt-dlp
# would otherwise never receive a usable --ffmpeg-location.
ENV FFMPEG_PATH=/app/node_modules/ffmpeg-static/ffmpeg

RUN mkdir -p /data/social-downloader /app/logs && chown -R node:node /data /app/logs

COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/public ./public
COPY --from=builder /app/node_modules/ffmpeg-static ./node_modules/ffmpeg-static

# Merging YouTube's separate video and audio streams needs this binary, and the
# app now points FFMPEG_PATH straight at it because the standalone build rewrites
# ffmpeg-static's __dirname, so the module cannot report its own path. Verify the
# binary actually runs: without a working ffmpeg yt-dlp downloads the streams
# separately, skips the merge and STILL EXITS 0, which reaches the user as
# "yt-dlp 未生成下载文件" with an empty stderr.
RUN set -eux; \
    if [ ! -x /app/node_modules/ffmpeg-static/ffmpeg ]; then \
      echo "ERROR: no ffmpeg binary at /app/node_modules/ffmpeg-static/ffmpeg." >&2; \
      echo "       YouTube needs it to merge the separate video and audio streams." >&2; \
      echo "       Most likely 'npm ci' ran with --ignore-scripts, or the binary was" >&2; \
      echo "       not copied out of the builder stage." >&2; \
      exit 1; \
    fi; \
    /app/node_modules/ffmpeg-static/ffmpeg -version > /dev/null; \
    /app/node_modules/ffmpeg-static/ffmpeg -version | head -n 1

USER root
EXPOSE 3000

CMD ["sh", "-c", "mkdir -p /data/social-downloader /app/logs && if chown -R node:node /data/social-downloader /app/logs; then exec gosu node node server.js; else echo 'Warning: failed to chown data/log directories; running as root.'; exec node server.js; fi"]
