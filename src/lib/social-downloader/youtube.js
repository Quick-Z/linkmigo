import vm from "node:vm";

import ytdl from "@distube/ytdl-core";
import { Innertube, Platform } from "youtubei.js";

import { AppError, ErrorCode } from "./errors";
import {
  fetchWithTimeout,
  firstPresentInt,
  getProxyUrl,
  isSocksProxyUrl,
  optionalInt,
} from "./utils";
import {
  createPostInfo,
  normalizeTags,
  pickSingleLineText,
  pickText,
} from "./post-info";

const YOUTUBE_VIDEO_ID_PATTERN = /^[A-Za-z0-9_-]{11}$/;

let cachedYtdlAgent = null;
let cachedYtdlAgentProxyUrl = "";
let cachedInnertubeClientPromise = null;
let cachedInnertubeProxyUrl = "";
let cachedInnertubeTimeoutMs = 0;
let evaluatorInstalled = false;

export function normalizeYoutubeUrl(parsed) {
  const host = parsed.hostname.toLowerCase();
  const parts = parsed.pathname.split("/").filter(Boolean);
  let videoId = "";
  let kind = "video";

  if (host === "youtu.be" || host === "www.youtu.be") {
    videoId = parts[0] ?? "";
  } else if (parts[0] === "watch") {
    videoId = parsed.searchParams.get("v") ?? "";
  } else if (["embed", "live", "shorts", "v"].includes(parts[0])) {
    videoId = parts[1] ?? "";
    kind = parts[0] === "shorts" ? "short" : "video";
  }

  if (!YOUTUBE_VIDEO_ID_PATTERN.test(videoId)) {
    throw new AppError(ErrorCode.UNSUPPORTED_URL, "仅支持 YouTube 视频或 Shorts 链接。", 400);
  }

  return {
    canonical_url: `https://www.youtube.com/watch?v=${videoId}`,
    shortcode: videoId,
    kind,
    platform: "youtube",
  };
}

export async function resolveYoutubePost(normalized, settings) {
  try {
    return await resolveYoutubePostWithInnertube(normalized, settings);
  } catch (error) {
    const primaryError = toYoutubeAppError(error);

    try {
      return await resolveYoutubePostWithYtdl(normalized, settings);
    } catch {
      throw primaryError;
    }
  }
}

async function resolveYoutubePostWithInnertube(normalized, settings) {
  const client = await getInnertubeClient(settings);
  const info = await client.getBasicInfo(normalized.shortcode, { client: "ANDROID_VR" });
  const details = info?.basic_info && typeof info.basic_info === "object" ? info.basic_info : {};

  if (details.is_private) {
    throw new AppError(ErrorCode.LOGIN_REQUIRED, "这个 YouTube 视频是私密内容，需要登录或授权。", 403);
  }

  if (details.is_live || details.is_live_content || details.is_post_live_dvr) {
    throw new AppError(ErrorCode.NO_MEDIA_FOUND, "暂不支持下载 YouTube 直播内容。", 404);
  }

  const formats = await getInnertubeDownloadFormats(client, info);
  const format = formats?.video;

  if (!format?.url) {
    throw new AppError(ErrorCode.NO_MEDIA_FOUND, "YouTube 页面中没有发现可下载的视频资源。", 404);
  }

  const headers = youtubeMediaHeaders(normalized.canonical_url);
  const qualityLabel = safeFilenamePart(format.quality_label || (format.height ? `${format.height}p` : "video"));
  const filenameBase = `youtube_${safeFilenamePart(details.id || normalized.shortcode)}_${qualityLabel}`;
  const asset = {
    source_url: format.url,
    media_type: "video",
    width: optionalInt(format.width),
    height: optionalInt(format.height),
    filename_hint: `${filenameBase}.mp4`,
    request_headers: headers,
  };

  if (formats.audio?.url) {
    asset.audio_source_url = formats.audio.url;
    asset.audio_filename_hint = `${filenameBase}_audio${innertubeAudioFormatExtension(formats.audio)}`;
    asset.audio_request_headers = headers;
    asset.filename_hint = `${filenameBase}${innertubeFormatExtension(format)}`;
  } else {
    asset.filename_hint = `${filenameBase}${innertubeFormatExtension(format)}`;
  }

  const metrics = {
    like_count: null,
    comment_count: null,
    view_count: optionalInt(details.view_count),
    save_count: null,
    share_count: null,
    source: "youtubei_best_effort",
  };
  const creatorHandle = youtubeInnertubeCreatorHandle(details);

  return {
    assets: [asset],
    metrics,
    creator_handle: creatorHandle,
    post_info: postInfoFromInnertube(details, metrics, creatorHandle),
  };
}

async function getInnertubeDownloadFormats(client, info) {
  const video = await getInnertubeFormat(client, info, [
    { type: "video", quality: "best", format: "any" },
    { type: "video", quality: "best", format: "mp4" },
  ]);
  const audio = await getInnertubeFormat(client, info, innertubeAudioOptionsForVideo(video));

  if (video?.url && audio?.url) {
    return { video, audio };
  }

  const progressive = await getInnertubeFormat(client, info, [
    { type: "video+audio", quality: "best", format: "any" },
    { type: "video+audio", quality: "best", format: "mp4" },
  ]);

  return progressive?.url ? { video: progressive, audio: null } : null;
}

async function getInnertubeFormat(client, info, optionsList) {
  for (const options of optionsList) {
    try {
      const format = info.chooseFormat(options);

      format.url = await format.decipher(client.session.player);

      return format;
    } catch (error) {
      if (!isInnertubeFormatSelectionError(error)) {
        throw error;
      }
    }
  }

  return null;
}

async function getInnertubeClient(settings) {
  const proxyUrl = getProxyUrl();

  if (
    cachedInnertubeClientPromise &&
    cachedInnertubeProxyUrl === proxyUrl &&
    cachedInnertubeTimeoutMs === settings.httpTimeoutMs
  ) {
    return await cachedInnertubeClientPromise;
  }

  installYoutubeEvaluator();

  cachedInnertubeProxyUrl = proxyUrl;
  cachedInnertubeTimeoutMs = settings.httpTimeoutMs;
  cachedInnertubeClientPromise = Innertube.create({
    fetch: createYoutubeFetch(settings),
    lang: "en",
    location: "US",
    retrieve_player: true,
  });

  return await cachedInnertubeClientPromise;
}

function createYoutubeFetch(settings) {
  return async function youtubeFetch(input, init = {}) {
    const { target, fetchInit } = normalizeYoutubeFetchInput(input, init);

    return await fetchWithTimeout(target, fetchInit, settings.httpTimeoutMs);
  };
}

function normalizeYoutubeFetchInput(input, init) {
  const isRequest =
    input &&
    typeof input === "object" &&
    typeof input.url === "string" &&
    typeof input.method === "string";
  const headers = new Headers(isRequest ? input.headers : undefined);

  if (init.headers) {
    new Headers(init.headers).forEach((value, key) => headers.set(key, value));
  }

  const fetchInit = {
    redirect: "follow",
    ...(isRequest
      ? {
          method: input.method,
          body: input.body,
          signal: input.signal,
        }
      : {}),
    ...init,
    headers,
  };

  if (fetchInit.body && !fetchInit.duplex) {
    fetchInit.duplex = "half";
  }

  return {
    target: isRequest ? input.url : input,
    fetchInit,
  };
}

function installYoutubeEvaluator() {
  if (evaluatorInstalled) {
    return;
  }

  Platform.load({
    ...Platform.shim,
    eval(data, env) {
      const context = vm.createContext({ ...env });
      const script = new vm.Script(`(function(){\n${data.output}\n})()`);

      return script.runInContext(context, { timeout: 1000 });
    },
  });
  evaluatorInstalled = true;
}

function innertubeFormatExtension(format) {
  const mimeType = String(format.mime_type || "").toLowerCase();

  return mimeType.includes("webm") ? ".webm" : ".mp4";
}

function innertubeAudioOptionsForVideo(video) {
  if (innertubeFormatExtension(video) === ".webm") {
    return [
      { type: "audio", quality: "best", format: "webm" },
      { type: "audio", quality: "best", format: "any" },
      { type: "audio", quality: "best", format: "mp4" },
    ];
  }

  return [
    { type: "audio", quality: "best", format: "mp4" },
    { type: "audio", quality: "best", format: "any" },
  ];
}

function innertubeAudioFormatExtension(format) {
  const mimeType = String(format.mime_type || "").toLowerCase();

  if (mimeType.includes("mpeg")) {
    return ".mp3";
  }

  return mimeType.includes("webm") ? ".webm" : ".m4a";
}

function isInnertubeFormatSelectionError(error) {
  const message = error instanceof Error ? error.message.toLowerCase() : String(error || "").toLowerCase();

  return message.includes("no matching formats") || message.includes("streaming data not available");
}

function youtubeInnertubeCreatorHandle(details) {
  const channel = details.channel && typeof details.channel === "object" ? details.channel : {};

  return channel.name || details.author || "";
}

function postInfoFromInnertube(details, metrics, creatorHandle) {
  const channel = details?.channel && typeof details.channel === "object" ? details.channel : {};
  const body = pickText(details?.short_description, details?.description);

  return createPostInfo(
    {
      title: pickSingleLineText(details?.title),
      author: pickSingleLineText(channel.name, details?.author, creatorHandle),
      author_handle: pickSingleLineText(channel.name, creatorHandle),
      body,
      tags: normalizeTags(details?.keywords, body),
      metrics,
      source: metrics?.source || "youtubei_best_effort",
    },
    { metrics, creatorHandle, source: metrics?.source || "youtubei_best_effort" },
  );
}

async function resolveYoutubePostWithYtdl(normalized, settings) {
  const info = await getYtdlInfo(normalized.canonical_url, settings);
  const details = info?.videoDetails && typeof info.videoDetails === "object" ? info.videoDetails : {};

  if (details.isPrivate) {
    throw new AppError(ErrorCode.LOGIN_REQUIRED, "这个 YouTube 视频是私密内容，需要登录或授权。", 403);
  }

  if (details.isLive || details.isLiveContent) {
    throw new AppError(ErrorCode.NO_MEDIA_FOUND, "暂不支持下载 YouTube 直播内容。", 404);
  }

  const formats = orderedYtdlVideoFormats(info?.formats);
  const format = formats[0];
  const audioFormats = orderedYtdlAudioFormats(info?.formats, format?.container);
  const audioFormat = format?.hasAudio ? null : audioFormats[0];

  if (!format) {
    throw new AppError(ErrorCode.NO_MEDIA_FOUND, "YouTube 页面中没有发现可下载的视频资源。", 404);
  }

  const qualityLabel = safeFilenamePart(format.qualityLabel || (format.height ? `${format.height}p` : "video"));
  const filenameBase = `youtube_${safeFilenamePart(details.videoId || normalized.shortcode)}_${qualityLabel}`;
  const headers = youtubeMediaHeaders(normalized.canonical_url);
  const asset = {
    source_url: format.url,
    fallback_urls: formats
      .slice(1)
      .filter((candidate) => candidate.container === format.container)
      .map((candidate) => candidate.url),
    media_type: "video",
    width: optionalInt(format.width),
    height: optionalInt(format.height),
    filename_hint: `${filenameBase}${audioFormat ? ".mp4" : format.container === "webm" ? ".webm" : ".mp4"}`,
    request_headers: headers,
  };

  if (audioFormat?.url) {
    asset.audio_source_url = audioFormat.url;
    asset.audio_fallback_urls = audioFormats
      .slice(1)
      .filter((candidate) => candidate.container === audioFormat.container)
      .map((candidate) => candidate.url);
    asset.audio_filename_hint = `${filenameBase}_audio${audioFormat.container === "webm" ? ".webm" : ".m4a"}`;
    asset.audio_request_headers = headers;
  }

  const metrics = {
    like_count: optionalInt(details.likes),
    comment_count: null,
    view_count: optionalInt(details.viewCount),
    save_count: null,
    share_count: null,
    source: "youtube_ytdl_best_effort",
  };
  const creatorHandle = ytdlCreatorHandle(details);

  return {
    assets: [asset],
    metrics,
    creator_handle: creatorHandle,
    post_info: postInfoFromYtdl(details, metrics, creatorHandle),
  };
}

async function getYtdlInfo(url, settings) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), settings.httpTimeoutMs);

  try {
    return await ytdl.getInfo(url, {
      agent: getYtdlAgent(),
      requestOptions: {
        signal: controller.signal,
      },
    });
  } finally {
    clearTimeout(timeout);
  }
}

function getYtdlAgent() {
  const proxyUrl = getProxyUrl();

  if (!proxyUrl) {
    cachedYtdlAgent = null;
    cachedYtdlAgentProxyUrl = "";
    return undefined;
  }

  if (isSocksProxyUrl(proxyUrl)) {
    cachedYtdlAgent = null;
    cachedYtdlAgentProxyUrl = "";
    return undefined;
  }

  if (cachedYtdlAgent && cachedYtdlAgentProxyUrl === proxyUrl) {
    return cachedYtdlAgent;
  }

  cachedYtdlAgent = ytdl.createProxyAgent({ uri: proxyUrl });
  cachedYtdlAgentProxyUrl = proxyUrl;

  return cachedYtdlAgent;
}

function orderedYtdlVideoFormats(formats) {
  if (!Array.isArray(formats)) {
    return [];
  }

  const usable = formats.filter((format) =>
    format &&
    typeof format === "object" &&
    typeof format.url === "string" &&
    /^https?:\/\//i.test(format.url) &&
    format.hasVideo &&
    !format.isLive &&
    ["mp4", "webm"].includes(format.container),
  );
  const pools = [
    usable.filter((format) => !format.hasAudio),
    usable.filter((format) => format.hasAudio),
    usable,
  ];
  const selectedPool = pools.find((pool) => pool.length > 0) ?? [];

  return selectedPool.sort(compareYtdlFormats);
}

function orderedYtdlAudioFormats(formats, preferredContainer = "") {
  if (!Array.isArray(formats)) {
    return [];
  }

  const usable = formats.filter((format) =>
    format &&
    typeof format === "object" &&
    typeof format.url === "string" &&
    /^https?:\/\//i.test(format.url) &&
    format.hasAudio &&
    !format.hasVideo &&
    !format.isLive &&
    ["mp4", "webm"].includes(format.container),
  );
  const pools = [
    usable.filter((format) => format.container === preferredContainer),
    usable.filter((format) => format.container === "mp4"),
    usable,
  ];
  const selectedPool = pools.find((pool) => pool.length > 0) ?? [];

  return selectedPool.sort(compareYtdlAudioFormats);
}

function compareYtdlFormats(left, right) {
  const leftScore = ytdlFormatScore(left);
  const rightScore = ytdlFormatScore(right);

  for (let index = 0; index < leftScore.length; index += 1) {
    if (leftScore[index] !== rightScore[index]) {
      return rightScore[index] - leftScore[index];
    }
  }

  return 0;
}

function compareYtdlAudioFormats(left, right) {
  const leftScore = ytdlAudioFormatScore(left);
  const rightScore = ytdlAudioFormatScore(right);

  for (let index = 0; index < leftScore.length; index += 1) {
    if (leftScore[index] !== rightScore[index]) {
      return rightScore[index] - leftScore[index];
    }
  }

  return 0;
}

function ytdlFormatScore(format) {
  return [
    optionalInt(format.height) || 0,
    optionalInt(format.width) || 0,
    optionalInt(format.fps) || 0,
    firstPresentInt(format.bitrate, format.averageBitrate) || 0,
    format.container === "mp4" ? 1 : 0,
  ];
}

function ytdlAudioFormatScore(format) {
  return [
    format.container === "mp4" ? 1 : 0,
    firstPresentInt(format.audioBitrate, format.bitrate, format.averageBitrate) || 0,
  ];
}

function youtubeMediaHeaders(pageUrl) {
  return {
    Referer: pageUrl,
    Origin: "https://www.youtube.com",
  };
}

function ytdlCreatorHandle(details) {
  const author = details.author;

  if (author && typeof author === "object") {
    return author.user || author.name || details.ownerChannelName || "";
  }

  return author || details.ownerChannelName || "";
}

function postInfoFromYtdl(details, metrics, creatorHandle) {
  const author = details?.author && typeof details.author === "object" ? details.author : {};
  const body = pickText(details?.description, details?.shortDescription);

  return createPostInfo(
    {
      title: pickSingleLineText(details?.title),
      author: pickSingleLineText(author.name, details?.ownerChannelName, creatorHandle),
      author_handle: pickSingleLineText(author.user, author.name, creatorHandle),
      body,
      tags: normalizeTags(details?.keywords, body),
      metrics,
      source: metrics?.source || "youtube_ytdl_best_effort",
    },
    { metrics, creatorHandle, source: metrics?.source || "youtube_ytdl_best_effort" },
  );
}

function toYoutubeAppError(error) {
  if (error instanceof AppError) {
    return error;
  }

  const message = error instanceof Error ? error.message : String(error || "");
  const lower = message.toLowerCase();

  if (error?.name === "AbortError" || lower.includes("aborted")) {
    return new AppError(ErrorCode.UPSTREAM_BLOCKED, "YouTube 页面请求超时。", 504);
  }

  if (lower.includes("private") || lower.includes("login") || lower.includes("sign in") || lower.includes("age")) {
    return new AppError(ErrorCode.LOGIN_REQUIRED, "这个 YouTube 内容需要登录或年龄验证。", 403);
  }

  if (
    lower.includes("unavailable") ||
    lower.includes("not found") ||
    lower.includes("no video id") ||
    lower.includes("no matching formats") ||
    lower.includes("streaming data not available")
  ) {
    return new AppError(ErrorCode.NO_MEDIA_FOUND, "没有找到这个 YouTube 视频。", 404);
  }

  return new AppError(
    ErrorCode.UPSTREAM_BLOCKED,
    `无法访问 YouTube 页面（${message || "网络连接失败"}）。`,
    502,
    {
      proxy: getProxyUrl() ? "enabled" : "disabled",
      hint: "请确认服务器网络或系统代理可访问 YouTube；也可以在 .env.local 配置 SOCIAL_PROXY_URL，例如 http://127.0.0.1:7890。",
    },
  );
}

function safeFilenamePart(value) {
  return String(value || "unknown")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^[-._]+|[-._]+$/g, "") || "unknown";
}
