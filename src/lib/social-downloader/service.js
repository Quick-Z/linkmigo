import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { CacheStore } from "./cache";
import { AppError, ErrorCode } from "./errors";
import { downloadMedia, extensionForAsset } from "./downloader";
import { getSocialDownloaderSettings } from "./settings";
import { normalizeSocialUrl, resolveSocialPost } from "./social";
import { buildZipFile } from "./zip";
import { writeUserActionLog } from "../user-action-logger";

let cacheStore;
const cacheCleanupSchedulerKey = "__linkmigoSocialCacheCleanupScheduler";

export function getCacheStore() {
  const settings = getSocialDownloaderSettings();

  if (
    !cacheStore ||
    cacheStore.root !== settings.cacheRoot ||
    cacheStore.ttlSeconds !== settings.cacheTtlSeconds ||
    cacheStore.maxBytes !== settings.cacheMaxBytes
  ) {
    cacheStore = new CacheStore(
      settings.cacheRoot,
      settings.cacheTtlSeconds,
      settings.cacheMaxBytes,
    );
  }

  startCacheCleanupScheduler(cacheStore, settings);

  return cacheStore;
}

export async function resolveUrl(rawUrl) {
  const settings = getSocialDownloaderSettings();
  const cache = getCacheStore();
  const normalized = normalizeSocialUrl(rawUrl);
  const cached = await cache.findByCanonical(normalized.canonical_url);

  if (cached) {
    return resolveResponse(cached);
  }

  const parsedPost = await resolveSocialPost(normalized, settings);

  if (!parsedPost.assets.length) {
    throw new AppError(ErrorCode.NO_MEDIA_FOUND, "没有在公开页面中发现可下载媒体。", 404);
  }

  const record = await downloadAndCacheAssets({
    settings,
    cache,
    normalized,
    parsedAssets: parsedPost.assets,
    metrics: parsedPost.metrics,
    creatorHandle: parsedPost.creator_handle,
  });

  return resolveResponse(record);
}

export async function getAssetFile({ requestId, assetId }) {
  const cache = getCacheStore();
  const record = await cache.getRecord(requestId);
  const asset = await cache.getAsset(record, assetId);
  const filePath = await cache.assetPath(record, asset);

  return { record, asset, filePath };
}

export async function getZipFile(requestId, options = {}) {
  const cache = getCacheStore();
  const record = await cache.getRecord(requestId);
  const selectedAssetIds = normalizeAssetIds(options.assetIds);
  const selectedAssets = selectRecordAssets(record.assets, selectedAssetIds);
  const recordDir = cache.recordDir(record.request_id, record.platform);
  const zipSuffix = selectedAssetIds.length ? `-selected-${assetSelectionHash(selectedAssetIds)}` : "";
  const zipPath = path.join(recordDir, `${record.platform}-${record.shortcode}${zipSuffix}.zip`);

  if (!(await exists(zipPath))) {
    const entries = [];

    for (const asset of selectedAssets) {
      entries.push({
        name: asset.filename,
        path: await cache.assetPath(record, asset),
      });
    }

    await buildZipFile(entries, zipPath);
  }

  return {
    record,
    assets: selectedAssets,
    filePath: zipPath,
    filename: `${record.platform}-${record.shortcode}${zipSuffix}.zip`,
  };
}

async function downloadAndCacheAssets({ settings, cache, normalized, parsedAssets, metrics, creatorHandle }) {
  const requestId = crypto.randomUUID().replaceAll("-", "");
  const recordDir = cache.recordDir(requestId, normalized.platform);
  const downloadedAssets = [];

  await fs.mkdir(path.join(recordDir, "assets"), { recursive: true });

  try {
    for (let index = 0; index < parsedAssets.length; index += 1) {
      const parsedAsset = parsedAssets[index];
      const assetId = `asset-${index + 1}`;
      let extension = extensionForAsset(parsedAsset);
      let filename = assetFilename(normalized, parsedAsset, index + 1, extension);
      let relativePath = path.join("assets", filename);
      let destination = path.join(recordDir, relativePath);
      let downloaded;

      try {
        downloaded = await downloadMedia({
          asset: parsedAsset,
          destination,
          maxBytes: settings.maxAssetBytes,
          timeoutMs: settings.httpTimeoutMs,
        });
      } catch (error) {
        if (error instanceof AppError) {
          continue;
        }

        throw error;
      }

      const finalExtension = extensionForAsset(parsedAsset, downloaded.contentType);

      if (finalExtension !== extension) {
        const renamed = destination.slice(0, -extension.length) + finalExtension;

        await fs.rename(downloaded.path, renamed);
        extension = finalExtension;
        filename = assetFilename(normalized, parsedAsset, index + 1, extension);
        relativePath = path.join("assets", filename);
        destination = path.join(recordDir, relativePath);
      }

      downloadedAssets.push({
        id: assetId,
        source_url: downloaded.sourceUrl ?? parsedAsset.source_url,
        media_type: parsedAsset.media_type,
        filename,
        content_type: downloaded.contentType,
        size_bytes: downloaded.sizeBytes,
        relative_path: relativePath,
        width: parsedAsset.width ?? null,
        height: parsedAsset.height ?? null,
      });
    }

    if (!downloadedAssets.length) {
      throw new AppError(ErrorCode.DOWNLOAD_FAILED, "发现了媒体地址，但无法下载任何资源。", 502);
    }

    const now = new Date();
    const expiresAt = new Date(now.getTime() + settings.cacheTtlSeconds * 1000);
    const record = {
      request_id: requestId,
      canonical_url: normalized.canonical_url,
      shortcode: normalized.shortcode,
      kind: normalized.kind,
      platform: normalized.platform,
      creator_handle: creatorHandle || "",
      created_at: now.toISOString(),
      expires_at: expiresAt.toISOString(),
      assets: downloadedAssets,
      metrics: metrics ?? createMetrics(),
    };

    await cache.saveRecord(record);

    return record;
  } catch (error) {
    // 项目规则禁止批量删除文件/目录；失败时不自动清理临时缓存目录。
    throw error;
  }
}

function resolveResponse(record) {
  return {
    request_id: record.request_id,
    canonical_url: record.canonical_url,
    shortcode: record.shortcode,
    kind: record.kind,
    platform: record.platform ?? "instagram",
    creator_handle: record.creator_handle || "",
    assets: record.assets.map((asset) => assetResponse(record, asset)),
    metrics: record.metrics ?? createMetrics(),
    expires_at: record.expires_at,
  };
}

function assetResponse(record, asset) {
  const base = `/api/v1/instagram/requests/${record.request_id}/assets/${asset.id}`;

  return {
    id: asset.id,
    media_type: asset.media_type,
    filename: asset.filename,
    content_type: asset.content_type,
    size_bytes: asset.size_bytes,
    width: asset.width ?? null,
    height: asset.height ?? null,
    preview_url: `${base}/preview`,
    download_url: `${base}/download`,
  };
}

function assetFilename(normalized, parsedAsset, index, extension) {
  const rawName =
    parsedAsset.filename_hint ||
    `${normalized.platform}-${normalized.shortcode}-${index}${extension}`;
  let safeName = rawName.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[-._]+|[-._]+$/g, "");

  if (!safeName) {
    safeName = `${normalized.platform}-${normalized.shortcode}-${index}${extension}`;
  }

  if (!path.extname(safeName)) {
    safeName = `${safeName}${extension}`;
  }

  return safeName;
}

async function exists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function normalizeAssetIds(assetIds) {
  if (!Array.isArray(assetIds)) {
    return [];
  }

  return [...new Set(assetIds.map((assetId) => String(assetId).trim()).filter(Boolean))];
}

function selectRecordAssets(assets, selectedAssetIds) {
  if (!selectedAssetIds.length) {
    return assets;
  }

  const assetMap = new Map(assets.map((asset) => [asset.id, asset]));
  const selectedAssets = selectedAssetIds.map((assetId) => assetMap.get(assetId));

  if (selectedAssets.some((asset) => !asset)) {
    throw new AppError(ErrorCode.NO_MEDIA_FOUND, "Selected resources are missing or expired.", 404, {
      selected_asset_ids: selectedAssetIds,
    });
  }

  if (!selectedAssets.length) {
    throw new AppError(ErrorCode.NO_MEDIA_FOUND, "No resources to package.", 404);
  }

  return selectedAssets;
}

function assetSelectionHash(assetIds) {
  return crypto.createHash("sha1").update(assetIds.join(",")).digest("hex").slice(0, 12);
}

function startCacheCleanupScheduler(cache, settings) {
  const intervalMs = settings.cacheCleanupIntervalSeconds * 1000;
  const existing = globalThis[cacheCleanupSchedulerKey];

  if (
    existing?.timer &&
    existing.cacheRoot === settings.cacheRoot &&
    existing.cacheTtlSeconds === settings.cacheTtlSeconds &&
    existing.intervalMs === intervalMs
  ) {
    return;
  }

  if (existing?.timer) {
    clearInterval(existing.timer);
  }

  const state = {
    cacheRoot: settings.cacheRoot,
    cacheTtlSeconds: settings.cacheTtlSeconds,
    intervalMs,
    isRunning: false,
    timer: null,
  };

  async function runCleanup(reason) {
    if (state.isRunning) {
      return;
    }

    state.isRunning = true;

    try {
      const stats = await cache.cleanup();

      if (stats.removedRecords > 0 || stats.failed > 0) {
        await writeUserActionLog({
          action: "cache_cleanup_completed",
          level: stats.failed > 0 ? "error" : "info",
          status: stats.failed > 0 ? "partial_error" : "ok",
          details: {
            reason,
            cache_root: settings.cacheRoot,
            cache_ttl_seconds: settings.cacheTtlSeconds,
            cleanup_interval_seconds: settings.cacheCleanupIntervalSeconds,
            checked: stats.checked,
            removed_records: stats.removedRecords,
            removed_files: stats.removedFiles,
            removed_directories: stats.removedDirectories,
            failed: stats.failed,
            errors: stats.errors,
          },
        });
      }
    } finally {
      state.isRunning = false;
    }
  }

  state.timer = setInterval(() => {
    runCleanup("interval");
  }, intervalMs);
  state.timer.unref?.();

  globalThis[cacheCleanupSchedulerKey] = state;
  queueMicrotask(() => {
    runCleanup("startup");
  });
}

function createMetrics() {
  return {
    like_count: null,
    comment_count: null,
    view_count: null,
    save_count: null,
    share_count: null,
    source: "public_best_effort",
  };
}
