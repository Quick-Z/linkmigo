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
  ".gif": "image/gif",
  ".heic": "image/heic",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".m4a": "audio/mp4",
  ".m4v": "video/mp4",
  ".mov": "video/quicktime",
  ".mp3": "audio/mpeg",
  ".mp4": "video/mp4",
  ".png": "image/png",
  ".webm": "video/webm",
  ".webp": "image/webp",
};

const CONTENT_TYPE_EXTENSIONS = {
  "audio/aac": ".aac",
  "audio/mp4": ".m4a",
  "audio/mpeg": ".mp3",
  "image/gif": ".gif",
  "image/heic": ".heic",
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
  "video/mp4": ".mp4",
  "video/quicktime": ".mov",
  "video/webm": ".webm",
};

export async function downloadMedia({ asset, destination, maxBytes, timeoutMs }) {
  if (hasCompanionAudio(asset)) {
    return await downloadMergedMedia({
      asset,
      destination,
      maxBytes,
      timeoutMs,
    });
  }

  const urls = mediaUrlsForAsset(asset);
  let lastError = null;

  for (const sourceUrl of urls) {
    try {
      return await downloadSingleMedia({
        asset: { ...asset, source_url: sourceUrl },
        destination,
        maxBytes,
        timeoutMs,
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

async function downloadMergedMedia({ asset, destination, maxBytes, timeoutMs }) {
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

async function downloadAndMergeMedia({ asset, sourceUrl, audioUrl, destination, maxBytes, timeoutMs }) {
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
    });
    const audioDownload = await downloadSingleMedia({
      asset: audioAsset,
      destination: audioPath,
      maxBytes,
      timeoutMs,
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

async function downloadSingleMedia({ asset, destination, maxBytes, timeoutMs }) {
  await fs.mkdir(path.dirname(destination), { recursive: true });

  const tempPath = `${destination}.part`;
  const headers = { ...MEDIA_HEADERS, ...(asset.request_headers || {}) };
  const expectedType = await probeContentType({ asset, headers, maxBytes, timeoutMs });
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

  const contentLength = safeInt(response.headers.get("content-length"));

  if (contentLength && contentLength > maxBytes) {
    throw new AppError(ErrorCode.DOWNLOAD_FAILED, "媒体资源超过单文件大小限制。", 413);
  }

  let size = 0;
  const file = await fs.open(tempPath, "w");

  try {
    const reader = response.body?.getReader();

    if (!reader) {
      const buffer = Buffer.from(await response.arrayBuffer());

      size = buffer.length;
      if (size > maxBytes) {
        throw new AppError(ErrorCode.DOWNLOAD_FAILED, "媒体资源超过单文件大小限制。", 413);
      }
      await file.write(buffer);
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

  return {
    path: destination,
    contentType,
    sourceUrl: asset.source_url,
    sizeBytes: size,
  };
}

function hasCompanionAudio(asset) {
  return typeof asset?.audio_source_url === "string" && asset.audio_source_url.startsWith("http");
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
  ]) {
    if (pathname.endsWith(extension)) {
      return extension;
    }
  }

  if (asset.media_type === "audio") {
    return ".m4a";
  }

  return asset.media_type === "video" ? ".mp4" : ".jpg";
}

async function probeContentType({ asset, headers, maxBytes, timeoutMs }) {
  let response;

  try {
    response = await fetchWithTimeout(
      asset.source_url,
      { method: "HEAD", cache: "no-store", headers },
      timeoutMs,
    );
  } catch {
    return "";
  }

  if (response.status >= 400) {
    return "";
  }

  const contentLength = safeInt(response.headers.get("content-length"));

  if (contentLength && contentLength > maxBytes) {
    throw new AppError(ErrorCode.DOWNLOAD_FAILED, "媒体资源超过单文件大小限制。", 413);
  }

  return normalizeContentType(response.headers.get("content-type"));
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
