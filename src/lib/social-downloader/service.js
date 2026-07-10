import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { CacheStore } from "./cache";
import { AppError, ErrorCode } from "./errors";
import { downloadMedia, estimateMediaDownloadSize, extensionForAsset } from "./downloader";
import { resolveInstagramProfile, resolveInstagramProfilePostsPage } from "./instagram";
import { getSocialDownloaderSettings } from "./settings";
import { createPostInfo } from "./post-info";
import { normalizeSocialUrl, resolveSocialPost } from "./social";
import { safeFilenamePart } from "./shared";
import { buildZipFile } from "./zip";
import { writeUserActionLog } from "../user-action-logger";

let cacheStore;
const cacheCleanupSchedulerKey = "__linkmigoSocialCacheCleanupScheduler";
const mediaCacheVersion = 37;
const profileCacheVersion = 10;
const profileInitialPostsPageSize = 30;
const profileMaxPostsPageSize = 60;
let sharpFactoryPromise = null;

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

  let cached = await cache.findByCanonical(normalized.canonical_url);

  if (normalized.platform === "instagram" && normalized.mode === "profile") {
    if (cached && isUsableCachedProfileRecord(cached, normalized)) {
      cached = await cache.touchRecord(cached);

      onProgress?.({
        phase: "completed",
        downloaded_bytes: 0,
        total_bytes: null,
        asset_index: cached.posts?.length ?? 0,
        asset_count: cached.posts?.length ?? 0,
      });

      return resolveProfileResponse(cached);
    }

    const parsedProfile = await resolveInstagramProfile(normalized, settings);
    const profileRecord = await saveProfileRecord({
      cache,
      normalized,
      parsedProfile,
      settings,
    });

    onProgress?.({
      phase: "completed",
      downloaded_bytes: 0,
      total_bytes: null,
      asset_index: profileRecord.posts.length,
      asset_count: profileRecord.posts.length,
    });

    return resolveProfileResponse(profileRecord);
  }

  if (cached && isUsableCachedRecord(cached, normalized)) {
    cached = await cache.touchRecord(cached);

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

export async function getProfileZipFile(requestId, options = {}) {
  const cache = getCacheStore();
  const settings = getSocialDownloaderSettings();
  const profileRecord = await cache.getRecord(requestId);

  if (!isUsableCachedProfileRecord(profileRecord)) {
    throw new AppError(ErrorCode.CACHE_EXPIRED, "主页帖子列表缓存不存在或已过期。", 404);
  }

  const selectedPostIds = normalizeAssetIds(options.postIds);
  const selectedPosts = selectProfilePosts(profileRecord.posts, selectedPostIds);
  const recordDir = cache.recordDir(profileRecord.request_id, profileRecord.platform);
  const zipSuffix = selectedPostIds.length ? `-selected-${assetSelectionHash(selectedPostIds)}` : "";
  const filenameBase = safeFilenamePart(profileRecord.creator_handle || profileRecord.profile?.username || "instagram-profile");
  const zipPath = path.join(recordDir, `${filenameBase}${zipSuffix}.zip`);

  if (!(await exists(zipPath))) {
    const entries = [];
    const postEntryResults = new Array(selectedPosts.length);
    const postTasks = selectedPosts.map((post, postIndex) => async () => {
      const resolved = await resolveUrl(post.canonical_url);

      if (!resolved?.request_id || resolved?.mode === "profile") {
        postEntryResults[postIndex] = [];
        return;
      }

      const postRecord = await cache.getRecord(resolved.request_id);
      const postFolder = profileZipPostFolderName(postIndex, post);
      const postEntries = [];

      for (const asset of postRecord.assets) {
        postEntries.push({
          name: `${filenameBase}/${postFolder}/${asset.filename}`,
          path: await cache.assetPath(postRecord, asset),
        });
      }

      postEntryResults[postIndex] = postEntries;
    });

    await runConcurrent(postTasks, settings.profileZipConcurrency);
    entries.push(...postEntryResults.flat().filter(Boolean));

    if (!entries.length) {
      throw new AppError(ErrorCode.DOWNLOAD_FAILED, "选中的帖子暂时无法打包，请稍后重试。", 502);
    }

    await buildZipFile(entries, zipPath);
  }

  return {
    record: profileRecord,
    posts: selectedPosts,
    filePath: zipPath,
    filename: `${filenameBase}${zipSuffix}.zip`,
  };
}

export async function getProfilePostsPage(requestId, options = {}) {
  const cache = getCacheStore();
  const settings = getSocialDownloaderSettings();
  const profileRecord = await cache.getRecord(requestId);

  if (!isUsableCachedProfileRecord(profileRecord)) {
    throw new AppError(ErrorCode.CACHE_EXPIRED, "主页帖子列表缓存不存在或已过期。", 404);
  }

  const cachedPage = profilePostsPage(profileRecord, {
    cursor: options.cursor,
    limit: options.limit,
  });

  if (cachedPage.posts.length > 0 || !cachedPage.page.needs_live_fetch) {
    return cachedPage;
  }

  const livePage = await resolveInstagramProfilePostsPage(
    {
      cursor: cachedPage.page.live_cursor,
      creatorHandle: profileRecord.creator_handle || profileRecord.profile?.username,
      userId: profileRecord.profile_pagination?.user_id || profileRecord.profile?.user_id,
      initialShortcodes: profileRecord.posts.map((post) => post.shortcode),
      limit: clampProfilePostsLimit(options.limit),
    },
    settings,
  );
  const livePosts = normalizeProfilePostsForCache(livePage.posts);
  const updatedRecord = {
    ...profileRecord,
    posts: mergeProfilePostsForCache(profileRecord.posts, livePosts),
    profile_pagination: {
      ...(profileRecord.profile_pagination || {}),
      source: "instagram_mobile_feed",
      user_id: livePage.user_id || profileRecord.profile_pagination?.user_id || profileRecord.profile?.user_id || "",
      next_cursor: livePage.next_cursor || "",
      has_more: Boolean(livePage.has_more && livePage.next_cursor),
    },
  };

  await cache.saveRecord(updatedRecord);

  return profilePostsPage(updatedRecord, {
    cursor: String(profileRecord.posts.length),
    limit: options.limit,
  });
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
    const downloadedAssetResults = new Array(parsedAssets.length);
    let completedAssets = 0;
    const downloadTasks = parsedAssets.map((parsedAsset, index) => async () => {
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
          return;
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

      const measuredDimensions = await probeAssetDimensions(destination, parsedAsset.media_type);

      downloadedAssetResults[index] = {
        id: assetId,
        source_url: downloaded.sourceUrl ?? parsedAsset.source_url,
        media_type: parsedAsset.media_type,
        filename,
        content_type: downloaded.contentType,
        size_bytes: downloaded.sizeBytes,
        relative_path: relativePath,
        width: measuredDimensions?.width ?? parsedAsset.width ?? null,
        height: measuredDimensions?.height ?? parsedAsset.height ?? null,
      };
      completedAssets += 1;

      emitDownloadProgress({
        onProgress,
        progressParts,
        estimatedTotalBytes,
        phase: "downloading",
        assetIndex: completedAssets,
        assetCount: parsedAssets.length,
      });
    });

    await runConcurrent(downloadTasks, settings.assetDownloadConcurrency);
    downloadedAssets.push(...downloadedAssetResults.filter(Boolean));

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

async function runConcurrent(tasks, concurrency) {
  const limit = Math.max(1, Math.min(tasks.length || 1, Number(concurrency) || 1));
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < tasks.length) {
      const task = tasks[nextIndex];

      nextIndex += 1;
      await task();
    }
  }

  await Promise.all(Array.from({ length: limit }, worker));
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
  if (record?.record_type === "instagram_profile") {
    return false;
  }

  if (!record.post_info || typeof record.post_info !== "object") {
    return false;
  }

  return Number(record.media_version || 0) >= mediaCacheVersion;
}

function isUsableCachedProfileRecord(record, normalized = null) {
  if (!record || record.record_type !== "instagram_profile") {
    return false;
  }

  if (!record.profile || typeof record.profile !== "object" || !Array.isArray(record.posts)) {
    return false;
  }

  if (normalized?.canonical_url && record.canonical_url !== normalized.canonical_url) {
    return false;
  }

  return Number(record.profile_cache_version || 0) >= profileCacheVersion;
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

function resolveProfileResponse(record) {
  const page = profilePostsPage(record, {
    limit: profileInitialPostsPageSize,
  });

  return {
    mode: "profile",
    request_id: record.request_id,
    canonical_url: record.canonical_url,
    shortcode: "",
    kind: "profile",
    platform: "instagram",
    creator_handle: record.creator_handle || record.profile?.username || "",
    profile: record.profile,
    posts: page.posts,
    profile_posts_page: page.page,
    expires_at: record.expires_at,
  };
}

function profilePostsPage(record, options = {}) {
  const safePosts = Array.isArray(record?.posts) ? record.posts : [];
  const cursor = parseProfilePostsCursor(options.cursor);
  const start = cursor.type === "offset" ? cursor.offset : safePosts.length;
  const limit = clampProfilePostsLimit(options.limit);
  const end = Math.min(safePosts.length, start + limit);
  const pagePosts = safePosts.slice(start, end);
  const hasCachedMore = end < safePosts.length;
  const liveCursor = cursor.type === "live"
    ? cursor.value
    : start >= safePosts.length
      ? record?.profile_pagination?.next_cursor || ""
      : "";
  const hasLiveMore = Boolean(record?.profile_pagination?.has_more && (record?.profile_pagination?.next_cursor || cursor.type === "live"));
  const paginationSource = String(record?.profile_pagination?.source || "");
  const isSnapshotSource = paginationSource !== "instagram_mobile_feed";
  const knownPostCount = Number(record?.profile?.post_count) || 0;
  const snapshotIsPartial = !hasCachedMore && !hasLiveMore && (
    knownPostCount > safePosts.length ||
    (isSnapshotSource && safePosts.length > 0)
  );
  const canTryLiveFromSnapshot = Boolean(
    snapshotIsPartial &&
    isSnapshotSource &&
    (record?.profile_pagination?.user_id || record?.profile?.user_id),
  );
  const shouldTryLiveFromSnapshot = canTryLiveFromSnapshot && pagePosts.length === 0 && !hasCachedMore;
  const needsLiveFetch = pagePosts.length === 0 && !hasCachedMore && (
    (hasLiveMore && liveCursor) ||
    shouldTryLiveFromSnapshot
  );
  const liveNextCursor = hasLiveMore && record?.profile_pagination?.next_cursor
    ? `live:${record.profile_pagination.next_cursor}`
    : canTryLiveFromSnapshot
      ? "live:"
      : null;

  return {
    posts: pagePosts,
    page: {
      total_count: Math.max(Number(record?.profile?.post_count) || 0, safePosts.length),
      loaded_count: end,
      next_cursor: hasCachedMore
        ? String(end)
        : liveNextCursor,
      has_more: hasCachedMore || hasLiveMore || canTryLiveFromSnapshot,
      is_partial_snapshot: snapshotIsPartial,
      needs_live_fetch: Boolean(needsLiveFetch),
      live_cursor: liveCursor,
    },
  };
}

function parseProfilePostsCursor(value) {
  const rawValue = String(value ?? "").trim();

  if (rawValue.startsWith("live:")) {
    return {
      type: "live",
      value: rawValue.slice(5),
      offset: 0,
    };
  }

  const parsed = Number.parseInt(rawValue, 10);

  return {
    type: "offset",
    value: "",
    offset: Number.isFinite(parsed) && parsed > 0 ? parsed : 0,
  };
}

function clampProfilePostsLimit(value) {
  const parsed = Number.parseInt(String(value ?? ""), 10);

  if (!Number.isFinite(parsed) || parsed <= 0) {
    return profileInitialPostsPageSize;
  }

  return Math.min(profileMaxPostsPageSize, parsed);
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
  const fallbackName = `${normalized.platform}-${normalized.shortcode}-${index}${extension}`;
  const rawName =
    parsedAsset.filename_hint ||
    fallbackName;
  let safeName = sanitizeAssetFilename(rawName);

  if (!safeName) {
    safeName = fallbackName;
  }

  if (!path.extname(safeName)) {
    safeName = `${safeName}${extension}`;
  }

  return safeName;
}

function sanitizeAssetFilename(value) {
  return String(value || "")
    .normalize("NFC")
    .replace(/[<>:"/\\|?*\x00-\x1F]+/g, "-")
    .replace(/\s+/g, " ")
    .replace(/-+/g, "-")
    .replace(/^[\s._-]+|[\s._-]+$/g, "");
}

async function probeAssetDimensions(filePath, mediaType) {
  if (!["image", "video"].includes(mediaType)) {
    return null;
  }

  try {
    const sharp = await getSharp();
    const metadata = await sharp(filePath, { animated: false }).metadata();

    if (Number.isFinite(metadata.width) && Number.isFinite(metadata.height)) {
      return {
        width: Math.trunc(metadata.width),
        height: Math.trunc(metadata.height),
      };
    }
  } catch {
    // Best-effort only; keep source metadata when probing fails.
  }

  return null;
}

async function getSharp() {
  if (!sharpFactoryPromise) {
    sharpFactoryPromise = import("sharp").then((module) => module.default ?? module);
  }

  return await sharpFactoryPromise;
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

function selectProfilePosts(posts, selectedPostIds) {
  if (!Array.isArray(posts) || posts.length === 0) {
    throw new AppError(ErrorCode.NO_MEDIA_FOUND, "主页里没有可下载的帖子。", 404);
  }

  if (!selectedPostIds.length) {
    return posts;
  }

  const postMap = new Map(posts.map((post) => [post.id, post]));
  const selectedPosts = selectedPostIds.map((postId) => postMap.get(postId));

  if (selectedPosts.some((post) => !post)) {
    throw new AppError(ErrorCode.NO_MEDIA_FOUND, "选中的帖子不存在或已过期。", 404, {
      selected_post_ids: selectedPostIds,
    });
  }

  return selectedPosts;
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

async function saveProfileRecord({ cache, normalized, parsedProfile, settings }) {
  const requestId = crypto.randomUUID().replaceAll("-", "");
  const now = new Date();
  const expiresAt = new Date(now.getTime() + settings.cacheTtlSeconds * 1000);
  const creatorHandle = parsedProfile.creator_handle || parsedProfile.profile?.username || normalized.creator_handle || "";
  const profile = normalizeProfileForCache(parsedProfile.profile, creatorHandle);
  const posts = normalizeProfilePostsForCache(parsedProfile.posts);
  const record = {
    request_id: requestId,
    record_type: "instagram_profile",
    profile_cache_version: profileCacheVersion,
    canonical_url: normalized.canonical_url,
    shortcode: "",
    kind: "profile",
    platform: normalized.platform,
    creator_handle: creatorHandle,
    created_at: now.toISOString(),
    expires_at: expiresAt.toISOString(),
    assets: [],
    metrics: createMetrics(),
    post_info: createPostInfo(
      {
        title: profile.full_name || (profile.username ? `@${profile.username}` : "Instagram profile"),
        author: profile.full_name || creatorHandle,
        author_handle: creatorHandle,
        body: profile.biography,
      },
      {
        creatorHandle,
      },
    ),
    profile,
    posts,
    profile_pagination: normalizeProfilePaginationForCache(parsedProfile.profile_pagination, profile),
  };

  await cache.saveRecord(record);

  return record;
}

function normalizeProfileForCache(profile, creatorHandle) {
  const safeProfile = profile && typeof profile === "object" ? profile : {};

  return {
    username: String(safeProfile.username || creatorHandle || "").trim(),
    full_name: String(safeProfile.full_name || "").trim(),
    biography: String(safeProfile.biography || "").trim(),
    avatar_url: String(safeProfile.avatar_url || "").trim(),
    post_count: positiveIntegerOrNull(safeProfile.post_count),
    follower_count: positiveIntegerOrNull(safeProfile.follower_count),
    following_count: positiveIntegerOrNull(safeProfile.following_count),
    is_private: Boolean(safeProfile.is_private),
    is_verified: Boolean(safeProfile.is_verified),
    user_id: String(safeProfile.user_id || "").trim(),
  };
}

function normalizeProfilePostsForCache(posts) {
  return Array.isArray(posts)
    ? posts
      .map((post) => normalizeProfilePostForCache(post))
      .filter(Boolean)
    : [];
}

function normalizeProfilePaginationForCache(pagination, profile = {}) {
  const safePagination = pagination && typeof pagination === "object" ? pagination : {};

  return {
    source: String(safePagination.source || "instagram_public_snapshot"),
    user_id: String(safePagination.user_id || profile.user_id || "").trim(),
    next_cursor: String(safePagination.next_cursor || "").trim(),
    has_more: Boolean(safePagination.has_more && safePagination.next_cursor),
  };
}

function mergeProfilePostsForCache(currentPosts, nextPosts) {
  const merged = [];
  const seen = new Set();

  for (const post of [...normalizeProfilePostsForCache(currentPosts), ...normalizeProfilePostsForCache(nextPosts)]) {
    if (!post.shortcode || seen.has(post.shortcode)) {
      continue;
    }

    seen.add(post.shortcode);
    merged.push(post);
  }

  return merged;
}

function normalizeProfilePostForCache(post) {
  if (!post || typeof post !== "object" || !post.id || !post.shortcode || !post.canonical_url) {
    return null;
  }

  return {
    id: String(post.id),
    shortcode: String(post.shortcode),
    canonical_url: String(post.canonical_url),
    kind: String(post.kind || "p"),
    media_type: String(post.media_type || "image"),
    preview_url: String(post.preview_url || ""),
    preview_width: positiveIntegerOrNull(post.preview_width),
    preview_height: positiveIntegerOrNull(post.preview_height),
    taken_at: String(post.taken_at || ""),
    metrics: normalizeMetrics(post.metrics),
    post_info: createPostInfo(post.post_info, {
      metrics: normalizeMetrics(post.metrics),
      creatorHandle: post.post_info?.author_handle || "",
    }),
  };
}

function normalizeMetrics(metrics) {
  const value = metrics && typeof metrics === "object" ? metrics : {};

  return {
    like_count: positiveIntegerOrNull(value.like_count),
    comment_count: positiveIntegerOrNull(value.comment_count),
    view_count: positiveIntegerOrNull(value.view_count),
    save_count: positiveIntegerOrNull(value.save_count),
    share_count: positiveIntegerOrNull(value.share_count),
    source: String(value.source || "public_best_effort"),
  };
}

function positiveIntegerOrNull(value) {
  const parsed = Number.parseInt(String(value ?? ""), 10);

  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function profileZipPostFolderName(postIndex, post) {
  const datePart = String(post?.taken_at || "").slice(0, 10) || "undated";
  const kind = safeFilenamePart(post?.kind || "post");
  const shortcode = safeFilenamePart(post?.shortcode || `post-${postIndex + 1}`);
  const title = safeFilenamePart(post?.post_info?.title || post?.post_info?.body || "");
  const titleSuffix = title ? `-${title.slice(0, 48)}` : "";

  return `${String(postIndex + 1).padStart(3, "0")}-${datePart}-${kind}-${shortcode}${titleSuffix}`;
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
