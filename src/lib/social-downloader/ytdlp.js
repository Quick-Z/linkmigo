import { execFile as execFileCallback } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { AppError, ErrorCode } from "./errors";
import { fetchWithTimeout, getProxyUrl } from "./utils";

const execFile = promisify(execFileCallback);
const require = createRequire(import.meta.url);
const packagedFfmpegPath = require("ffmpeg-static");

const DEFAULT_FORMAT = "bv*[ext=mp4]+ba[ext=m4a]/bv*[ext=mp4]/bv*+ba/b";
const YTDLP_PATH_ENV_NAMES = ["YTDLP_PATH", "SOCIAL_YTDLP_PATH"];
const YTDLP_COOKIE_FILE_ENV_NAMES = ["YTDLP_COOKIES_FILE", "SOCIAL_YTDLP_COOKIES_FILE"];
const YTDLP_EXTRACTOR_ARGS_ENV_NAMES = ["YTDLP_EXTRACTOR_ARGS", "SOCIAL_YTDLP_EXTRACTOR_ARGS"];
const YTDLP_JS_RUNTIME_ENV_NAMES = ["YTDLP_JS_RUNTIME", "SOCIAL_YTDLP_JS_RUNTIME"];

let cachedExecutable = null;
let cachedExecutablePromise = null;
let cachedBinaryDownloadPromise = null;

export async function resolveYoutubeWithYtDlp(normalized, settings) {
  const info = await runYtDlpJson(normalized.canonical_url, settings);
  const details = info && typeof info === "object" ? info : {};
  const videoId = String(details.id || normalized.shortcode);

  if (details.is_private || details.availability === "private") {
    throw new AppError(ErrorCode.LOGIN_REQUIRED, "这个 YouTube 视频是私密内容，需要登录或授权。", 403);
  }

  if (details.is_live || details.is_live_content || ["is_live", "post_live"].includes(details.live_status)) {
    throw new AppError(ErrorCode.NO_MEDIA_FOUND, "暂不支持下载 YouTube 直播内容。", 404);
  }

  const format = bestVideoFormat(details);
  const qualityLabel = safePart(format?.height ? `${format.height}p` : "best");
  const filenameBase = `youtube_${safePart(videoId)}_${qualityLabel}`;
  const metrics = {
    like_count: optionalNumber(details.like_count),
    comment_count: optionalNumber(details.comment_count),
    view_count: optionalNumber(details.view_count),
    save_count: null,
    share_count: null,
    source: "youtube_ytdlp",
  };
  const creatorHandle = String(details.uploader_id || details.channel_id || details.uploader || "");

  return {
    assets: [{
      // Keep the submitted YouTube URL as the public source. The actual
      // googlevideo URLs are short-lived and must stay inside yt-dlp.
      source_url: normalized.canonical_url,
      download_url: normalized.canonical_url,
      download_with: "yt-dlp",
      ytdlp_format: DEFAULT_FORMAT,
      media_type: "video",
      width: optionalNumber(format?.width),
      height: optionalNumber(format?.height),
      filename_hint: `${filenameBase}.mp4`,
    }],
    metrics,
    creator_handle: creatorHandle,
    post_info: {
      title: String(details.title || ""),
      author: String(details.uploader || details.channel || ""),
      author_handle: creatorHandle,
      body: String(details.description || ""),
      tags: Array.isArray(details.tags) ? details.tags : [],
      metrics,
      source: "youtube_ytdlp",
    },
  };
}

export async function downloadYoutubeWithYtDlp({
  asset,
  destination,
  maxBytes,
  timeoutMs,
  onProgress,
}) {
  const sourceUrl = asset.download_url || asset.source_url;
  const outputPath = path.resolve(destination);
  const ffmpegPath = resolveFfmpegPath();
  await ensureFfmpegExecutable(ffmpegPath);
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.unlink(outputPath).catch(() => {});
  await fs.unlink(`${outputPath}.part`).catch(() => {});

  const args = buildCommonArgs(timeoutMs, ffmpegPath);
  args.push(
    "--format",
    asset.ytdlp_format || DEFAULT_FORMAT,
    "--merge-output-format",
    "mp4",
    "--output",
    outputPath,
    "--print",
    "after_move:filepath",
    sourceUrl,
  );

  let result;

  try {
    result = await execFile(await getYtDlpExecutable(), args, {
      timeout: Math.max(1, Number(timeoutMs) || 600_000),
      maxBuffer: 64 * 1024 * 1024,
      windowsHide: true,
    });
  } catch (error) {
    await fs.unlink(`${outputPath}.part`).catch(() => {});
    throw toYtDlpError(error);
  }

  const reportedPath = lastOutputPath(result.stdout);
  const finalPath = await existingOutputPath(outputPath, reportedPath);

  if (!finalPath) {
    throw new AppError(ErrorCode.DOWNLOAD_FAILED, "yt-dlp 未生成下载文件。", 502, {
      stderr: compactOutput(result.stderr),
    });
  }

  const stat = await fs.stat(finalPath);

  if (stat.size <= 0) {
    throw new AppError(ErrorCode.DOWNLOAD_FAILED, "yt-dlp 生成了空媒体文件。", 502);
  }

  if (stat.size > maxBytes) {
    throw new AppError(ErrorCode.DOWNLOAD_FAILED, "媒体资源超过单文件大小限制。", 413);
  }

  if (finalPath !== outputPath) {
    await fs.rename(finalPath, outputPath);
  }

  onProgress?.({
    type: "stream_start",
    part_id: "media",
    content_length: stat.size,
    downloaded_bytes: 0,
  });
  onProgress?.({
    type: "stream_complete",
    part_id: "media",
    content_length: stat.size,
    downloaded_bytes: stat.size,
  });

  return {
    path: outputPath,
    sourceUrl,
    contentType: "video/mp4",
    sizeBytes: stat.size,
  };
}

export function isYtDlpUnavailable(error) {
  return Boolean(error?.ytDlpUnavailable || error?.cause?.code === "ENOENT" || error?.code === "ENOENT");
}

async function runYtDlpJson(url, settings) {
  // YouTube extraction can require several player/API requests (and a PO
  // token round-trip) before yt-dlp emits its JSON.  The generic HTTP timeout
  // is intentionally short for ordinary social resolvers, so give this
  // metadata transaction a bounded but more realistic floor.
  const timeoutMs = Math.max(120_000, Number(settings.httpTimeoutMs) || 0);
  const args = buildCommonArgs(timeoutMs);
  args.push("--dump-single-json", "--skip-download", "--no-playlist", url);

  try {
    const { stdout, stderr } = await execFile(await getYtDlpExecutable(), args, {
      timeout: timeoutMs,
      maxBuffer: 64 * 1024 * 1024,
      windowsHide: true,
    });
    const text = String(stdout || "").trim();

    if (!text) {
      throw new AppError(ErrorCode.NO_MEDIA_FOUND, "yt-dlp 没有返回 YouTube 视频信息。", 404, {
        stderr: compactOutput(stderr),
      });
    }

    try {
      return JSON.parse(text);
    } catch {
      return JSON.parse(text.split("\n").filter(Boolean).at(-1));
    }
  } catch (error) {
    if (error instanceof AppError) {
      throw error;
    }

    throw toYtDlpError(error);
  }
}

function buildCommonArgs(timeoutMs, ffmpegPath = resolveFfmpegPath()) {
  const args = [
    "--no-playlist",
    "--no-warnings",
    "--no-color",
    // yt-dlp's YouTube extractor now uses EJS for signature deciphering.
    // Node is already the host runtime, so it is available in both local and
    // Docker deployments without adding a Python/Deno dependency.
    "--js-runtimes",
    firstEnv(YTDLP_JS_RUNTIME_ENV_NAMES) || "node",
    "--socket-timeout",
    String(Math.max(1, Math.ceil((Number(timeoutMs) || 20_000) / 1000))),
    "--retries",
    "3",
    "--fragment-retries",
    "3",
    "--concurrent-fragments",
    "4",
  ];
  const proxyUrl = getProxyUrl();
  const cookieFile = firstEnv(YTDLP_COOKIE_FILE_ENV_NAMES);
  const extractorArgs = firstEnv(YTDLP_EXTRACTOR_ARGS_ENV_NAMES);

  if (proxyUrl) {
    args.push("--proxy", proxyUrl);
  }

  if (cookieFile) {
    args.push("--cookies", cookieFile);
  }

  if (extractorArgs) {
    args.push("--extractor-args", extractorArgs);
  }

  const cookieHeader = youtubeCookieHeader();

  if (cookieHeader && !cookieFile) {
    args.push("--add-headers", `Cookie: ${cookieHeader}`);
  }

  if (ffmpegPath) {
    args.push("--ffmpeg-location", ffmpegPath);
  }

  return args;
}

async function ensureFfmpegExecutable(ffmpegPath) {
  if (!ffmpegPath || process.platform === "win32") {
    return;
  }

  // npm packages occasionally lose the executable bit when copied between
  // filesystems (notably macOS bind mounts). yt-dlp then downloads the video
  // and audio parts but cannot invoke ffmpeg to merge them, leaving only
  // `.f*.mp4`/`.f*.m4a` files behind. Repair the mode before spawning yt-dlp;
  // failures are harmless because yt-dlp may still find a system ffmpeg.
  await fs.chmod(ffmpegPath, 0o755).catch(() => {});
}

function resolveFfmpegPath() {
  const binaryName = process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg";
  const candidates = [
    process.env.FFMPEG_PATH?.trim(),
    packagedFfmpegPath,
    process.platform === "darwin" ? "/opt/homebrew/bin/ffmpeg" : "",
    "/usr/local/bin/ffmpeg",
    "/usr/bin/ffmpeg",
    binaryName,
  ].filter(Boolean);

  return candidates.find((candidate) => candidate === binaryName || existsSync(candidate)) || "";
}

async function getYtDlpExecutable() {
  if (cachedExecutable) {
    return cachedExecutable;
  }

  if (!cachedExecutablePromise) {
    cachedExecutablePromise = (async () => {
      const candidates = [
        firstEnv(YTDLP_PATH_ENV_NAMES),
        "yt-dlp",
        "/usr/local/bin/yt-dlp",
        "/opt/homebrew/bin/yt-dlp",
        "/usr/bin/yt-dlp",
      ]
        .filter(Boolean);

      for (const candidate of candidates) {
        try {
          await execFile(candidate, ["--version"], { timeout: 5_000, windowsHide: true });
          cachedExecutable = candidate;
          return candidate;
        } catch {
          // Try the next configured/system location.
        }
      }

      if (process.env.YTDLP_AUTO_DOWNLOAD === "0") {
        throw unavailableError();
      }

      cachedExecutable = await downloadYtDlpBinary();
      return cachedExecutable;
    })();
  }

  try {
    return await cachedExecutablePromise;
  } catch (error) {
    cachedExecutablePromise = null;
    throw error;
  }
}

async function downloadYtDlpBinary() {
  if (!cachedBinaryDownloadPromise) {
    cachedBinaryDownloadPromise = (async () => {
      const asset = ytDlpReleaseAsset();
      const cacheRoot = process.env.SOCIAL_CACHE_DIR?.trim() || path.join(process.cwd(), ".cache", "social-downloader");
      const binaryPath = path.join(cacheRoot, "yt-dlp", asset.filename);
      const temporaryPath = `${binaryPath}.part`;

      try {
        await fs.access(binaryPath);
        await fs.chmod(binaryPath, 0o755).catch(() => {});
        return binaryPath;
      } catch {
        // Download below.
      }

      await fs.mkdir(path.dirname(binaryPath), { recursive: true });
      const response = await fetchWithTimeout(asset.url, { headers: { "user-agent": "LinkMigo yt-dlp bootstrap" } }, 120_000);

      if (!response.ok) {
        throw new Error(`yt-dlp bootstrap returned HTTP ${response.status}`);
      }

      const body = Buffer.from(await response.arrayBuffer());
      if (body.length < 1_000_000) {
        throw new Error("yt-dlp bootstrap returned an unexpectedly small file");
      }

      await fs.writeFile(temporaryPath, body, { mode: 0o755 });
      await fs.rename(temporaryPath, binaryPath);
      await fs.chmod(binaryPath, 0o755);
      return binaryPath;
    })().catch((error) => {
      cachedBinaryDownloadPromise = null;
      const wrapped = unavailableError();
      wrapped.details = {
        ...wrapped.details,
        bootstrap_error: compactOutput(error?.message),
      };
      throw wrapped;
    });
  }

  return await cachedBinaryDownloadPromise;
}

function ytDlpReleaseAsset() {
  const platform = process.platform;
  const arch = process.arch;

  if (platform === "darwin") {
    return {
      filename: "yt-dlp_macos",
      url: "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_macos",
    };
  }

  if (platform === "win32") {
    return {
      filename: "yt-dlp.exe",
      url: "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe",
    };
  }

  if (arch === "arm64") {
    return {
      filename: "yt-dlp_linux_aarch64",
      url: "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux_aarch64",
    };
  }

  return {
    filename: "yt-dlp_linux",
    url: "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux",
  };
}

function unavailableError() {
  const error = new AppError(ErrorCode.UPSTREAM_BLOCKED, "服务器未安装 yt-dlp，无法使用 YouTube 下载引擎。", 502, {
    hint: "请安装 yt-dlp，或设置 YTDLP_PATH 指向 yt-dlp 可执行文件。",
  });
  error.ytDlpUnavailable = true;
  return error;
}

function toYtDlpError(error) {
  if (error?.code === "ENOENT") {
    return unavailableError();
  }

  if (error?.killed || error?.signal === "SIGTERM" || error?.name === "AbortError") {
    return new AppError(ErrorCode.UPSTREAM_BLOCKED, "yt-dlp 下载 YouTube 资源超时。", 504);
  }

  const message = compactOutput(error?.stderr || error?.stdout || error?.message);
  const lower = message.toLowerCase();

  if (lower.includes("private") || lower.includes("sign in") || lower.includes("login") || lower.includes("age")) {
    return new AppError(ErrorCode.LOGIN_REQUIRED, "这个 YouTube 内容需要登录或年龄验证。", 403, { cause: message });
  }

  if (lower.includes("unavailable") || lower.includes("not found") || lower.includes("no video")) {
    return new AppError(ErrorCode.NO_MEDIA_FOUND, "没有找到这个 YouTube 视频。", 404, { cause: message });
  }

  return new AppError(ErrorCode.UPSTREAM_BLOCKED, "yt-dlp 无法访问 YouTube 视频。", 502, { cause: message });
}

function bestVideoFormat(info) {
  if (Array.isArray(info.formats)) {
    return info.formats
      .filter((format) => format && format.vcodec && format.vcodec !== "none")
      .sort((left, right) => (Number(right.height) || 0) - (Number(left.height) || 0))[0] || null;
  }

  return null;
}

function existingOutputPath(outputPath, reportedPath) {
  return fs.stat(outputPath).then(() => outputPath).catch(async () => {
    if (!reportedPath || path.resolve(reportedPath) === outputPath) {
      return null;
    }

    return fs.stat(reportedPath).then(() => path.resolve(reportedPath)).catch(() => null);
  });
}

function lastOutputPath(value) {
  return String(value || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && path.isAbsolute(line))
    .at(-1) || "";
}

function firstEnv(names) {
  return names.map((name) => process.env[name]?.trim()).find(Boolean) || "";
}

function youtubeCookieHeader() {
  return ["SOCIAL_YOUTUBE_COOKIE", "SOCIAL_YOUTUBE_COOKIES", "YOUTUBE_COOKIE", "YOUTUBE_COOKIES"]
    .map((name) => process.env[name]?.trim())
    .find(Boolean) || "";
}

function optionalNumber(value) {
  if (value == null || value === "" || typeof value === "boolean") {
    return null;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : null;
}

function safePart(value) {
  return String(value || "video").replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 80) || "video";
}

function compactOutput(value) {
  return String(value || "").trim().replace(/\s+/g, " ").slice(-2000);
}
