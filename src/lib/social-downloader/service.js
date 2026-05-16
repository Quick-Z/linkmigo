import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { CacheStore } from "./cache";
import { AppError, ErrorCode } from "./errors";
import { downloadMedia, estimateMediaDownloadSize, extensionForAsset } from "./downloader";
import { getSocialDownloaderSettings } from "./settings";
import { createPostInfo } from "./post-info";
import { normalizeSocialUrl, resolveSocialPost } from "./social";
import { buildZipFile } from "./zip";
import { writeUserActionLog } from "../user-action-logger";

let cacheStore;
const cacheCleanupSchedulerKey = "__linkmigoSocialCacheCleanupScheduler";
const mediaCacheVersion = 18;

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

export async function resolveUrl(rawUrl, options = {}) {
  const onProgress = typeof options.onProgress === "function" ? options.onProgress : null;
  const settings = getSocialDownloaderSettings();
  const cache = getCacheStore();
  const normalized = normalizeSocialUrl(rawUrl);

  onProgress?.({
    phase: "resolving",
    downloaded_bytes: 0,
    total_bytes: null,
    asset_index: null,
    asset_count: null,
  });

  const cached = await cache.findByCanonical(normalized.canonical_url);

  if (cached && isUsableCachedRecord(cached, normalized)) {
    onProgress?.({
      phase: "completed",
      downloaded_bytes: cached.assets.reduce((sum, asset) => sum + (asset.size_bytes || 0), 0),
      total_bytes: cached.assets.reduce((sum, asset) => sum + (asset.size_bytes || 0), 0),
      asset_index: cached.assets.length,
      asset_count: cached.assets.length,
    });

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
    postInfo: parsedPost.post_info,
    onProgress,
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

async function downloadAndCacheAssets({ settings, cache, normalized, parsedAssets, metrics, creatorHandle, postInfo, onProgress }) {
  const requestId = crypto.randomUUID().replaceAll("-", "");
  const recordDir = cache.recordDir(requestId, normalized.platform);
  const downloadedAssets = [];
  let lastDownloadError = null;
  const progressParts = new Map();

  onProgress?.({
    phase: "preparing_download",
    downloaded_bytes: 0,
    total_bytes: null,
    asset_index: null,
    asset_count: parsedAssets.length,
  });

  const estimatedTotalBytes = onProgress
    ? await estimateTotalDownloadBytes(parsedAssets, settings)
    : null;

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

      emitDownloadProgress({
        onProgress,
        progressParts,
        estimatedTotalBytes,
        phase: "downloading",
        assetIndex: index + 1,
        assetCount: parsedAssets.length,
      });

      try {
        downloaded = await downloadMedia({
          asset: parsedAsset,
          destination,
          maxBytes: settings.maxAssetBytes,
          timeoutMs: settings.mediaDownloadTimeoutMs,
          onProgress: (event) => {
            updateDownloadProgressPart({
              event,
              progressParts,
              assetIndex: index + 1,
            });
            emitDownloadProgress({
              onProgress,
              progressParts,
              estimatedTotalBytes,
              phase: "downloading",
              assetIndex: index + 1,
              assetCount: parsedAssets.length,
            });
          },
        });
      } catch (error) {
        if (error instanceof AppError) {
          lastDownloadError = error;
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

      emitDownloadProgress({
        onProgress,
        progressParts,
        estimatedTotalBytes,
        phase: "downloading",
        assetIndex: index + 1,
        assetCount: parsedAssets.length,
      });
    }

    if (!downloadedAssets.length) {
      throw lastDownloadError ?? new AppError(ErrorCode.DOWNLOAD_FAILED, "发现了媒体地址，但无法下载任何资源。", 502);
    }

    const now = new Date();
    const expiresAt = new Date(now.getTime() + settings.cacheTtlSeconds * 1000);
    const normalizedMetrics = metrics ?? createMetrics();
    const record = {
      request_id: requestId,
      media_version: mediaCacheVersion,
      canonical_url: normalized.canonical_url,
      shortcode: normalized.shortcode,
      kind: normalized.kind,
      platform: normalized.platform,
      creator_handle: creatorHandle || "",
      created_at: now.toISOString(),
      expires_at: expiresAt.toISOString(),
      assets: downloadedAssets,
      metrics: normalizedMetrics,
      post_info: createPostInfo(postInfo, {
        metrics: normalizedMetrics,
        creatorHandle,
        source: normalizedMetrics.source,
      }),
    };

    await cache.saveRecord(record);

    onProgress?.({
      phase: "completed",
      downloaded_bytes: downloadedAssets.reduce((sum, asset) => sum + (asset.size_bytes || 0), 0),
      total_bytes: downloadedAssets.reduce((sum, asset) => sum + (asset.size_bytes || 0), 0),
      asset_index: downloadedAssets.length,
      asset_count: downloadedAssets.length,
    });

    return record;
  } catch (error) {
    // 项目规则禁止批量删除文件/目录；失败时不自动清理临时缓存目录。
    throw error;
  }
}

async function estimateTotalDownloadBytes(parsedAssets, settings) {
  let totalBytes = 0;
  let allPartsKnown = true;

  for (const asset of parsedAssets) {
    const estimate = await estimateMediaDownloadSize({
      asset,
      maxBytes: settings.maxAssetBytes,
      timeoutMs: settings.httpTimeoutMs,
    });

    if (estimate.knownParts !== estimate.partCount) {
      allPartsKnown = false;
    }

    if (estimate.totalBytes) {
      totalBytes += estimate.totalBytes;
    }
  }

  return allPartsKnown && totalBytes ? totalBytes : null;
}

function updateDownloadProgressPart({ event, progressParts, assetIndex }) {
  if (!event || !event.part_id) {
    return;
  }

  const partKey = `${assetIndex}:${event.part_id}`;
  const existing = progressParts.get(partKey) ?? {
    contentLength: null,
    downloadedBytes: 0,
  };
  const contentLength = event.content_length || existing.contentLength;
  const downloadedBytes = Math.max(0, event.downloaded_bytes || 0);

  progressParts.set(partKey, {
    contentLength,
    downloadedBytes,
  });
}

function emitDownloadProgress({
  onProgress,
  progressParts,
  estimatedTotalBytes,
  phase,
  assetIndex,
  assetCount,
}) {
  if (!onProgress) {
    return;
  }

  const downloadedBytes = [...progressParts.values()]
    .reduce((sum, part) => sum + (part.downloadedBytes || 0), 0);
  const knownTotalBytes = [...progressParts.values()]
    .reduce((sum, part) => sum + (part.contentLength || 0), 0);
  const totalBytes = estimatedTotalBytes || knownTotalBytes || null;

  onProgress({
    phase,
    downloaded_bytes: downloadedBytes,
    total_bytes: totalBytes,
    asset_index: assetIndex,
    asset_count: assetCount,
  });
}

function isUsableCachedRecord(record, normalized) {
  if (!record.post_info || typeof record.post_info !== "object") {
    return false;
  }

  return Number(record.media_version || 0) >= mediaCacheVersion;
}

function resolveResponse(record) {
  const metrics = record.metrics ?? createMetrics();
  const creatorHandle = record.creator_handle || "";

  return {
    request_id: record.request_id,
    canonical_url: record.canonical_url,
    shortcode: record.shortcode,
    kind: record.kind,
    platform: record.platform ?? "instagram",
    creator_handle: creatorHandle,
    assets: record.assets.map((asset) => assetResponse(record, asset)),
    metrics,
    post_info: createPostInfo(record.post_info, {
      metrics,
      creatorHandle,
      source: metrics.source,
    }),
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
