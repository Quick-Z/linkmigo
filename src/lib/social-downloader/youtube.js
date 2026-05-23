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
const YOUTUBE_HOSTS = new Set([
  "youtube.com",
  "www.youtube.com",
  "m.youtube.com",
  "music.youtube.com",
  "youtu.be",
  "www.youtu.be",
  "youtube-nocookie.com",
  "www.youtube-nocookie.com",
]);
const INNERTUBE_CLIENTS = ["ANDROID_VR", "IOS", "ANDROID", "WEB", "WEB_EMBEDDED", "TV", "MWEB"];
const YTDL_PLAYER_CLIENTS = ["WEB_EMBEDDED", "IOS", "ANDROID", "TV", "WEB"];
const YOUTUBE_COMMENT_SORT = "TOP_COMMENTS";
const YOUTUBE_COOKIE_ENV_NAMES = [
  "SOCIAL_YOUTUBE_COOKIE",
  "SOCIAL_YOUTUBE_COOKIES",
  "YOUTUBE_COOKIE",
  "YOUTUBE_COOKIES",
];

let cachedYtdlAgent = null;
let cachedYtdlAgentProxyUrl = "";
let cachedYtdlAgentCookieHeader = "";
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

export function isYoutubeHost(host) {
  return YOUTUBE_HOSTS.has(host);
}

export async function resolveYoutubeComments(normalized, options = {}, settings = {}) {
  const client = await getInnertubeClient(settings);
  const targetBatchIndex = normalizeYoutubeCommentBatchIndex(options.cursor);
  let commentsPage;
  let loadedBefore = 0;

  try {
    commentsPage = await client.getComments(normalized.shortcode, YOUTUBE_COMMENT_SORT);

    for (let index = 0; index < targetBatchIndex; index += 1) {
      loadedBefore += youtubeCommentThreads(commentsPage).length;

      if (!commentsPage.has_continuation) {
        commentsPage = null;
        break;
      }

      commentsPage = await commentsPage.getContinuation();
    }
  } catch (error) {
    throw toYoutubeAppError(error);
  }

  const comments = commentsPage
    ? youtubeCommentThreads(commentsPage)
      .map((thread) => normalizeYoutubeCommentThread(thread))
      .filter((comment) => comment.id && (comment.text || comment.author_name))
    : [];
  const totalCount = youtubeCommentsTotalCount(commentsPage) ?? (loadedBefore + comments.length || null);
  const hasMore = Boolean(commentsPage?.has_continuation);
  const publicCount = Math.min(
    totalCount ?? loadedBefore + comments.length,
    loadedBefore + comments.length,
  );

  return {
    platform: "youtube",
    shortcode: normalized.shortcode,
    canonical_url: normalized.canonical_url,
    comments,
    next_cursor: hasMore ? String(targetBatchIndex + 1) : null,
    has_more: hasMore,
    total_count: totalCount,
    public_count: publicCount,
    is_partial_public_snapshot: Boolean(totalCount == null || publicCount < totalCount),
    source: "youtubei_public_comments",
  };
}

export async function resolveYoutubePost(normalized, settings) {
  try {
    return await resolveYoutubePostWithInnertube(normalized, settings);
  } catch (error) {
    const primaryError = toYoutubeAppError(error);

    try {
      return await resolveYoutubePostWithYtdl(normalized, settings);
    } catch (fallbackError) {
      const secondaryError = toYoutubeAppError(fallbackError);

      if (primaryError.code === ErrorCode.NO_MEDIA_FOUND && secondaryError.code !== ErrorCode.NO_MEDIA_FOUND) {
        throw secondaryError;
      }

      throw primaryError;
    }
  }
}

async function resolveYoutubePostWithInnertube(normalized, settings) {
  const client = await getInnertubeClient(settings);
  let lastInfoError = null;
  let lastFormatError = null;
  let lastPlayabilityError = null;
  let foundInfo = false;

  for (const innertubeClient of INNERTUBE_CLIENTS) {
    let info;

    try {
      info = await client.getBasicInfo(normalized.shortcode, { client: innertubeClient });
    } catch (error) {
      if (isYoutubeNetworkFailure(error)) {
        throw error;
      }

      lastInfoError = error;
      continue;
    }

    foundInfo = true;
    const details = info?.basic_info && typeof info.basic_info === "object" ? info.basic_info : {};
    const playabilityError = youtubePlayabilityAppError(info?.playability_status);

    if (details.is_private) {
      throw new AppError(ErrorCode.LOGIN_REQUIRED, "这个 YouTube 视频是私密内容，需要登录或授权。", 403);
    }

    if (details.is_live || details.is_live_content || details.is_post_live_dvr) {
      throw new AppError(ErrorCode.NO_MEDIA_FOUND, "暂不支持下载 YouTube 直播内容。", 404);
    }

    if (playabilityError) {
      lastPlayabilityError = playabilityError;
      continue;
    }

    let formats;

    try {
      formats = await getInnertubeDownloadFormats(client, info);
    } catch (error) {
      lastFormatError = error;
      continue;
    }

    const format = formats?.video;

    if (!format?.url) {
      continue;
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

    const publicMetrics = await getYoutubePublicMetrics(client, normalized).catch(() => ({}));
    const metrics = {
      like_count: publicMetrics.like_count ?? null,
      comment_count: publicMetrics.comment_count ?? null,
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

  if (!foundInfo && lastInfoError) {
    throw lastInfoError;
  }

  if (lastFormatError && !isInnertubeFormatSelectionError(lastFormatError)) {
    throw lastFormatError;
  }

  if (lastPlayabilityError) {
    throw lastPlayabilityError;
  }

  throw new AppError(ErrorCode.NO_MEDIA_FOUND, "YouTube 页面中没有发现可下载的视频资源。", 404);
}

async function getInnertubeDownloadFormats(client, info) {
  const video = await getInnertubeFormat(client, info, [
    { type: "video", quality: "best", format: "any" },
    { type: "video", quality: "best", format: "mp4" },
  ]);

  if (video?.url) {
    const audio = await getInnertubeFormat(client, info, innertubeAudioOptionsForVideo(video));

    if (audio?.url) {
      return { video, audio };
    }
  }

  const progressive = await getInnertubeFormat(client, info, [
    { type: "video+audio", quality: "best", format: "any" },
    { type: "video+audio", quality: "best", format: "mp4" },
  ]);

  if (progressive?.url) {
    return { video: progressive, audio: null };
  }

  if (video?.url) {
    return { video, audio: null };
  }

  return await getInnertubeStreamingDataFormats(client, info);
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

  const target = isRequest ? input.url : input;
  addYoutubeCookieHeader(headers, target);

  const fetchInit = {
    redirect: "follow",
    ...(isRequest
      ? {
          method: input.method,
          signal: input.signal,
        }
      : {}),
    ...init,
    headers,
  };
  const method = String(fetchInit.method || "GET").toUpperCase();

  if (method !== "GET" && method !== "HEAD") {
    fetchInit.body ??= isRequest ? input.body : undefined;
  } else {
    delete fetchInit.body;
  }

  if (fetchInit.body && !fetchInit.duplex) {
    fetchInit.duplex = "half";
  }

  return {
    target,
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

async function getInnertubeStreamingDataFormats(client, info) {
  const formats = innertubeStreamingFormats(info);
  const videoFormats = formats
    .filter((format) => isUsableInnertubeVideoFormat(format) && !format.has_audio)
    .sort(compareInnertubeVideoFormats);
  const progressiveFormats = formats
    .filter((format) => isUsableInnertubeVideoFormat(format) && format.has_audio)
    .sort(compareInnertubeVideoFormats);

  for (const video of videoFormats) {
    const videoWithUrl = await decipherInnertubeFormat(client, video);

    if (!videoWithUrl?.url) {
      continue;
    }

    const audio = await firstDecipheredInnertubeFormat(
      client,
      formats
        .filter((format) => isUsableInnertubeAudioFormat(format))
        .sort(compareInnertubeAudioFormats),
    );

    return { video: videoWithUrl, audio };
  }

  const progressive = await firstDecipheredInnertubeFormat(client, progressiveFormats);

  return progressive?.url ? { video: progressive, audio: null } : null;
}

function innertubeStreamingFormats(info) {
  const streamingData = info?.streaming_data && typeof info.streaming_data === "object"
    ? info.streaming_data
    : {};

  return [
    ...(Array.isArray(streamingData.formats) ? streamingData.formats : []),
    ...(Array.isArray(streamingData.adaptive_formats) ? streamingData.adaptive_formats : []),
  ];
}

function isUsableInnertubeVideoFormat(format) {
  return (
    format &&
    typeof format === "object" &&
    format.has_video &&
    !format.is_type_otf &&
    !format.drm_families &&
    ["mp4", "webm"].includes(innertubeFormatContainer(format))
  );
}

function isUsableInnertubeAudioFormat(format) {
  const container = innertubeFormatContainer(format);

  return (
    format &&
    typeof format === "object" &&
    format.has_audio &&
    !format.has_video &&
    !format.has_text &&
    !format.is_type_otf &&
    !format.drm_families &&
    ["mp4", "webm"].includes(container)
  );
}

async function firstDecipheredInnertubeFormat(client, formats) {
  for (const format of formats) {
    const deciphered = await decipherInnertubeFormat(client, format);

    if (deciphered?.url) {
      return deciphered;
    }
  }

  return null;
}

async function decipherInnertubeFormat(client, format) {
  if (!format) {
    return null;
  }

  if (!format.url) {
    format.url = await format.decipher(client.session.player);
  }

  return /^https?:\/\//i.test(format.url) ? format : null;
}

function innertubeFormatContainer(format) {
  const mimeType = String(format?.mime_type || "").toLowerCase();

  if (mimeType.includes("webm")) {
    return "webm";
  }

  if (mimeType.includes("mp4")) {
    return "mp4";
  }

  return "";
}

function compareInnertubeVideoFormats(left, right) {
  const leftScore = innertubeVideoFormatScore(left);
  const rightScore = innertubeVideoFormatScore(right);

  for (let index = 0; index < leftScore.length; index += 1) {
    if (leftScore[index] !== rightScore[index]) {
      return rightScore[index] - leftScore[index];
    }
  }

  return 0;
}

function compareInnertubeAudioFormats(left, right) {
  const leftScore = innertubeAudioFormatScore(left);
  const rightScore = innertubeAudioFormatScore(right);

  for (let index = 0; index < leftScore.length; index += 1) {
    if (leftScore[index] !== rightScore[index]) {
      return rightScore[index] - leftScore[index];
    }
  }

  return 0;
}

function innertubeVideoFormatScore(format) {
  return [
    optionalInt(format.height) || 0,
    optionalInt(format.width) || 0,
    optionalInt(format.fps) || 0,
    firstPresentInt(format.bitrate, format.average_bitrate) || 0,
    innertubeFormatContainer(format) === "mp4" ? 1 : 0,
  ];
}

function innertubeAudioFormatScore(format) {
  return [
    innertubeFormatContainer(format) === "mp4" ? 1 : 0,
    firstPresentInt(format.bitrate, format.average_bitrate) || 0,
  ];
}

async function getYoutubePublicMetrics(client, normalized) {
  const info = await client.getInfo(normalized.shortcode, { client: "WEB" });
  const details = info?.basic_info && typeof info.basic_info === "object" ? info.basic_info : {};
  const commentCount = youtubeInfoCommentCount(info) ?? await getYoutubeCommentCount(client, normalized).catch(() => null);

  return {
    like_count: parseYoutubeCount(details.like_count),
    comment_count: commentCount,
  };
}

async function getYoutubeCommentCount(client, normalized) {
  const commentsPage = await client.getComments(normalized.shortcode, YOUTUBE_COMMENT_SORT);

  return youtubeCommentsTotalCount(commentsPage);
}

function youtubeInfoCommentCount(info) {
  return parseYoutubeCount(
    info?.comments_entry_point_header?.comment_count?.text,
    info?.comments_entry_point_header?.content_renderer?.comment_count?.text,
  );
}

function youtubeCommentThreads(commentsPage) {
  return Array.isArray(commentsPage?.contents) ? commentsPage.contents : [];
}

function youtubeCommentsTotalCount(commentsPage) {
  return parseYoutubeCount(
    commentsPage?.header?.comments_count?.text,
    commentsPage?.header?.count?.text,
    commentsPage?.header?.title?.text,
  );
}

function normalizeYoutubeCommentBatchIndex(value) {
  const parsed = Number.parseInt(String(value ?? ""), 10);

  if (!Number.isFinite(parsed) || parsed < 0) {
    return 0;
  }

  return Math.min(parsed, 200);
}

function normalizeYoutubeCommentThread(thread) {
  const comment = thread?.comment && typeof thread.comment === "object" ? thread.comment : {};
  const author = comment.author && typeof comment.author === "object" ? comment.author : {};
  const authorHandle = youtubeAuthorHandle(author);

  return {
    id: pickSingleLineText(comment.comment_id) ||
      `youtube-comment-${hashYoutubeComment([authorHandle, author.name, comment.published_time, comment.content?.text].join("|"))}`,
    text: pickText(comment.content?.text),
    author_name: pickSingleLineText(author.name, authorHandle, "YouTube 用户"),
    author_handle: authorHandle,
    avatar_url: youtubeAuthorAvatarUrl(author),
    created_at: youtubeRelativeTimestamp(comment.published_time),
    like_count: parseYoutubeCount(comment.like_count, comment.like_count_a11y),
    reply_count: parseYoutubeCount(comment.reply_count, comment.reply_count_a11y),
    ip_loc: pickSingleLineText(comment.published_time),
    has_voice: Boolean(comment.voice_reply_container),
    replies: [],
  };
}

function youtubeAuthorHandle(author) {
  const url = pickSingleLineText(author.url);

  try {
    const parsed = new URL(url, "https://www.youtube.com");
    const parts = parsed.pathname.split("/").filter(Boolean);
    const handle = parts.find((part) => part.startsWith("@"));

    return pickSingleLineText(handle, author.id === "N/A" ? "" : author.id);
  } catch {
    return pickSingleLineText(author.id === "N/A" ? "" : author.id);
  }
}

function youtubeAuthorAvatarUrl(author) {
  const thumbnail = author?.best_thumbnail ?? author?.thumbnails?.[0];
  const url = pickSingleLineText(thumbnail?.url);

  if (!url) {
    return "";
  }

  try {
    return new URL(url, "https://www.youtube.com").toString();
  } catch {
    return "";
  }
}

function youtubeRelativeTimestamp(value) {
  const text = pickSingleLineText(value);

  if (!text) {
    return null;
  }

  const normalized = text.toLowerCase();
  const match = /(\d+(?:[.,]\d+)?)\s*(second|minute|hour|day|week|month|year)s?\s+ago/.exec(normalized);

  if (!match) {
    return null;
  }

  const amount = Number.parseFloat(match[1].replace(",", "."));
  const unit = match[2];
  const unitMs = {
    second: 1000,
    minute: 60 * 1000,
    hour: 60 * 60 * 1000,
    day: 24 * 60 * 60 * 1000,
    week: 7 * 24 * 60 * 60 * 1000,
    month: 30 * 24 * 60 * 60 * 1000,
    year: 365 * 24 * 60 * 60 * 1000,
  }[unit];

  if (!Number.isFinite(amount) || !unitMs) {
    return null;
  }

  return new Date(Date.now() - amount * unitMs).toISOString();
}

function parseYoutubeCount(...values) {
  for (const value of values) {
    const text = pickSingleLineText(value);

    if (!text) {
      continue;
    }

    const match = text.replace(/,/g, "").match(/(\d+(?:\.\d+)?)\s*([KMB])?/i);

    if (!match) {
      continue;
    }

    const amount = Number.parseFloat(match[1]);
    const multiplier = {
      K: 1_000,
      M: 1_000_000,
      B: 1_000_000_000,
    }[String(match[2] || "").toUpperCase()] || 1;

    if (Number.isFinite(amount)) {
      return Math.round(amount * multiplier);
    }
  }

  return null;
}

function hashYoutubeComment(value) {
  let hash = 0;
  const text = String(value || "");

  for (let index = 0; index < text.length; index += 1) {
    hash = (hash * 31 + text.charCodeAt(index)) >>> 0;
  }

  return hash.toString(36);
}

function isInnertubeFormatSelectionError(error) {
  const message = error instanceof Error ? error.message.toLowerCase() : String(error || "").toLowerCase();

  return message.includes("no matching formats") || message.includes("streaming data not available");
}

function isYoutubeNetworkFailure(error) {
  const message = error instanceof Error ? error.message.toLowerCase() : String(error || "").toLowerCase();
  const code = String(error?.code || error?.cause?.code || "").toLowerCase();

  return (
    error?.name === "AbortError" ||
    message.includes("aborted") ||
    message.includes("timeout") ||
    message.includes("fetch failed") ||
    message.includes("connect") ||
    ["econnrefused", "econnreset", "etimedout", "enotfound", "und_err_connect_timeout"].includes(code)
  );
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
    like_count: parseYoutubeCount(details.likes),
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
  const cookieHeader = getYoutubeCookieHeader();
  const requestOptions = {
    signal: controller.signal,
  };

  if (cookieHeader) {
    requestOptions.headers = {
      cookie: cookieHeader,
    };
  }

  try {
    return await ytdl.getInfo(url, {
      agent: getYtdlAgent(cookieHeader),
      fetch: createYtdlFetch(settings),
      playerClients: YTDL_PLAYER_CLIENTS,
      requestOptions,
    });
  } finally {
    clearTimeout(timeout);
  }
}

function createYtdlFetch(settings) {
  return async function ytdlFetch(target, requestOptions = {}) {
    const headers = new Headers(requestOptions.headers);
    addYoutubeCookieHeader(headers, target);

    const fetchInit = {
      method: requestOptions.method,
      headers,
      signal: requestOptions.signal,
    };
    const method = String(fetchInit.method || "GET").toUpperCase();

    if (method !== "GET" && method !== "HEAD") {
      fetchInit.body = requestOptions.body;
    }

    if (fetchInit.body && !fetchInit.duplex) {
      fetchInit.duplex = "half";
    }

    return await fetchWithTimeout(target, fetchInit, settings.httpTimeoutMs);
  };
}

function getYtdlAgent(cookieHeader = "") {
  const proxyUrl = getProxyUrl();
  const cookies = parseYoutubeCookieHeader(cookieHeader);

  if (!proxyUrl && cookies.length === 0) {
    cachedYtdlAgent = null;
    cachedYtdlAgentProxyUrl = "";
    cachedYtdlAgentCookieHeader = "";
    return undefined;
  }

  if (isSocksProxyUrl(proxyUrl)) {
    if (cookies.length === 0) {
      cachedYtdlAgent = null;
      cachedYtdlAgentProxyUrl = "";
      cachedYtdlAgentCookieHeader = "";
      return undefined;
    }

    if (cachedYtdlAgent && cachedYtdlAgentProxyUrl === "" && cachedYtdlAgentCookieHeader === cookieHeader) {
      return cachedYtdlAgent;
    }

    cachedYtdlAgent = ytdl.createAgent(cookies);
    cachedYtdlAgentProxyUrl = "";
    cachedYtdlAgentCookieHeader = cookieHeader;
    return cachedYtdlAgent;
  }

  if (cachedYtdlAgent && cachedYtdlAgentProxyUrl === proxyUrl && cachedYtdlAgentCookieHeader === cookieHeader) {
    return cachedYtdlAgent;
  }

  cachedYtdlAgent = proxyUrl
    ? ytdl.createProxyAgent({ uri: proxyUrl }, cookies)
    : ytdl.createAgent(cookies);
  cachedYtdlAgentProxyUrl = proxyUrl;
  cachedYtdlAgentCookieHeader = cookieHeader;

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
  const headers = {
    Referer: pageUrl,
    Origin: "https://www.youtube.com",
  };
  const cookieHeader = getYoutubeCookieHeader();

  if (cookieHeader) {
    headers.Cookie = cookieHeader;
  }

  return headers;
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

function youtubePlayabilityAppError(playabilityStatus) {
  if (!playabilityStatus || typeof playabilityStatus !== "object") {
    return null;
  }

  const status = String(playabilityStatus.status || "").toUpperCase();
  const reason = pickText(playabilityStatus.reason?.text, playabilityStatus.reason);
  const lowerReason = String(reason || "").toLowerCase();

  if (status === "LOGIN_REQUIRED" || lowerReason.includes("sign in") || lowerReason.includes("not a bot")) {
    return new AppError(
      ErrorCode.LOGIN_REQUIRED,
      "YouTube 要求登录或真人验证后才能访问这个视频。",
      403,
      {
        hint: "当前出口 IP 被 YouTube 要求登录验证。可以换可用代理，或在环境变量 SOCIAL_YOUTUBE_COOKIE / YOUTUBE_COOKIE 中配置登录后的 YouTube Cookie。",
      },
    );
  }

  if (status === "UNPLAYABLE" || status === "ERROR") {
    return new AppError(ErrorCode.NO_MEDIA_FOUND, reason || "没有找到这个 YouTube 视频。", 404);
  }

  return null;
}

function getYoutubeCookieHeader() {
  for (const name of YOUTUBE_COOKIE_ENV_NAMES) {
    const value = process.env[name]?.trim();

    if (value) {
      return value;
    }
  }

  return "";
}

function addYoutubeCookieHeader(headers, target) {
  const cookieHeader = getYoutubeCookieHeader();

  if (!cookieHeader || !isYoutubeCookieTarget(target) || headers.has("cookie")) {
    return;
  }

  headers.set("cookie", cookieHeader);
}

function isYoutubeCookieTarget(target) {
  try {
    const host = new URL(String(target)).hostname.toLowerCase();

    return host === "youtubei.googleapis.com" || host === "www.youtube.com" || host.endsWith(".youtube.com");
  } catch {
    return false;
  }
}

function parseYoutubeCookieHeader(cookieHeader) {
  return String(cookieHeader || "")
    .split(";")
    .map((part) => {
      const trimmed = part.trim();
      const separatorIndex = trimmed.indexOf("=");

      if (separatorIndex <= 0) {
        return null;
      }

      return {
        domain: ".youtube.com",
        hostOnly: false,
        httpOnly: false,
        name: trimmed.slice(0, separatorIndex).trim(),
        path: "/",
        sameSite: "no_restriction",
        secure: true,
        session: true,
        value: trimmed.slice(separatorIndex + 1),
      };
    })
    .filter((cookie) => cookie?.name && cookie.value);
}

function safeFilenamePart(value) {
  return String(value || "unknown")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^[-._]+|[-._]+$/g, "") || "unknown";
}
