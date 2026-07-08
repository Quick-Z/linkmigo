import path from "node:path";

const DEFAULT_CACHE_TTL_SECONDS = 2 * 60 * 60;
const DEFAULT_MAX_ASSET_BYTES = 10 * 1024 * 1024 * 1024;

function intEnv(name, fallback) {
  const raw = process.env[name]?.trim();

  if (!raw) {
    return fallback;
  }

  const value = Number.parseInt(raw, 10);

  return Number.isFinite(value) ? value : fallback;
}

function floatEnv(name, fallback) {
  const raw = process.env[name]?.trim();

  if (!raw) {
    return fallback;
  }

  const value = Number.parseFloat(raw);

  return Number.isFinite(value) ? value : fallback;
}

export function getSocialDownloaderSettings() {
  const configuredCacheRoot =
    process.env.SOCIAL_CACHE_DIR?.trim() ||
    process.env.IG_CACHE_DIR?.trim() ||
    path.join(".cache", "social-downloader");
  const cacheRoot = path.isAbsolute(configuredCacheRoot)
    ? configuredCacheRoot
    : path.join(/*turbopackIgnore: true*/ process.cwd(), configuredCacheRoot);

  return {
    cacheRoot,
    cacheTtlSeconds: positiveIntEnv(
      "SOCIAL_CACHE_TTL_SECONDS",
      positiveIntEnv("IG_CACHE_TTL_SECONDS", DEFAULT_CACHE_TTL_SECONDS),
    ),
    cacheCleanupIntervalSeconds: positiveIntEnv(
      "SOCIAL_CACHE_CLEANUP_INTERVAL_SECONDS",
      positiveIntEnv("IG_CACHE_CLEANUP_INTERVAL_SECONDS", 5 * 60),
    ),
    cacheMaxBytes: intEnv("IG_CACHE_MAX_BYTES", 2 * 1024 * 1024 * 1024),
    httpTimeoutMs: Math.max(1, floatEnv("IG_HTTP_TIMEOUT_SECONDS", 20)) * 1000,
    mediaDownloadTimeoutMs: Math.max(
      1,
      floatEnv(
        "SOCIAL_MEDIA_TIMEOUT_SECONDS",
        floatEnv("IG_MEDIA_TIMEOUT_SECONDS", 10 * 60),
      ),
    ) * 1000,
    resolveConcurrency: positiveIntEnv(
      "SOCIAL_RESOLVE_CONCURRENCY",
      positiveIntEnv("IG_RESOLVE_CONCURRENCY", 4),
    ),
    xiaohongshuResolveConcurrency: positiveIntEnv(
      "SOCIAL_XIAOHONGSHU_RESOLVE_CONCURRENCY",
      positiveIntEnv("SOCIAL_XHS_RESOLVE_CONCURRENCY", 1),
    ),
    assetDownloadConcurrency: positiveIntEnv(
      "SOCIAL_ASSET_DOWNLOAD_CONCURRENCY",
      positiveIntEnv("IG_ASSET_DOWNLOAD_CONCURRENCY", 1),
    ),
    profileZipConcurrency: positiveIntEnv(
      "SOCIAL_PROFILE_ZIP_CONCURRENCY",
      positiveIntEnv("IG_PROFILE_ZIP_CONCURRENCY", 1),
    ),
    maxAssetBytes: intEnv(
      "SOCIAL_MAX_ASSET_BYTES",
      intEnv("IG_MAX_ASSET_BYTES", DEFAULT_MAX_ASSET_BYTES),
    ),
    publicBaseUrl: stringEnv("SOCIAL_PUBLIC_BASE_URL", stringEnv("LINKMIGO_PUBLIC_BASE_URL", "")),
    instagramCookie: stringEnv(
      "SOCIAL_INSTAGRAM_COOKIE",
      stringEnv("IG_COOKIE", stringEnv("INSTAGRAM_COOKIE", "")),
    ),
    xiaohongshuCookie: stringEnv(
      "SOCIAL_XIAOHONGSHU_COOKIE",
      stringEnv(
        "SOCIAL_XHS_COOKIE",
        stringEnv("XIAOHONGSHU_COOKIE", stringEnv("XHS_COOKIE", "")),
      ),
    ),
    redditClientId: stringEnv("SOCIAL_REDDIT_CLIENT_ID", stringEnv("REDDIT_CLIENT_ID", "")),
    redditClientSecret: stringEnv("SOCIAL_REDDIT_CLIENT_SECRET", stringEnv("REDDIT_CLIENT_SECRET", "")),
    redditRefreshToken: stringEnv("SOCIAL_REDDIT_REFRESH_TOKEN", stringEnv("REDDIT_REFRESH_TOKEN", "")),
    redditUserAgent: stringEnv(
      "SOCIAL_REDDIT_USER_AGENT",
      stringEnv("REDDIT_USER_AGENT", "web:linkmigo:0.1.0 (by /u/linkmigo_user)"),
    ),
    v2exToken: stringEnv("SOCIAL_V2EX_TOKEN", stringEnv("V2EX_TOKEN", "")),
  };
}

function positiveIntEnv(name, fallback) {
  return Math.max(1, intEnv(name, fallback));
}

function stringEnv(name, fallback) {
  const raw = process.env[name]?.trim();

  return raw || fallback;
}
