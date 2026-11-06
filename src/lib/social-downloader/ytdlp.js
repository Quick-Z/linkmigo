import { execFile as execFileCallback, execFileSync, spawn } from "node:child_process";
import { createRequire } from "node:module";
import { chmodSync, existsSync, statSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { AppError, ErrorCode } from "./errors";
import { fetchWithTimeout, getProxyUrl } from "./utils";

const execFile = promisify(execFileCallback);
const require = createRequire(import.meta.url);
const packagedFfmpegPath = require("ffmpeg-static");

const DEFAULT_FORMAT = "bv*[ext=mp4]+ba[ext=m4a]/bv*[ext=mp4]/bv*+ba/b";
// YouTube serves video and audio as separate DASH streams, so the selector
// above always requires ffmpeg to merge them. Without ffmpeg yt-dlp does not
// fail: it downloads the streams separately, silently skips the merge and
// still exits 0, which surfaces as "yt-dlp 未生成下载文件" with no stderr. When
// no usable ffmpeg is found, fall back to a pre-merged (progressive) stream so
// the download still succeeds, at the quality YouTube serves muxed.
const PROGRESSIVE_FORMAT = "b[ext=mp4]/b";
const YTDLP_PATH_ENV_NAMES = ["YTDLP_PATH", "SOCIAL_YTDLP_PATH"];
const YTDLP_COOKIE_FILE_ENV_NAMES = ["YTDLP_COOKIES_FILE", "SOCIAL_YTDLP_COOKIES_FILE"];
const YTDLP_EXTRACTOR_ARGS_ENV_NAMES = ["YTDLP_EXTRACTOR_ARGS", "SOCIAL_YTDLP_EXTRACTOR_ARGS"];
const YTDLP_JS_RUNTIME_ENV_NAMES = ["YTDLP_JS_RUNTIME", "SOCIAL_YTDLP_JS_RUNTIME"];
// YouTube hands out short-lived, IP-bound media URLs. Downloads regularly die
// part-way through (the connection is dropped and the resumed request is then
// answered with HTTP 403), so a failed attempt is retried with a freshly
// extracted URL instead of failing the whole resolve.
const YTDLP_DOWNLOAD_ATTEMPTS = 3;
const YTDLP_METADATA_ATTEMPTS = 2;
const YTDLP_RETRY_DELAY_MS = 1000;
// yt-dlp's own progress output is the only way to know how far a transfer has
// gone; without it the UI can only show an indeterminate spinner. Each update
// is emitted as one tagged line so it can be told apart from yt-dlp's log.
const YTDLP_PROGRESS_MARKER = "__LM_PROGRESS__";
const YTDLP_PROGRESS_MIN_INTERVAL_MS = 400;
const OUTPUT_TAIL_CHARS = 200_000;
const RETRYABLE_ERROR_CODES = new Set([
  ErrorCode.UPSTREAM_BLOCKED,
  ErrorCode.DOWNLOAD_FAILED,
]);

let cachedExecutable = null;
let cachedExecutablePromise = null;
let cachedBinaryDownloadPromise = null;
let cachedFfmpegPath = null;
let warnedAboutMissingFfmpeg = false;

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
  // The selected streams' sizes are known straight from the extraction, so the
  // download can report a percentage from the very first byte instead of
  // waiting for yt-dlp to reveal a total half-way through.
  const expectedBytes = expectedDownloadBytes(details);
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
      expected_bytes: expectedBytes,
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
  // resolveFfmpegPath() only ever returns a binary it has proven runnable, and
  // repairing a lost executable bit happens during that probe.
  const ffmpegPath = resolveFfmpegPath();
  await fs.mkdir(path.dirname(outputPath), { recursive: true });

  // Merging video and audio is only possible with a working ffmpeg. Asking for
  // a merge without one does not make yt-dlp fail: it downloads the streams
  // separately, skips the merge and exits 0, leaving the caller with no file.
  // Choose a selector that matches what the host can actually produce.
  if (!ffmpegPath && !warnedAboutMissingFfmpeg) {
    warnedAboutMissingFfmpeg = true;
    console.warn(
      "[social-downloader] 未找到可用的 ffmpeg，YouTube 下载将回退到预合并流（画质受限）。"
      + "请在运行环境安装 ffmpeg，或设置 FFMPEG_PATH 指向 ffmpeg 可执行文件。",
    );
  }

  const formatSelector = ffmpegPath
    ? asset.ytdlp_format || DEFAULT_FORMAT
    : PROGRESSIVE_FORMAT;

  const budgetMs = Math.max(1, Number(timeoutMs) || 600_000);
  const deadlineAt = Date.now() + budgetMs;
  const expectedBytes = optionalNumber(asset.expected_bytes);
  let lastError = null;
  let attempts = 0;
  // Partial data survives a failed attempt so a multi-gigabyte 4K transfer
  // resumes instead of restarting from zero. It is discarded only when the
  // bytes on disk are themselves the problem (see shouldDiscardPartial).
  let discardPartial = false;

  // A finished file left over from an earlier run would make yt-dlp skip the
  // transfer entirely ("has already been downloaded") and hand back a stale
  // asset, so drop that one path up front. `.part` fragments are kept.
  await fs.unlink(outputPath).catch(() => {});

  for (let attempt = 1; attempt <= YTDLP_DOWNLOAD_ATTEMPTS; attempt += 1) {
    if (discardPartial) {
      await removeYtDlpPartialFiles(outputPath);
      discardPartial = false;
    }

    const remainingMs = deadlineAt - Date.now();

    if (remainingMs <= 0) {
      break;
    }

    attempts = attempt;

    let result;

    try {
      result = await runYtDlpDownload({
        sourceUrl,
        outputPath,
        ffmpegPath,
        formatSelector,
        argsTimeoutMs: budgetMs,
        processTimeoutMs: Math.min(budgetMs, remainingMs),
        onProgress,
        expectedBytes,
      });
    } catch (error) {
      const appError = withYtDlpAttempts(toYtDlpError(error), attempt);

      if (!isRetryableYtDlpError(appError) || attempt >= YTDLP_DOWNLOAD_ATTEMPTS) {
        throw appError;
      }

      lastError = appError;
      discardPartial = shouldDiscardPartial(error);
      await sleep(YTDLP_RETRY_DELAY_MS * attempt);
      continue;
    }

    const reportedPath = lastOutputPath(result.stdout);
    const finalPath = await existingOutputPath(outputPath, reportedPath);

    if (!finalPath) {
      // yt-dlp leaves "<stem>.fNNN.<ext>" behind when it downloaded the
      // separate video/audio streams but could not merge them. Retrying cannot
      // help: the missing piece is ffmpeg, not the network. Without this check
      // the run looks like a plain "no output file" failure with empty stderr.
      const streamParts = await ytDlpStreamPartFiles(outputPath);

      if (streamParts.length > 0) {
        await removeYtDlpPartialFiles(outputPath);
        throw withYtDlpAttempts(
          new AppError(
            ErrorCode.UPSTREAM_BLOCKED,
            "yt-dlp 已下载音视频分离流但未能合并，运行环境缺少可用的 ffmpeg。",
            502,
            {
              ffmpeg: ffmpegPath || "unavailable",
              leftover_files: streamParts.slice(0, 5),
              hint: "请确认运行环境存在可用的 ffmpeg（Docker 镜像已内置 ffmpeg-static 并通过 FFMPEG_PATH 指向它），或设置 FFMPEG_PATH 指向 ffmpeg 可执行文件后重试。",
            },
          ),
          attempt,
        );
      }

      const appError = withYtDlpAttempts(
        new AppError(ErrorCode.DOWNLOAD_FAILED, "yt-dlp 未生成下载文件。", 502, {
          stderr: compactOutput(result.stderr),
          stdout: compactOutput(result.stdout),
          ffmpeg: ffmpegPath || "unavailable",
        }),
        attempt,
      );

      if (attempt >= YTDLP_DOWNLOAD_ATTEMPTS) {
        await removeYtDlpPartialFiles(outputPath);
        throw appError;
      }

      lastError = appError;
      await sleep(YTDLP_RETRY_DELAY_MS * attempt);
      continue;
    }

    const stat = await fs.stat(finalPath);

    if (stat.size <= 0) {
      await removeYtDlpPartialFiles(outputPath);
      throw withYtDlpAttempts(
        new AppError(ErrorCode.DOWNLOAD_FAILED, "yt-dlp 生成了空媒体文件。", 502),
        attempt,
      );
    }

    if (stat.size > maxBytes) {
      await removeYtDlpPartialFiles(outputPath);
      throw withYtDlpAttempts(
        new AppError(ErrorCode.DOWNLOAD_FAILED, "媒体资源超过单文件大小限制。", 413),
        attempt,
      );
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
      contentType: contentTypeForMediaFile(outputPath),
      sizeBytes: stat.size,
    };
  }

  throw lastError ?? new AppError(
    ErrorCode.UPSTREAM_BLOCKED,
    "yt-dlp 下载 YouTube 资源超时。",
    504,
    { attempts },
  );
}

async function runYtDlpDownload({
  sourceUrl,
  outputPath,
  ffmpegPath,
  formatSelector,
  argsTimeoutMs,
  processTimeoutMs,
  onProgress,
  expectedBytes,
}) {
  const args = buildCommonArgs(argsTimeoutMs, ffmpegPath);
  args.push(
    "--format",
    formatSelector,
    "--merge-output-format",
    "mp4",
    "--output",
    outputPath,
    "--print",
    "after_move:filepath",
    // "--print" implies "--quiet", which silences the progress output. Without
    // "--progress" there is nothing to parse and the UI can only spin.
    "--progress",
    // Progress is normally rewritten in place with "\r"; a pipe needs one
    // update per line before it can be read.
    "--newline",
    "--progress-template",
    `download:${YTDLP_PROGRESS_MARKER}|%(progress.downloaded_bytes)s|`
      + "%(progress.total_bytes)s|%(progress.total_bytes_estimate)s",
    sourceUrl,
  );

  return await spawnYtDlp(args, {
    timeoutMs: processTimeoutMs,
    onStdoutLine: createYtDlpProgressReporter({ onProgress, expectedBytes }),
  });
}

// Replaces execFile so stdout can be consumed while yt-dlp is still running.
// execFile only resolves once the process exits, which is why a 1.5 GB
// transfer looked identical to a hang. Output is kept as a bounded tail: the
// only things read from it afterwards are the trailing filepath line and the
// teardown error.
async function spawnYtDlp(args, { timeoutMs, onStdoutLine }) {
  const executable = await getYtDlpExecutable();

  return await new Promise((resolve, reject) => {
    const child = spawn(executable, args, { windowsHide: true });
    let stdout = "";
    let stderr = "";
    let stdoutRemainder = "";
    let timedOut = false;
    let settled = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      // yt-dlp normally honours SIGTERM; make sure a wedged process cannot
      // keep the request (and the job) alive forever.
      setTimeout(() => child.kill("SIGKILL"), 15_000).unref?.();
    }, Math.max(1, Number(timeoutMs) || 600_000));

    const settle = (error) => {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timer);

      if (error) {
        reject(error);
        return;
      }

      resolve({ stdout, stderr });
    };

    child.stdout.on("data", (chunk) => {
      const text = chunk.toString();
      stdout = appendTail(stdout, text);
      stdoutRemainder = drainLines(stdoutRemainder, text, onStdoutLine);
    });

    child.stderr.on("data", (chunk) => {
      stderr = appendTail(stderr, chunk.toString());
    });

    child.on("error", (error) => {
      error.stderr = stderr;
      error.stdout = stdout;
      settle(error);
    });

    child.on("close", (code, signal) => {
      if (timedOut) {
        const error = new Error("yt-dlp 下载超时。");
        error.killed = true;
        error.signal = signal;
        error.stderr = stderr;
        error.stdout = stdout;
        settle(error);
        return;
      }

      if (code !== 0) {
        const error = new Error(`yt-dlp exited with code ${code}`);
        error.exitCode = code;
        error.signal = signal;
        error.stderr = stderr;
        error.stdout = stdout;
        settle(error);
        return;
      }

      settle(null);
    });
  });
}

function appendTail(buffer, chunk) {
  const next = buffer + chunk;

  return next.length > OUTPUT_TAIL_CHARS ? next.slice(-OUTPUT_TAIL_CHARS) : next;
}

function drainLines(buffer, chunk, onLine) {
  let rest = buffer + chunk;
  let index = rest.indexOf("\n");

  while (index >= 0) {
    const line = rest.slice(0, index).replace(/\r$/, "");

    rest = rest.slice(index + 1);

    if (line && onLine) {
      onLine(line);
    }

    index = rest.indexOf("\n");
  }

  return rest.length > OUTPUT_TAIL_CHARS ? rest.slice(-OUTPUT_TAIL_CHARS) : rest;
}

// Video and audio arrive as two separate streams, so yt-dlp reports progress
// per stream and resets to zero for the second one. Folding each finished
// stream into a baseline keeps one monotonic overall percentage.
function createYtDlpProgressReporter({ onProgress, expectedBytes }) {
  if (!onProgress) {
    return () => {};
  }

  let baselineBytes = 0;
  let streamTotalBytes = 0;
  let streamDownloadedBytes = 0;
  let started = false;
  let lastEmitAt = 0;

  return (line) => {
    if (!line.startsWith(`${YTDLP_PROGRESS_MARKER}|`)) {
      return;
    }

    const [, downloadedRaw, totalRaw, estimateRaw] = line.split("|");
    const downloaded = optionalNumber(downloadedRaw);

    if (downloaded == null) {
      return;
    }

    if (started && downloaded < streamDownloadedBytes) {
      baselineBytes += streamTotalBytes || streamDownloadedBytes;
      streamTotalBytes = 0;
    }

    started = true;
    streamDownloadedBytes = downloaded;
    streamTotalBytes = optionalNumber(totalRaw) || optionalNumber(estimateRaw) || streamTotalBytes || 0;

    const now = Date.now();

    if (now - lastEmitAt < YTDLP_PROGRESS_MIN_INTERVAL_MS) {
      return;
    }

    lastEmitAt = now;

    const downloadedBytes = baselineBytes + streamDownloadedBytes;
    // The static estimate only fills in until the transfer reports its own
    // total, and never below what the streams themselves add up to.
    const totalBytes = Math.max(
      baselineBytes + streamTotalBytes,
      expectedBytes || 0,
    ) || null;

    onProgress({
      type: "stream_progress",
      part_id: "media",
      content_length: totalBytes,
      downloaded_bytes: downloadedBytes,
    });
  };
}

// A resumed transfer sends a Range request against a freshly signed URL. When
// YouTube answers that with 403 the cached bytes can never be used, so the only
// way forward is a clean start. Everything else (timeout, dropped connection,
// rate limiting) is worth resuming.
function shouldDiscardPartial(error) {
  const text = ytDlpErrorText(String(error?.stderr || error?.stdout || error?.message || "")).toLowerCase();

  return text.includes("http error 403") || text.includes("forbidden");
}

// A failed attempt may leave `.part` fragments (and unmerged `.fNNN.ext`
// files) behind. They have to disappear before the retry, otherwise yt-dlp
// resumes them and YouTube rejects the resumed request.
async function ytDlpSidecarFiles(outputPath, predicate) {
  const directory = path.dirname(outputPath);
  const base = path.basename(outputPath);
  // Stream parts are written as "<stem>.fNNN.<ext>": yt-dlp keeps the output's
  // base name without its extension, which is why a plain `${base}.` prefix
  // never matched them and the leftovers stayed on disk forever.
  const extension = path.extname(base);
  const stem = extension ? base.slice(0, -extension.length) : base;
  let entries;

  try {
    entries = await fs.readdir(directory);
  } catch {
    return [];
  }

  return entries.filter((name) => predicate(name, base, stem));
}

function isYtDlpStreamPartFile(name, stem) {
  // yt-dlp writes a stream as "<stem>.fNNN.<ext>" and keeps an in-progress
  // download of it as "<stem>.fNNN.<ext>.part" (or ".part-FragN" for
  // fragmented ones), so drop that suffix before matching.
  const completed = name.replace(/\.part(?:-Frag\d+)?$/, "");

  return completed.startsWith(`${stem}.`) && /\.f\d+\.[A-Za-z0-9]+$/.test(completed);
}

function isYtDlpTemporaryFile(name, base, stem) {
  // "<output>.part", plus "<output>.part-FragN" for fragmented downloads.
  if (name.startsWith(`${base}.part`)) {
    return true;
  }

  return isYtDlpStreamPartFile(name, stem);
}

async function removeYtDlpPartialFiles(outputPath) {
  const directory = path.dirname(outputPath);
  const targets = await ytDlpSidecarFiles(outputPath, isYtDlpTemporaryFile);

  await Promise.all(targets.map((name) => fs.unlink(path.join(directory, name)).catch(() => {})));
}

// Per-stream files that only exist because a merge never happened.
async function ytDlpStreamPartFiles(outputPath) {
  return await ytDlpSidecarFiles(outputPath, (name, base, stem) => isYtDlpStreamPartFile(name, stem));
}

function isRetryableYtDlpError(error) {
  if (!(error instanceof AppError)) {
    return true;
  }

  // A missing/unusable yt-dlp binary or an oversized asset never recovers by
  // retrying the same transaction.
  if (error.ytDlpUnavailable || error.status === 413) {
    return false;
  }

  return RETRYABLE_ERROR_CODES.has(error.code);
}

function withYtDlpAttempts(error, attempts) {
  if (attempts <= 1 || !(error instanceof AppError)) {
    return error;
  }

  error.details = {
    ...(error.details || {}),
    ytdlp_attempts: attempts,
  };

  return error;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
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
  let lastError = null;

  // Metadata extraction talks to the same rate-limited endpoints as the media
  // download, so a transport hiccup is retried once before giving up.
  for (let attempt = 1; attempt <= YTDLP_METADATA_ATTEMPTS; attempt += 1) {
    try {
      const { stdout, stderr } = await execFile(await getYtDlpExecutable(), args, {
        timeout: timeoutMs,
        maxBuffer: 64 * 1024 * 1024,
        windowsHide: true,
      });
      const text = String(stdout || "").trim();

      if (!text) {
        throw withYtDlpAttempts(
          new AppError(ErrorCode.NO_MEDIA_FOUND, "yt-dlp 没有返回 YouTube 视频信息。", 404, {
            stderr: compactOutput(stderr),
          }),
          attempt,
        );
      }

      try {
        return JSON.parse(text);
      } catch {
        return JSON.parse(text.split("\n").filter(Boolean).at(-1));
      }
    } catch (error) {
      const appError = withYtDlpAttempts(toYtDlpError(error), attempt);

      if (!isRetryableYtDlpError(appError) || attempt >= YTDLP_METADATA_ATTEMPTS) {
        throw appError;
      }

      lastError = appError;
      await sleep(YTDLP_RETRY_DELAY_MS * attempt);
    }
  }

  throw lastError ?? new AppError(ErrorCode.UPSTREAM_BLOCKED, "yt-dlp 无法访问 YouTube 视频。", 502);
}

function buildCommonArgs(timeoutMs, ffmpegPath = resolveFfmpegPath()) {
  const args = [
    "--no-playlist",
    // Deliberately not --no-warnings: the warning that explains a skipped merge
    // ("...but ffmpeg is not installed. The formats won't be merged") is the
    // only signal yt-dlp emits before exiting 0 without an output file.
    // Suppressing it is what made this failure report an empty stderr.
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

export function resolveFfmpegPath() {
  if (cachedFfmpegPath !== null) {
    return cachedFfmpegPath;
  }

  const binaryName = process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg";
  const candidates = [
    process.env.FFMPEG_PATH?.trim(),
    packagedFfmpegPath,
    ...packagedFfmpegCandidates(binaryName),
    process.platform === "darwin" ? "/opt/homebrew/bin/ffmpeg" : "",
    "/usr/local/bin/ffmpeg",
    "/usr/bin/ffmpeg",
    ...pathFfmpegCandidates(binaryName),
  ].filter(Boolean);

  cachedFfmpegPath = candidates
    .map((candidate) => usableFfmpegPath(candidate, binaryName))
    .find(Boolean) || "";

  return cachedFfmpegPath;
}

// Next.js bundles ffmpeg-static into the server chunk and rewrites the module's
// __dirname to a placeholder, so require("ffmpeg-static") reports a path that
// does not exist in the standalone output (observed: /ROOT/node_modules/
// ffmpeg-static/ffmpeg). Look where the package actually is as well; the
// Dockerfile copies it next to the standalone bundle.
function packagedFfmpegCandidates(binaryName) {
  const roots = [...new Set([process.cwd(), "/app"].filter(Boolean))];

  return roots.map((root) => path.join(root, "node_modules", "ffmpeg-static", binaryName));
}

function pathFfmpegCandidates(binaryName) {
  return String(process.env.PATH || "")
    .split(path.delimiter)
    .map((directory) => directory.trim())
    .filter(Boolean)
    .map((directory) => path.join(directory, binaryName));
}

// A file simply existing is not enough: ffmpeg-static downloads its binary
// during `npm install`, so a blocked or interrupted download leaves a
// truncated (or foreign-architecture) file that `existsSync` happily reports.
// yt-dlp then cannot execute it and silently stops merging, which is
// indistinguishable from ffmpeg being absent. Prove it runs before trusting it.
// Returns a runnable binary path, or "" when the candidate is unusable.
function usableFfmpegPath(candidate, binaryName, depth = 0) {
  if (!candidate || !existsSync(candidate)) {
    return "";
  }

  let stats;

  try {
    stats = statSync(candidate);
  } catch {
    return "";
  }

  // yt-dlp accepts either the binary or its containing directory, so probe the
  // binary inside. That keeps this function's contract (only return a path
  // proven to run) without rejecting a directory-valued FFMPEG_PATH.
  if (stats.isDirectory()) {
    return depth >= 1
      ? ""
      : usableFfmpegPath(path.join(candidate, binaryName), binaryName, depth + 1);
  }

  if (runsFfmpeg(candidate)) {
    return candidate;
  }

  // npm packages occasionally lose the executable bit when copied between
  // filesystems (notably macOS bind mounts). Repair the mode once and retry
  // rather than silently degrading to a lower-quality pre-merged stream.
  try {
    chmodSync(candidate, 0o755);
  } catch {
    return "";
  }

  return runsFfmpeg(candidate) ? candidate : "";
}

function runsFfmpeg(candidate) {
  try {
    execFileSync(candidate, ["-version"], {
      timeout: 5_000,
      stdio: "ignore",
      windowsHide: true,
    });

    return true;
  } catch {
    return false;
  }
}

// The progressive fallback can legitimately resolve to a WebM container, so
// report what was actually written rather than always claiming MP4.
function contentTypeForMediaFile(filePath) {
  return path.extname(filePath).toLowerCase() === ".webm" ? "video/webm" : "video/mp4";
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

  const rawOutput = String(error?.stderr || error?.stdout || error?.message || "");
  const message = compactOutput(rawOutput);
  const lower = ytDlpErrorText(rawOutput).toLowerCase();

  if (
    lower.includes("private")
    || lower.includes("sign in")
    || lower.includes("login")
    // A bare "age" substring also matches "webpage", "page" and "message",
    // which appear in almost every yt-dlp YouTube failure.
    || /\bage\b/.test(lower)
  ) {
    return new AppError(ErrorCode.LOGIN_REQUIRED, "这个 YouTube 内容需要登录或年龄验证。", 403, { cause: message });
  }

  if (lower.includes("unavailable") || lower.includes("not found") || lower.includes("no video")) {
    return new AppError(ErrorCode.NO_MEDIA_FOUND, "没有找到这个 YouTube 视频。", 404, { cause: message });
  }

  // The signature/session of a googlevideo URL expired or the exit IP changed
  // while the media was being transferred. Retries already happened by the
  // time this error reaches the client.
  if (lower.includes("http error 403") || lower.includes("forbidden")) {
    return new AppError(ErrorCode.UPSTREAM_BLOCKED, "YouTube 拒绝提供媒体数据（HTTP 403）。", 502, {
      cause: message,
      hint: "多由代理出口 IP 变化或被 YouTube 限流引起：可更换代理节点，或为 yt-dlp 配置 Cookie（YTDLP_COOKIES_FILE / SOCIAL_YOUTUBE_COOKIE）后重试。",
    });
  }

  // Deterministic format-selection failure. Retrying the same selector cannot
  // help, and the usual cause is a missing ffmpeg on a video that YouTube does
  // not offer as a pre-merged stream.
  if (lower.includes("requested format is not available") || lower.includes("no matching formats")) {
    return new AppError(
      ErrorCode.NO_MEDIA_FOUND,
      "没有找到可下载的视频格式（该视频没有预合并流，且当前环境没有可用的 ffmpeg）。",
      404,
      {
        cause: message,
        ffmpeg: resolveFfmpegPath() || "unavailable",
        hint: "安装 ffmpeg 或设置 FFMPEG_PATH 后重试即可下载最高画质。",
      },
    );
  }

  return new AppError(ErrorCode.UPSTREAM_BLOCKED, "yt-dlp 无法访问 YouTube 视频。", 502, { cause: message });
}

// Only yt-dlp's own ERROR lines may drive classification. Warnings are
// informational and can mention "403", "unavailable" or similar; letting them
// match would turn a retryable transient failure into a permanent one and skip
// the whole retry loop.
function ytDlpErrorText(output) {
  const text = String(output || "");
  const errorLines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^ERROR:/i.test(line));

  return errorLines.length > 0 ? errorLines.join(" ") : text;
}

function bestVideoFormat(info) {
  if (Array.isArray(info.formats)) {
    return info.formats
      .filter((format) => format && format.vcodec && format.vcodec !== "none")
      // Highest resolution wins; mp4 breaks ties so the reported size matches
      // what DEFAULT_FORMAT ("bv*[ext=mp4]") actually downloads, and a format
      // that declares its size beats one that does not (YouTube exposes
      // sizeless placeholders such as format 625 next to the real 4K stream).
      .sort((left, right) => {
        const heightDelta = (Number(right.height) || 0) - (Number(left.height) || 0);

        if (heightDelta !== 0) {
          return heightDelta;
        }

        const mp4Delta = (right.ext === "mp4" ? 1 : 0) - (left.ext === "mp4" ? 1 : 0);

        if (mp4Delta !== 0) {
          return mp4Delta;
        }

        return (formatApproxBytes(right) ? 1 : 0) - (formatApproxBytes(left) ? 1 : 0);
      })[0] || null;
  }

  return null;
}

function formatApproxBytes(format) {
  return optionalNumber(format?.filesize) || optionalNumber(format?.filesize_approx) || 0;
}

// DEFAULT_FORMAT downloads the best video plus the best m4a audio, so the
// expected total has to cover both streams. yt-dlp already reports the size of
// its own default selection at the top level, which is the most accurate
// source; the per-format sum is only a fallback.
function expectedDownloadBytes(details) {
  const reportedTotal = optionalNumber(details?.filesize) || optionalNumber(details?.filesize_approx);

  if (reportedTotal) {
    return reportedTotal;
  }

  const video = bestVideoFormat(details);

  if (!video) {
    return null;
  }

  if (video.acodec && video.acodec !== "none") {
    return formatApproxBytes(video) || null;
  }

  const formats = Array.isArray(details.formats) ? details.formats : [];
  const audio = formats
    .filter((format) =>
      format &&
      format.vcodec === "none" &&
      format.acodec &&
      format.acodec !== "none" &&
      !format.is_live,
    )
    .sort((left, right) => {
      const m4aDelta = (right.ext === "m4a" ? 1 : 0) - (left.ext === "m4a" ? 1 : 0);

      if (m4aDelta !== 0) {
        return m4aDelta;
      }

      return (Number(right.abr) || 0) - (Number(left.abr) || 0);
    })[0];

  return formatApproxBytes(video) + formatApproxBytes(audio) || null;
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
