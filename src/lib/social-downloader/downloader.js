import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { URL } from "node:url";

import { AppError, ErrorCode } from "./errors";
import { fetchWithTimeout } from "./utils";

const require = createRequire(import.meta.url);
const packagedFfmpegPath = require("ffmpeg-static");

const MEDIA_HEADERS = {
  "user-agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
  accept: "image/avif,image/webp,image/apng,image/*,video/*,*/*;q=0.8",
  "accept-language": "en-US,en;q=0.9",
};

const EXTENSION_CONTENT_TYPES = {
  ".aac": "audio/aac",
  ".avif": "image/avif",
  ".flac": "audio/flac",
  ".gif": "image/gif",
  ".heic": "image/heic",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".m4a": "audio/mp4",
  ".m4v": "video/mp4",
  ".mov": "video/quicktime",
  ".mp3": "audio/mpeg",
  ".mp4": "video/mp4",
  ".ogg": "audio/ogg",
  ".png": "image/png",
  ".txt": "text/plain; charset=utf-8",
  ".wav": "audio/wav",
  ".webm": "video/webm",
  ".webp": "image/webp",
};

const CONTENT_TYPE_EXTENSIONS = {
  "audio/aac": ".aac",
  "audio/flac": ".flac",
  "audio/mp4": ".m4a",
  "audio/mpeg": ".mp3",
  "audio/ogg": ".ogg",
  "audio/wav": ".wav",
  "audio/x-wav": ".wav",
  "image/avif": ".avif",
  "image/gif": ".gif",
  "image/heic": ".heic",
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
  "text/plain": ".txt",
  "video/mp4": ".mp4",
  "video/quicktime": ".mov",
  "video/webm": ".webm",
};

export async function downloadMedia({ asset, destination, maxBytes, timeoutMs, onProgress }) {
  if (asset.media_type === "text" && typeof asset.text_content === "string") {
    return await writeTextAsset({ asset, destination, maxBytes, onProgress });
  }

  if (hasCompanionAudio(asset)) {
    try {
      return await downloadMergedMedia({
        asset,
        destination,
        maxBytes,
        timeoutMs,
        onProgress,
      });
    } catch (error) {
      if (!asset.optional_audio) {
        throw error;
      }

      return await downloadMedia({
        asset: videoOnlyAsset(asset),
        destination,
        maxBytes,
        timeoutMs,
        onProgress,
      });
    }
  }

  const urls = mediaUrlsForAsset(asset);
  let lastError = null;

  for (const sourceUrl of urls) {
    try {
      if (asset.is_hls || isHlsUrl(sourceUrl)) {
        return await downloadHlsMedia({
          asset: { ...asset, source_url: sourceUrl },
          destination,
          maxBytes,
          timeoutMs,
          onProgress,
          progressPartId: "media",
        });
      }

      return await downloadSingleMedia({
        asset: { ...asset, source_url: sourceUrl },
        destination,
        maxBytes,
        timeoutMs,
        onProgress,
        progressPartId: "media",
      });
    } catch (error) {
      if (!(error instanceof AppError)) {
        throw error;
      }

      lastError = error;
    }
  }

  throw lastError ?? new AppError(ErrorCode.DOWNLOAD_FAILED, "媒体资源下载失败。", 502);
}

async function writeTextAsset({ asset, destination, maxBytes, onProgress }) {
  await fs.mkdir(path.dirname(destination), { recursive: true });

  const text = asset.text_content;
  const buffer = Buffer.from(text, "utf8");

  if (buffer.length > maxBytes) {
    throw new AppError(ErrorCode.DOWNLOAD_FAILED, "文本资源超过单文件大小限制。", 413);
  }

  onProgress?.({
    type: "stream_start",
    part_id: "text",
    content_length: buffer.length,
    downloaded_bytes: 0,
  });

  await fs.writeFile(destination, buffer);

  onProgress?.({
    type: "stream_progress",
    part_id: "text",
    content_length: buffer.length,
    downloaded_bytes: buffer.length,
  });

  return {
    path: destination,
    sourceUrl: asset.source_url || "",
    contentType: "text/plain; charset=utf-8",
    sizeBytes: buffer.length,
  };
}

export async function estimateMediaDownloadSize({ asset, maxBytes, timeoutMs }) {
  if (asset.media_type === "text" && typeof asset.text_content === "string") {
    const size = Buffer.byteLength(asset.text_content, "utf8");

    if (size > maxBytes) {
      throw new AppError(ErrorCode.DOWNLOAD_FAILED, "文本资源超过单文件大小限制。", 413);
    }

    return {
      totalBytes: size,
      knownParts: 1,
      partCount: 1,
    };
  }

  const parts = hasCompanionAudio(asset)
    ? [
        {
          asset: {
            ...asset,
            media_type: "video",
          },
        },
        {
          asset: {
            source_url: asset.audio_source_url,
            fallback_urls: asset.audio_fallback_urls,
            media_type: "audio",
            filename_hint: asset.audio_filename_hint || "audio.m4a",
            request_headers: asset.audio_request_headers || asset.request_headers,
          },
        },
      ]
    : [{ asset }];
  let totalBytes = 0;
  let knownParts = 0;

  for (const part of parts) {
    const contentLength = await estimateSingleMediaSize({
      asset: part.asset,
      maxBytes,
      timeoutMs,
    });

    if (contentLength) {
      totalBytes += contentLength;
      knownParts += 1;
    }
  }

  return {
    totalBytes: totalBytes || null,
    knownParts,
    partCount: parts.length,
  };
}

async function downloadMergedMedia({ asset, destination, maxBytes, timeoutMs, onProgress }) {
  const videoUrls = mediaUrlsForAsset(asset);
  const audioUrls = mediaUrlsForAsset({
    source_url: asset.audio_source_url,
    fallback_urls: asset.audio_fallback_urls,
  });
  let lastError = null;

  for (const sourceUrl of videoUrls) {
    for (const audioUrl of audioUrls) {
      try {
        return await downloadAndMergeMedia({
          asset,
          sourceUrl,
        audioUrl,
        destination,
        maxBytes,
        timeoutMs,
        onProgress,
      });
      } catch (error) {
        if (!(error instanceof AppError)) {
          throw error;
        }

        lastError = error;
      }
    }
  }

  throw lastError ?? new AppError(ErrorCode.DOWNLOAD_FAILED, "媒体音视频合并失败。", 502);
}

async function downloadAndMergeMedia({ asset, sourceUrl, audioUrl, destination, maxBytes, timeoutMs, onProgress }) {
  const videoAsset = {
    ...asset,
    source_url: sourceUrl,
    media_type: "video",
  };
  const audioAsset = {
    source_url: audioUrl,
    media_type: "audio",
    filename_hint: asset.audio_filename_hint || "audio.m4a",
    request_headers: asset.audio_request_headers || asset.request_headers,
  };
  const videoPath = `${destination}.video${extensionForAsset(videoAsset)}`;
  const audioPath = `${destination}.audio${extensionForAsset(audioAsset)}`;
  const outputExtension = mergedMediaExtension(asset);
  const mergedTempPath = `${destination}.merge${outputExtension}.part`;

  await fs.unlink(videoPath).catch(() => {});
  await fs.unlink(audioPath).catch(() => {});
  await fs.unlink(mergedTempPath).catch(() => {});

  try {
    const videoDownload = await downloadSingleMedia({
      asset: videoAsset,
      destination: videoPath,
      maxBytes,
      timeoutMs,
      onProgress,
      progressPartId: "video",
    });
    const audioDownload = await downloadSingleMedia({
      asset: audioAsset,
      destination: audioPath,
      maxBytes,
      timeoutMs,
      onProgress,
      progressPartId: "audio",
    });

    if ((videoDownload.sizeBytes || 0) + (audioDownload.sizeBytes || 0) > maxBytes) {
      throw new AppError(ErrorCode.DOWNLOAD_FAILED, "媒体资源超过单文件大小限制。", 413);
    }

    const { sizeBytes } = await mergeMediaFiles({
      videoPath,
      audioPath,
      destination,
      tempPath: mergedTempPath,
      outputExtension,
      maxBytes,
    });

    return {
      path: destination,
      contentType: EXTENSION_CONTENT_TYPES[outputExtension] || "video/mp4",
      sourceUrl,
      sizeBytes,
    };
  } finally {
    await fs.unlink(videoPath).catch(() => {});
    await fs.unlink(audioPath).catch(() => {});
    await fs.unlink(mergedTempPath).catch(() => {});
  }
}

async function downloadHlsMedia({ asset, destination, maxBytes, timeoutMs, onProgress, progressPartId = "media" }) {
  const ffmpegPath = resolveFfmpegPath();

  if (!ffmpegPath) {
    throw new AppError(ErrorCode.DOWNLOAD_FAILED, "服务器缺少 ffmpeg，无法下载 HLS 视频。", 500);
  }

  await fs.mkdir(path.dirname(destination), { recursive: true });

  const tempPath = `${destination}.part`;
  const headers = { ...MEDIA_HEADERS, ...(asset.request_headers || {}) };
  const mediaTempPath = `${destination}.hls.part`;

  await fs.unlink(tempPath).catch(() => {});
  await fs.unlink(mediaTempPath).catch(() => {});

  onProgress?.({
    type: "stream_start",
    part_id: progressPartId,
    content_length: null,
    downloaded_bytes: 0,
  });

  try {
    try {
      const hlsDownload = await downloadHlsSegments({
        playlistUrl: asset.source_url,
        destination: mediaTempPath,
        headers,
        maxBytes,
        timeoutMs,
        onProgress,
        progressPartId,
      });

      await remuxLocalHlsMedia({
        ffmpegPath,
        inputPath: hlsDownload.path,
        destination: tempPath,
        timeoutMs,
      });
    } finally {
      await fs.unlink(mediaTempPath).catch(() => {});
    }
  } catch (error) {
    await fs.unlink(tempPath).catch(() => {});
    throw error;
  }

  const stat = await fs.stat(tempPath);

  if (stat.size === 0) {
    await fs.unlink(tempPath).catch(() => {});
    throw new AppError(ErrorCode.DOWNLOAD_FAILED, "HLS 视频资源为空。", 502);
  }

  if (stat.size > maxBytes) {
    await fs.unlink(tempPath).catch(() => {});
    throw new AppError(ErrorCode.DOWNLOAD_FAILED, "媒体资源超过单文件大小限制。", 413);
  }

  await fs.rename(tempPath, destination);

  onProgress?.({
    type: "stream_complete",
    part_id: progressPartId,
    content_length: stat.size,
    downloaded_bytes: stat.size,
  });

  return {
    path: destination,
    contentType: "video/mp4",
    sourceUrl: asset.source_url,
    sizeBytes: stat.size,
  };
}

async function downloadHlsSegments({
  playlistUrl,
  destination,
  headers,
  maxBytes,
  timeoutMs,
  onProgress,
  progressPartId,
}) {
  const playlist = await resolveHlsMediaPlaylist({
    playlistUrl,
    headers,
    timeoutMs,
  });
  const file = await fs.open(destination, "w");
  let size = 0;

  try {
    for (const segmentUrl of playlist.segmentUrls) {
      const response = await fetchWithTimeout(
        segmentUrl,
        { cache: "no-store", headers },
        timeoutMs,
      );

      if ([401, 403, 410, 429].includes(response.status)) {
        throw new AppError(ErrorCode.DOWNLOAD_FAILED, "HLS 分片被平台或 CDN 拒绝访问。", 502);
      }

      if (response.status >= 400) {
        throw new AppError(ErrorCode.DOWNLOAD_FAILED, `HLS 分片下载失败，状态码 ${response.status}。`, 502);
      }

      const buffer = Buffer.from(await response.arrayBuffer());

      if (!buffer.length) {
        continue;
      }

      size += buffer.length;

      if (size > maxBytes) {
        throw new AppError(ErrorCode.DOWNLOAD_FAILED, "媒体资源超过单文件大小限制。", 413);
      }

      await file.write(buffer);
      onProgress?.({
        type: "stream_progress",
        part_id: progressPartId,
        content_length: null,
        downloaded_bytes: size,
      });
    }
  } finally {
    await file.close();
  }

  if (size === 0) {
    await fs.unlink(destination).catch(() => {});
    throw new AppError(ErrorCode.DOWNLOAD_FAILED, "HLS 视频资源为空。", 502);
  }

  return {
    path: destination,
    sizeBytes: size,
  };
}

async function resolveHlsMediaPlaylist({ playlistUrl, headers, timeoutMs, depth = 0 }) {
  if (depth > 4) {
    throw new AppError(ErrorCode.DOWNLOAD_FAILED, "HLS 播放列表层级过深。", 502);
  }

  const playlistText = await fetchHlsPlaylistText({ playlistUrl, headers, timeoutMs });
  const variants = parseHlsVariants(playlistText, playlistUrl);

  if (variants.length > 0) {
    const bestVariant = variants.reduce((best, candidate) =>
      hlsVariantScore(candidate) > hlsVariantScore(best) ? candidate : best,
    );

    return await resolveHlsMediaPlaylist({
      playlistUrl: bestVariant.url,
      headers,
      timeoutMs,
      depth: depth + 1,
    });
  }

  const segmentUrls = parseHlsSegments(playlistText, playlistUrl);

  if (segmentUrls.length === 0) {
    throw new AppError(ErrorCode.DOWNLOAD_FAILED, "HLS 播放列表中没有可下载分片。", 502);
  }

  if (hasEncryptedHlsSegments(playlistText)) {
    throw new AppError(ErrorCode.DOWNLOAD_FAILED, "HLS 视频使用加密分片，暂不支持下载。", 502);
  }

  return {
    playlistUrl,
    segmentUrls,
  };
}

async function fetchHlsPlaylistText({ playlistUrl, headers, timeoutMs }) {
  let response;

  try {
    response = await fetchWithTimeout(
      playlistUrl,
      { cache: "no-store", headers },
      timeoutMs,
    );
  } catch (error) {
    if (error?.name === "AbortError") {
      throw new AppError(ErrorCode.DOWNLOAD_FAILED, "HLS 播放列表请求超时。", 504);
    }

    throw new AppError(ErrorCode.DOWNLOAD_FAILED, "HLS 播放列表请求失败。", 502);
  }

  if ([401, 403, 410, 429].includes(response.status)) {
    throw new AppError(ErrorCode.DOWNLOAD_FAILED, "HLS 播放列表被平台或 CDN 拒绝访问。", 502);
  }

  if (response.status >= 400) {
    throw new AppError(ErrorCode.DOWNLOAD_FAILED, `HLS 播放列表请求失败，状态码 ${response.status}。`, 502);
  }

  return await response.text();
}

function parseHlsVariants(playlistText, playlistUrl) {
  const lines = playlistText.split(/\r?\n/);
  const variants = [];

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();

    if (!line.startsWith("#EXT-X-STREAM-INF")) {
      continue;
    }

    const nextUri = nextHlsUri(lines, index + 1);

    if (!nextUri) {
      continue;
    }

    variants.push({
      url: new URL(nextUri, playlistUrl).toString(),
      bandwidth: safeInt(hlsAttribute(line, "BANDWIDTH")),
      resolution: hlsAttribute(line, "RESOLUTION"),
    });
  }

  return variants;
}

function parseHlsSegments(playlistText, playlistUrl) {
  const lines = playlistText.split(/\r?\n/);
  const urls = [];
  const mapUri = firstHlsMapUri(lines);

  if (mapUri) {
    urls.push(new URL(mapUri, playlistUrl).toString());
  }

  for (const line of lines) {
    const value = line.trim();

    if (!value || value.startsWith("#")) {
      continue;
    }

    urls.push(new URL(value, playlistUrl).toString());
  }

  return urls;
}

function firstHlsMapUri(lines) {
  for (const line of lines) {
    const value = line.trim();

    if (value.startsWith("#EXT-X-MAP")) {
      return hlsAttribute(value, "URI");
    }
  }

  return "";
}

function nextHlsUri(lines, startIndex) {
  for (let index = startIndex; index < lines.length; index += 1) {
    const value = lines[index].trim();

    if (!value || value.startsWith("#")) {
      continue;
    }

    return value;
  }

  return "";
}

function hlsAttribute(line, name) {
  const pattern = new RegExp(`${name}=("[^"]+"|[^,]+)`, "i");
  const match = pattern.exec(line);

  return match ? match[1].replace(/^"|"$/g, "") : "";
}

function hlsVariantScore(variant) {
  const resolution = /^(\d+)x(\d+)$/i.exec(variant.resolution || "");
  const pixels = resolution ? (safeInt(resolution[1]) || 0) * (safeInt(resolution[2]) || 0) : 0;

  return pixels + (variant.bandwidth || 0);
}

function hasEncryptedHlsSegments(playlistText) {
  return playlistText
    .split(/\r?\n/)
    .some((line) => /^#EXT-X-KEY:/i.test(line) && !/METHOD=NONE/i.test(line));
}

async function remuxLocalHlsMedia({ ffmpegPath, inputPath, destination, timeoutMs }) {
  await fs.unlink(destination).catch(() => {});

  await new Promise((resolve, reject) => {
    const ffmpegArgs = [
      "-hide_banner",
      "-loglevel",
      "error",
      "-y",
      "-i",
      inputPath,
      "-map",
      "0:v:0?",
      "-map",
      "0:a:0?",
      "-c",
      "copy",
      "-movflags",
      "+faststart",
      "-f",
      "mp4",
      destination,
    ];
    const ffmpeg = spawn(ffmpegPath, ffmpegArgs);
    let stderr = "";
    let completed = false;
    const timer = setTimeout(() => {
      ffmpeg.kill("SIGKILL");
    }, timeoutMs);

    ffmpeg.stderr.on("data", (chunk) => {
      stderr = `${stderr}${chunk.toString()}`.slice(-4000);
    });
    ffmpeg.on("error", (error) => {
      if (completed) {
        return;
      }

      completed = true;
      clearTimeout(timer);
      reject(new AppError(ErrorCode.DOWNLOAD_FAILED, `HLS 视频转封装失败：${error.message}`, 502));
    });
    ffmpeg.on("close", (code, signal) => {
      if (completed) {
        return;
      }

      completed = true;
      clearTimeout(timer);

      if (code === 0) {
        resolve();
        return;
      }

      reject(new AppError(
        ErrorCode.DOWNLOAD_FAILED,
        signal === "SIGKILL" ? "HLS 视频转封装超时。" : "HLS 视频转封装失败。",
        signal === "SIGKILL" ? 504 : 502,
        stderr ? { ffmpeg: stderr.trim() } : undefined,
      ));
    });
  });
}

async function mergeMediaFiles({ videoPath, audioPath, destination, tempPath, outputExtension, maxBytes }) {
  const ffmpegPath = resolveFfmpegPath();

  if (!ffmpegPath) {
    throw new AppError(ErrorCode.DOWNLOAD_FAILED, "服务器缺少 ffmpeg，无法合并音视频。", 500);
  }

  await fs.unlink(tempPath).catch(() => {});

  await new Promise((resolve, reject) => {
    const ffmpegArgs = [
      "-hide_banner",
      "-loglevel",
      "error",
      "-y",
      "-i",
      videoPath,
      "-i",
      audioPath,
      "-map",
      "0:v:0",
      "-map",
      "1:a:0",
      "-c",
      "copy",
      "-shortest",
      "-f",
      outputExtension === ".webm" ? "webm" : "mp4",
      tempPath,
    ];

    if (outputExtension !== ".webm") {
      ffmpegArgs.splice(-4, 0, "-movflags", "+faststart");
    }

    const ffmpeg = spawn(ffmpegPath, ffmpegArgs);
    let stderr = "";

    ffmpeg.stderr.on("data", (chunk) => {
      stderr = `${stderr}${chunk.toString()}`.slice(-4000);
    });
    ffmpeg.on("error", (error) => {
      reject(new AppError(ErrorCode.DOWNLOAD_FAILED, `媒体音视频合并失败：${error.message}`, 502));
    });
    ffmpeg.on("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(new AppError(
        ErrorCode.DOWNLOAD_FAILED,
        "媒体音视频合并失败。",
        502,
        stderr ? { ffmpeg: stderr.trim() } : undefined,
      ));
    });
  });

  const stat = await fs.stat(tempPath);

  if (stat.size === 0) {
    throw new AppError(ErrorCode.DOWNLOAD_FAILED, "合并后的媒体资源为空。", 502);
  }

  if (stat.size > maxBytes) {
    throw new AppError(ErrorCode.DOWNLOAD_FAILED, "媒体资源超过单文件大小限制。", 413);
  }

  await fs.rename(tempPath, destination);

  return { sizeBytes: stat.size };
}

function mergedMediaExtension(asset) {
  const extension = extensionForAsset(asset).toLowerCase();

  return extension === ".webm" ? ".webm" : ".mp4";
}

async function downloadSingleMedia({ asset, destination, maxBytes, timeoutMs, onProgress, progressPartId = "media" }) {
  await fs.mkdir(path.dirname(destination), { recursive: true });

  const tempPath = `${destination}.part`;
  const headers = { ...MEDIA_HEADERS, ...(asset.request_headers || {}) };
  const expectedInfo = await probeContentInfo({ asset, headers, maxBytes, timeoutMs });
  const expectedType = expectedInfo.contentType;
  let response;

  await fs.unlink(tempPath).catch(() => {});

  try {
    response = await fetchWithTimeout(
      asset.source_url,
      { cache: "no-store", headers },
      timeoutMs,
    );
  } catch (error) {
    if (error?.name === "AbortError") {
      throw new AppError(ErrorCode.DOWNLOAD_FAILED, "媒体资源下载超时。", 504);
    }

    throw new AppError(ErrorCode.DOWNLOAD_FAILED, "媒体资源下载失败。", 502);
  }

  if ([401, 403, 429].includes(response.status)) {
    throw new AppError(ErrorCode.DOWNLOAD_FAILED, "媒体资源被平台或 CDN 拒绝访问。", 502);
  }

  if (response.status >= 400) {
    throw new AppError(ErrorCode.DOWNLOAD_FAILED, `媒体资源下载失败，状态码 ${response.status}。`, 502);
  }

  const contentType = normalizeContentType(response.headers.get("content-type")) || expectedType || guessContentType(destination, asset.media_type);

  if (!contentTypeMatches(asset.media_type, contentType, asset.source_url)) {
    throw new AppError(ErrorCode.DOWNLOAD_FAILED, "上游返回的媒体类型不符合预期。", 502);
  }

  const contentLength = safeInt(response.headers.get("content-length")) || expectedInfo.contentLength;

  if (contentLength && contentLength > maxBytes) {
    throw new AppError(ErrorCode.DOWNLOAD_FAILED, "媒体资源超过单文件大小限制。", 413);
  }

  let size = 0;
  const file = await fs.open(tempPath, "w");

  onProgress?.({
    type: "stream_start",
    part_id: progressPartId,
    content_length: contentLength,
    downloaded_bytes: 0,
  });

  try {
    const reader = response.body?.getReader();

    if (!reader) {
      const buffer = Buffer.from(await response.arrayBuffer());

      size = buffer.length;
      if (size > maxBytes) {
        throw new AppError(ErrorCode.DOWNLOAD_FAILED, "媒体资源超过单文件大小限制。", 413);
      }
      await file.write(buffer);
      onProgress?.({
        type: "stream_progress",
        part_id: progressPartId,
        content_length: contentLength,
        downloaded_bytes: size,
      });
    } else {
      while (true) {
        const { done, value } = await reader.read();

        if (done) {
          break;
        }

        if (!value || value.length === 0) {
          continue;
        }

        size += value.length;

        if (size > maxBytes) {
          throw new AppError(ErrorCode.DOWNLOAD_FAILED, "媒体资源超过单文件大小限制。", 413);
        }

        await file.write(Buffer.from(value));
        onProgress?.({
          type: "stream_progress",
          part_id: progressPartId,
          content_length: contentLength,
          downloaded_bytes: size,
        });
      }
    }
  } finally {
    await file.close();
  }

  if (size === 0) {
    await fs.unlink(tempPath).catch(() => {});
    throw new AppError(ErrorCode.DOWNLOAD_FAILED, "媒体资源为空。", 502);
  }

  await fs.rename(tempPath, destination);

  onProgress?.({
    type: "stream_complete",
    part_id: progressPartId,
    content_length: contentLength || size,
    downloaded_bytes: size,
  });

  return {
    path: destination,
    contentType,
    sourceUrl: asset.source_url,
    sizeBytes: size,
  };
}

async function estimateSingleMediaSize({ asset, maxBytes, timeoutMs }) {
  const headers = { ...MEDIA_HEADERS, ...(asset.request_headers || {}) };

  for (const sourceUrl of mediaUrlsForAsset(asset)) {
    if (asset.is_hls || isHlsUrl(sourceUrl)) {
      continue;
    }

    try {
      const info = await probeContentInfo({
        asset: { ...asset, source_url: sourceUrl },
        headers,
        maxBytes,
        timeoutMs,
      });

      if (info.contentLength) {
        return info.contentLength;
      }
    } catch {
      // Size estimation is best-effort; the real download still validates limits.
    }
  }

  return null;
}

function hasCompanionAudio(asset) {
  return typeof asset?.audio_source_url === "string" && asset.audio_source_url.startsWith("http");
}

function videoOnlyAsset(asset) {
  const {
    audio_source_url,
    audio_fallback_urls,
    audio_filename_hint,
    audio_request_headers,
    optional_audio,
    ...videoAsset
  } = asset;

  return videoAsset;
}

function resolveFfmpegPath() {
  const binaryName = process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg";
  const candidates = [
    process.env.FFMPEG_PATH,
    packagedFfmpegPath,
    path.join(process.cwd(), "node_modules", "ffmpeg-static", binaryName),
  ];

  return candidates.find((candidate) =>
    typeof candidate === "string" &&
    candidate.length > 0 &&
    existsSync(candidate),
  );
}

function mediaUrlsForAsset(asset) {
  const urls = [asset.source_url, ...(Array.isArray(asset.fallback_urls) ? asset.fallback_urls : [])];
  const seen = new Set();

  return urls.filter((url) => {
    if (typeof url !== "string" || !url.startsWith("http") || seen.has(url)) {
      return false;
    }

    seen.add(url);
    return true;
  });
}

export function extensionForAsset(asset, contentType = "") {
  if (asset.filename_hint) {
    const hinted = path.extname(asset.filename_hint);

    if (hinted) {
      return hinted;
    }
  }

  if (contentType) {
    const guessed = CONTENT_TYPE_EXTENSIONS[contentType.split(";", 1)[0].trim().toLowerCase()];

    if (guessed) {
      return guessed;
    }
  }

  let pathname = "";

  try {
    pathname = new URL(asset.source_url).pathname.toLowerCase();
  } catch {
    pathname = "";
  }

  for (const extension of [
    ".jpg",
    ".jpeg",
    ".png",
    ".webp",
    ".gif",
    ".heic",
    ".mp4",
    ".mov",
    ".m4v",
    ".webm",
    ".m4a",
    ".mp3",
    ".aac",
    ".avif",
    ".wav",
    ".ogg",
    ".flac",
    ".txt",
  ]) {
    if (pathname.endsWith(extension)) {
      return extension;
    }
  }

  if (asset.media_type === "audio") {
    return ".m4a";
  }

  if (asset.media_type === "text") {
    return ".txt";
  }

  return asset.media_type === "video" ? ".mp4" : ".jpg";
}

function isHlsUrl(value) {
  try {
    return new URL(value).pathname.toLowerCase().endsWith(".m3u8");
  } catch {
    return /\.m3u8(?:$|\?)/i.test(String(value));
  }
}

async function probeContentInfo({ asset, headers, maxBytes, timeoutMs }) {
  let response;

  try {
    response = await fetchWithTimeout(
      asset.source_url,
      { method: "HEAD", cache: "no-store", headers },
      timeoutMs,
    );
  } catch {
    return { contentType: "", contentLength: null };
  }

  if (response.status >= 400) {
    return { contentType: "", contentLength: null };
  }

  const contentLength = safeInt(response.headers.get("content-length"));

  if (contentLength && contentLength > maxBytes) {
    throw new AppError(ErrorCode.DOWNLOAD_FAILED, "媒体资源超过单文件大小限制。", 413);
  }

  return {
    contentType: normalizeContentType(response.headers.get("content-type")),
    contentLength,
  };
}

function contentTypeMatches(mediaType, contentType, sourceUrl) {
  if (contentType) {
    if (mediaType === "image" && contentType.startsWith("image/")) {
      return true;
    }

    if (mediaType === "video" && contentType.startsWith("video/")) {
      return true;
    }

    if (mediaType === "audio" && contentType.startsWith("audio/")) {
      return true;
    }

    if (mediaType === "text" && contentType.startsWith("text/")) {
      return true;
    }

    if (
      mediaType === "audio" &&
      contentType === "video/mp4" &&
      /(?:dash_audio|audio|\.m4a|\.m4s)(?:[/?#._-]|$)/i.test(sourceUrl)
    ) {
      return true;
    }

    if (contentType === "application/octet-stream") {
      return true;
    }
  }

  const guessed = guessContentType(sourceUrl, mediaType);

  return guessed.startsWith(`${mediaType}/`);
}

function guessContentType(filePathOrUrl, mediaType) {
  const extension = path.extname(filePathOrUrl.split("?")[0]).toLowerCase();

  if (EXTENSION_CONTENT_TYPES[extension]) {
    return EXTENSION_CONTENT_TYPES[extension];
  }

  if (mediaType === "audio") {
    return "audio/mp4";
  }

  if (mediaType === "text") {
    return "text/plain; charset=utf-8";
  }

  return mediaType === "video" ? "video/mp4" : "image/jpeg";
}

function normalizeContentType(value) {
  return value ? value.split(";", 1)[0].trim().toLowerCase() : "";
}

function safeInt(value) {
  if (value == null || value === "") {
    return null;
  }

  const number = Number.parseInt(String(value), 10);

  return Number.isFinite(number) ? number : null;
}
