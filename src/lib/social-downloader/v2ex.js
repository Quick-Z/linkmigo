import { URL } from "node:url";

import { AppError, ErrorCode } from "./errors";
import {
  dedupeAssets,
  fetchTextResponse,
  fetchWithTimeout,
  getAttribute,
  htmlUnescape,
  metaContents,
  optionalInt,
  PAGE_HEADERS,
  responseJson,
} from "./utils";
import {
  createPostInfo,
  pickSingleLineText,
  pickText,
} from "./post-info";
import { postInfoFromHtmlMeta, safeFilenamePart } from "./shared";

const V2EX_HEADERS = {
  ...PAGE_HEADERS,
  "accept-language": "zh-CN,zh;q=0.9,en;q=0.8",
  Referer: "https://www.v2ex.com/",
};

const V2EX_JSON_HEADERS = {
  ...V2EX_HEADERS,
  accept: "application/json,text/plain,*/*",
};

const IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".webp", ".gif", ".heic", ".avif"]);
const VIDEO_EXTENSIONS = new Set([".mp4", ".mov", ".m4v", ".webm"]);
const AUDIO_EXTENSIONS = new Set([".m4a", ".mp3", ".aac", ".wav", ".ogg", ".flac"]);
const MEDIA_EXTENSIONS = new Set([
  ...IMAGE_EXTENSIONS,
  ...VIDEO_EXTENSIONS,
  ...AUDIO_EXTENSIONS,
]);

const TRAILING_MEDIA_URL_PUNCTUATION_PATTERN = /[)"'.。,;:!?，；：！？、】》」』”’\]]+$/u;

export function isV2exHost(host) {
  return host === "v2ex.com" || host.endsWith(".v2ex.com");
}

export function normalizeV2exUrl(parsed) {
  const parts = parsed.pathname.split("/").filter(Boolean);
  const topicIndex = parts.findIndex((part) => part.toLowerCase() === "t");
  const topicId = topicIndex >= 0 ? parts[topicIndex + 1] : "";

  if (!/^\d{1,16}$/.test(topicId)) {
    throw new AppError(ErrorCode.UNSUPPORTED_URL, "仅支持 V2EX 主题链接。", 400);
  }

  const replyNumber = v2exReplyNumberFromHash(parsed.hash);
  const canonicalUrl = `https://www.v2ex.com/t/${topicId}${replyNumber ? `#reply${replyNumber}` : ""}`;

  return {
    canonical_url: canonicalUrl,
    shortcode: topicId,
    kind: replyNumber ? "reply" : "topic",
    platform: "v2ex",
    reply_number: replyNumber,
  };
}

export async function resolveV2exPost(normalized, settings) {
  let apiError = null;

  try {
    const apiPost = await requestV2exApiPost(normalized, settings);

    return responseFromV2exApi(normalized, apiPost);
  } catch (error) {
    apiError = error;
  }

  try {
    return await responseFromV2exHtml(normalized, settings);
  } catch (htmlError) {
    if (apiError?.code && apiError.code !== ErrorCode.NO_MEDIA_FOUND) {
      throw apiError;
    }

    throw htmlError;
  }
}

export async function resolveV2exComments(normalized, options = {}, settings = {}) {
  const { topic, replies } = await requestV2exApiPost(
    {
      ...normalized,
      reply_number: null,
    },
    settings,
  );
  const limit = normalizeV2exCommentLimit(options.limit);
  const offset = normalizeV2exCommentCursor(options.cursor);
  const endOffset = offset + limit;
  const comments = replies
    .slice(offset, endOffset)
    .map((reply, index) => normalizeV2exComment(reply, offset + index + 1))
    .filter((comment) => comment.id);
  const totalCount = optionalInt(topic?.replies) ?? replies.length;
  const nextCursor = endOffset < replies.length ? String(endOffset) : null;

  return {
    platform: "v2ex",
    shortcode: normalized.shortcode,
    canonical_url: normalized.canonical_url,
    comments,
    next_cursor: nextCursor,
    has_more: Boolean(nextCursor),
    total_count: totalCount,
    public_count: replies.length,
    is_partial_public_snapshot: totalCount > replies.length,
    source: "v2ex_public_api_replies",
  };
}

export function extractV2exMediaAssetsFromContent(content, options = {}) {
  const pageUrl = options.pageUrl || "https://www.v2ex.com/";
  const filenameBase = safeFilenamePart(options.filenameBase || "v2ex_media");
  const candidates = mediaCandidatesFromContent(content, pageUrl);

  return candidates.map((candidate, index) => {
    const extension = extensionForV2exMediaUrl(candidate.url, candidate.mediaType);

    return {
      source_url: candidate.url,
      media_type: candidate.mediaType,
      filename_hint: `${filenameBase}_${index + 1}${extension}`,
      request_headers: v2exMediaHeaders(pageUrl),
      width: candidate.width,
      height: candidate.height,
    };
  });
}

function normalizeV2exCommentLimit(value) {
  const parsed = Number.parseInt(String(value ?? ""), 10);

  if (!Number.isFinite(parsed)) {
    return 12;
  }

  return Math.max(1, Math.min(30, parsed));
}

function normalizeV2exCommentCursor(value) {
  const parsed = Number.parseInt(String(value ?? ""), 10);

  if (!Number.isFinite(parsed) || parsed < 0) {
    return 0;
  }

  return parsed;
}

function normalizeV2exComment(reply, ordinal) {
  const member = reply?.member && typeof reply.member === "object" ? reply.member : {};

  return {
    id: String(reply?.id || `v2ex-${ordinal}`),
    text: pickText(reply?.content_rendered, reply?.content),
    author_name: displayNameFromV2exMember(member) || "V2EX 用户",
    author_handle: creatorHandleFromV2exMember(member),
    avatar_url: v2exAvatarUrl(member),
    created_at: v2exTimestamp(reply?.created),
    like_count: optionalInt(reply?.thanks),
    reply_count: 0,
    ip_loc: ordinal ? `#${ordinal}` : "",
    has_voice: false,
    replies: [],
  };
}

function v2exAvatarUrl(member) {
  const value = pickSingleLineText(
    member?.avatar_normal,
    member?.avatar_large,
    member?.avatar_mini,
  );

  if (!value) {
    return "";
  }

  try {
    return new URL(htmlUnescape(value), "https://www.v2ex.com").toString();
  } catch {
    return "";
  }
}

function v2exTimestamp(value) {
  const timestamp = optionalInt(value);

  if (timestamp == null) {
    return null;
  }

  const date = new Date(timestamp * 1000);

  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

async function requestV2exApiPost(normalized, settings) {
  const errors = [];

  for (const requester of [requestV2exV2ApiPost, requestV2exV1ApiPost]) {
    try {
      return await requester(normalized, settings);
    } catch (error) {
      errors.push(error);
    }
  }

  const selectedError = errors.find((error) => error?.code !== ErrorCode.NO_MEDIA_FOUND) || errors[0];

  if (selectedError) {
    throw selectedError;
  }

  throw new AppError(ErrorCode.NO_MEDIA_FOUND, "没有找到这个 V2EX 主题。", 404);
}

async function requestV2exV2ApiPost(normalized, settings) {
  const topicUrl = `https://www.v2ex.com/api/v2/topics/${encodeURIComponent(normalized.shortcode)}`;
  const repliesUrl = `https://www.v2ex.com/api/v2/topics/${encodeURIComponent(normalized.shortcode)}/replies`;
  const topicPayload = await requestV2exJson(topicUrl, settings);
  const topic = firstV2exTopic(topicPayload, normalized.shortcode);

  if (!topic) {
    throw new AppError(ErrorCode.NO_MEDIA_FOUND, "没有找到这个 V2EX 主题。", 404);
  }

  let replies = [];

  try {
    replies = v2exReplies(await requestV2exJson(repliesUrl, settings));
  } catch (error) {
    if (normalized.reply_number) {
      throw error;
    }
  }

  return { topic, replies };
}

async function requestV2exV1ApiPost(normalized, settings) {
  const topicUrl = `https://www.v2ex.com/api/topics/show.json?id=${encodeURIComponent(normalized.shortcode)}`;
  const repliesUrl = `https://www.v2ex.com/api/replies/show.json?topic_id=${encodeURIComponent(normalized.shortcode)}`;
  const topicPayload = await requestV2exJson(topicUrl, settings);
  const topic = firstV2exTopic(topicPayload, normalized.shortcode);

  if (!topic) {
    throw new AppError(ErrorCode.NO_MEDIA_FOUND, "没有找到这个 V2EX 主题。", 404);
  }

  let replies = [];

  try {
    replies = v2exReplies(await requestV2exJson(repliesUrl, settings));
  } catch (error) {
    if (normalized.reply_number) {
      throw error;
    }
  }

  return { topic, replies };
}

async function requestV2exJson(url, settings) {
  let response;

  try {
    response = await fetchWithTimeout(
      url,
      {
        cache: "no-store",
        headers: v2exJsonHeaders(settings),
      },
      settings.httpTimeoutMs,
    );
  } catch (error) {
    if (error?.name === "AbortError") {
      throw new AppError(ErrorCode.UPSTREAM_BLOCKED, "V2EX API 请求超时。", 504);
    }

    throw new AppError(ErrorCode.UPSTREAM_BLOCKED, "无法访问 V2EX API。", 502);
  }

  if ([401, 403].includes(response.status)) {
    throw new AppError(ErrorCode.LOGIN_REQUIRED, "V2EX API 需要登录或拒绝了公开访问。", 403);
  }

  if (response.status === 404) {
    throw new AppError(ErrorCode.NO_MEDIA_FOUND, "没有找到这个 V2EX 内容。", 404);
  }

  if (response.status === 429) {
    throw new AppError(ErrorCode.UPSTREAM_BLOCKED, "V2EX 对当前请求进行了限流。", 429);
  }

  if (response.status >= 400) {
    throw new AppError(ErrorCode.UPSTREAM_BLOCKED, `V2EX API 返回异常状态码 ${response.status}。`, 502);
  }

  const payload = await responseJson(response);

  if (!payload) {
    throw new AppError(ErrorCode.UPSTREAM_BLOCKED, "V2EX API 返回内容不是有效 JSON。", 502);
  }

  return payload;
}

function v2exJsonHeaders(settings) {
  const token = settings.v2exToken || "";

  return token
    ? { ...V2EX_JSON_HEADERS, Authorization: `Bearer ${token}` }
    : V2EX_JSON_HEADERS;
}

function responseFromV2exApi(normalized, apiPost) {
  const { topic, replies } = apiPost;
  const pageUrl = topic.url || `https://www.v2ex.com/t/${normalized.shortcode}`;
  const allEntries = [topicEntry(topic), ...replies.map((reply, index) => replyEntry(reply, index + 1))];
  const selectedEntries = normalized.reply_number
    ? selectedReplyEntries(replies, normalized.reply_number)
    : [];

  let assetEntries = normalized.reply_number && selectedEntries.length
    ? selectedEntries
    : allEntries;
  let assets = dedupeAssets(assetEntries.flatMap((entry) =>
    assetsFromV2exEntry(entry, normalized.shortcode, pageUrl),
  ));

  if (assets.length === 0 && normalized.reply_number && selectedEntries.length) {
    assetEntries = allEntries;
    assets = dedupeAssets(assetEntries.flatMap((entry) =>
      assetsFromV2exEntry(entry, normalized.shortcode, pageUrl),
    ));
  }

  if (assets.length === 0) {
    const target = normalized.reply_number && selectedEntries.length ? `第 ${normalized.reply_number} 楼回复` : "主题和公开回复";

    throw new AppError(ErrorCode.NO_MEDIA_FOUND, `V2EX ${target}中没有发现可下载媒体。`, 404);
  }

  const metrics = metricsFromV2exTopic(topic, replies);
  const postInfoEntry = assetEntries === selectedEntries ? selectedEntries[0] : topicEntry(topic);
  const creatorHandle = normalized.reply_number
    ? (postInfoEntry.authorHandle || creatorHandleFromV2exMember(topic.member))
    : creatorHandleFromV2exMember(topic.member);

  return {
    assets,
    metrics,
    creator_handle: creatorHandle,
    post_info: postInfoFromV2exApi(topic, postInfoEntry, normalized, metrics, creatorHandle),
  };
}

async function responseFromV2exHtml(normalized, settings) {
  const pageUrl = `https://www.v2ex.com/t/${normalized.shortcode}`;
  const pageResponse = await fetchTextResponse({
    url: pageUrl,
    headers: V2EX_HEADERS,
    label: "V2EX",
    timeoutMs: settings.httpTimeoutMs,
  });
  const resolvedPageUrl = pageResponse.response?.url || pageUrl;
  const text = pageResponse.text;
  const allChunks = [topicHtmlChunk(text), ...replyHtmlChunks(text)].filter(Boolean);
  const selectedChunks = normalized.reply_number
    ? selectedReplyHtmlChunks(text, normalized.reply_number)
    : [];
  let usesSelectedReply = normalized.reply_number && selectedChunks.length > 0;
  let chunks = normalized.reply_number
    ? (selectedChunks.length ? selectedChunks : allChunks.length ? allChunks : [text])
    : (allChunks.length ? allChunks : [text]);

  if (normalized.reply_number && selectedChunks.length === 0 && chunks.length === 0) {
    throw new AppError(ErrorCode.NO_MEDIA_FOUND, `没有找到 V2EX 第 ${normalized.reply_number} 楼回复。`, 404);
  }

  let assets = dedupeAssets(chunks.flatMap((chunk, index) =>
    extractV2exMediaAssetsFromContent(chunk, {
      pageUrl: resolvedPageUrl,
      filenameBase: `v2ex_${normalized.shortcode}_${normalized.reply_number ? `reply${normalized.reply_number}` : index + 1}`,
    }),
  ));

  if (assets.length === 0 && normalized.reply_number && selectedChunks.length) {
    usesSelectedReply = false;
    chunks = allChunks.length ? allChunks : [text];
    assets = dedupeAssets(chunks.flatMap((chunk, index) =>
      extractV2exMediaAssetsFromContent(chunk, {
        pageUrl: resolvedPageUrl,
        filenameBase: `v2ex_${normalized.shortcode}_${index + 1}`,
      }),
    ));
  }

  if (assets.length === 0) {
    const target = normalized.reply_number && selectedChunks.length ? `第 ${normalized.reply_number} 楼回复` : "页面";

    throw new AppError(ErrorCode.NO_MEDIA_FOUND, `V2EX ${target}中没有发现可下载媒体。`, 404);
  }

  const metrics = {
    like_count: null,
    comment_count: replyHtmlChunks(text).length || null,
    view_count: null,
    save_count: null,
    share_count: null,
    source: "v2ex_public_html",
  };
  const postInfo = postInfoFromHtmlMeta(text, metrics, "");
  const title = pickSingleLineText(
    postInfo.title,
    metaContents(text, ["og:title", "twitter:title", "title"]),
  );

  return {
    assets,
    metrics,
    creator_handle: "",
    post_info: {
      ...postInfo,
      title: usesSelectedReply && title ? `${title} #${normalized.reply_number}` : title,
    },
  };
}

function assetsFromV2exEntry(entry, topicId, pageUrl) {
  const label = entry.kind === "reply"
    ? `reply${entry.ordinal || entry.id || "unknown"}`
    : "topic";
  const filenameBase = `v2ex_${topicId}_${safeFilenamePart(label)}`;

  return extractV2exMediaAssetsFromContent(
    [entry.contentRendered, entry.content].filter(Boolean).join("\n"),
    { pageUrl, filenameBase },
  );
}

function selectedReplyEntries(replies, replyNumber) {
  const selected = [];
  const byOrdinal = replies[replyNumber - 1];
  const byId = replies.find((reply) => optionalInt(reply?.id) === replyNumber);

  if (byOrdinal) {
    selected.push(replyEntry(byOrdinal, replyNumber));
  }

  if (byId && byId !== byOrdinal) {
    selected.push(replyEntry(byId, replies.indexOf(byId) + 1));
  }

  return selected;
}

function topicEntry(topic) {
  return {
    kind: "topic",
    id: topic.id,
    ordinal: null,
    title: topic.title,
    content: topic.content,
    contentRendered: topic.content_rendered,
    author: displayNameFromV2exMember(topic.member),
    authorHandle: creatorHandleFromV2exMember(topic.member),
  };
}

function replyEntry(reply, ordinal) {
  return {
    kind: "reply",
    id: reply.id,
    ordinal,
    title: "",
    content: reply.content,
    contentRendered: reply.content_rendered,
    author: displayNameFromV2exMember(reply.member),
    authorHandle: creatorHandleFromV2exMember(reply.member),
  };
}

function firstV2exTopic(payload, topicId) {
  const values = arrayPayloadValues(payload).filter((item) => isV2exTopicCandidate(item, topicId));

  return values.find((item) => String(item?.id || "") === String(topicId)) || values[0] || null;
}

function v2exReplies(payload) {
  return arrayPayloadValues(payload).filter(isV2exReplyCandidate);
}

function isV2exTopicCandidate(item, topicId) {
  if (!item || typeof item !== "object") {
    return false;
  }

  if (String(item.id || "") === String(topicId)) {
    return true;
  }

  return Boolean(item.title || item.content || item.content_rendered || item.member || item.node || item.url);
}

function isV2exReplyCandidate(item) {
  if (!item || typeof item !== "object") {
    return false;
  }

  return Boolean(item.content || item.content_rendered || item.member || item.created || item.thanks);
}

function arrayPayloadValues(payload) {
  if (Array.isArray(payload)) {
    return payload;
  }

  for (const value of [
    payload?.result,
    payload?.data,
    payload?.items,
    payload?.replies,
    payload?.topics,
  ]) {
    if (Array.isArray(value)) {
      return value;
    }

    if (value && typeof value === "object") {
      return [value];
    }
  }

  if (payload && typeof payload === "object") {
    return [payload];
  }

  return [];
}

function mediaCandidatesFromContent(content, pageUrl) {
  const text = String(content || "");
  const candidates = [];
  const tagPattern = /<(img|source|video|audio|a)\b[^>]*>/gi;
  let tagMatch;

  while ((tagMatch = tagPattern.exec(text))) {
    const tagName = tagMatch[1].toLowerCase();
    const tag = tagMatch[0];
    const typeHint = mediaTypeFromTag(tagName, tag);
    const width = optionalInt(getAttribute(tag, "width"));
    const height = optionalInt(getAttribute(tag, "height"));

    for (const url of urlsFromMediaTag(tagName, tag)) {
      addMediaCandidate(candidates, url, {
        pageUrl,
        typeHint,
        width,
        height,
      });
    }
  }

  const urlPattern = /(?:https?:)?\/\/[^\s<>"'`]+/gi;
  let urlMatch;

  while ((urlMatch = urlPattern.exec(text))) {
    addMediaCandidate(candidates, urlMatch[0], { pageUrl });
  }

  return uniqueMediaCandidates(candidates);
}

function urlsFromMediaTag(tagName, tag) {
  const attrs = tagName === "a"
    ? ["href"]
    : ["src", "data-src", "data-original", "data-url"];
  const urls = [];

  for (const attr of attrs) {
    const value = getAttribute(tag, attr);

    if (value) {
      urls.push(value);
    }
  }

  const srcset = getAttribute(tag, "srcset");

  if (srcset) {
    urls.push(...srcset.split(",").map((part) => part.trim().split(/\s+/, 1)[0]).filter(Boolean));
  }

  return urls;
}

function addMediaCandidate(candidates, rawUrl, options) {
  const normalized = normalizeV2exMediaUrl(rawUrl, options.pageUrl);

  if (!normalized) {
    return;
  }

  const mediaType = mediaTypeForV2exUrl(normalized, options.typeHint);

  if (!mediaType) {
    return;
  }

  candidates.push({
    url: normalized,
    mediaType,
    width: options.width ?? null,
    height: options.height ?? null,
  });
}

function normalizeV2exMediaUrl(rawUrl, pageUrl) {
  let value = htmlUnescape(String(rawUrl || "").trim())
    .replace(/^url\((["']?)(.*?)\1\)$/i, "$2")
    .replace(TRAILING_MEDIA_URL_PUNCTUATION_PATTERN, "");

  if (!value || value.startsWith("data:") || value.startsWith("blob:")) {
    return "";
  }

  if (value.startsWith("//")) {
    value = `https:${value}`;
  }

  try {
    const parsed = new URL(value, pageUrl);

    if (!["http:", "https:"].includes(parsed.protocol)) {
      return "";
    }

    parsed.hash = "";
    return parsed.toString();
  } catch {
    return "";
  }
}

function mediaTypeFromTag(tagName, tag) {
  if (tagName === "img") {
    return "image";
  }

  if (tagName === "video") {
    return "video";
  }

  if (tagName === "audio") {
    return "audio";
  }

  const type = getAttribute(tag, "type").toLowerCase();

  if (type.startsWith("image/")) {
    return "image";
  }

  if (type.startsWith("video/")) {
    return "video";
  }

  if (type.startsWith("audio/")) {
    return "audio";
  }

  return "";
}

function mediaTypeForV2exUrl(value, typeHint = "") {
  if (["image", "video", "audio"].includes(typeHint)) {
    return typeHint;
  }

  const extension = extensionFromUrl(value);

  if (IMAGE_EXTENSIONS.has(extension)) {
    return "image";
  }

  if (VIDEO_EXTENSIONS.has(extension)) {
    return "video";
  }

  if (AUDIO_EXTENSIONS.has(extension)) {
    return "audio";
  }

  return "";
}

function extensionForV2exMediaUrl(value, mediaType) {
  const extension = extensionFromUrl(value);

  if (MEDIA_EXTENSIONS.has(extension)) {
    return extension === ".jpeg" ? ".jpg" : extension;
  }

  if (mediaType === "video") {
    return ".mp4";
  }

  if (mediaType === "audio") {
    return ".m4a";
  }

  return ".jpg";
}

function extensionFromUrl(value) {
  try {
    const pathname = new URL(value).pathname.toLowerCase();
    const match = pathname.match(/\.([a-z0-9]{2,5})$/i);

    return match ? `.${match[1].toLowerCase()}` : "";
  } catch {
    return "";
  }
}

function uniqueMediaCandidates(candidates) {
  const seen = new Set();
  const result = [];

  for (const candidate of candidates) {
    const key = `${candidate.mediaType}:${candidate.url}`;

    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    result.push(candidate);
  }

  return result;
}

function selectedReplyHtmlChunks(text, replyNumber) {
  const anchored = replyHtmlChunkByAnchor(text, replyNumber);

  if (anchored) {
    return [anchored];
  }

  const replies = replyHtmlChunks(text);
  const chunk = replies[replyNumber - 1];

  return chunk ? [chunk] : [];
}

function replyHtmlChunkByAnchor(text, replyNumber) {
  const anchorPattern = new RegExp(
    `<[^>]+(?:id|name)=["']reply${replyNumber}["'][^>]*>`,
    "i",
  );
  const anchor = anchorPattern.exec(text);

  if (!anchor) {
    return "";
  }

  const afterAnchor = text.slice(anchor.index);
  const nextReplyPattern = new RegExp(
    `<[^>]+(?:id|name)=["']reply(?!${replyNumber}\\b)\\d+["'][^>]*>`,
    "i",
  );
  const nextReply = nextReplyPattern.exec(afterAnchor.slice(anchor[0].length));
  const chunk = nextReply
    ? afterAnchor.slice(0, anchor[0].length + nextReply.index)
    : afterAnchor;

  return replyHtmlChunks(chunk)[0] || chunk;
}

function topicHtmlChunk(text) {
  const match = /<div\b[^>]*class=["'][^"']*\btopic_content\b[^"']*["'][^>]*>([\s\S]*?)<\/div>/i.exec(text);

  return match ? match[1] : "";
}

function replyHtmlChunks(text) {
  const chunks = [];
  const pattern = /<div\b[^>]*class=["'][^"']*\breply_content\b[^"']*["'][^>]*>([\s\S]*?)<\/div>/gi;
  let match;

  while ((match = pattern.exec(text))) {
    chunks.push(match[1]);
  }

  return chunks;
}

function postInfoFromV2exApi(topic, entry, normalized, metrics, creatorHandle) {
  const topicTitle = pickSingleLineText(topic.title);
  const title = normalized.reply_number && entry.kind === "reply" && topicTitle
    ? `${topicTitle} #${normalized.reply_number}`
    : topicTitle;
  const body = pickText(entry.contentRendered, entry.content, topic.content_rendered, topic.content);
  const nodeTitle = pickSingleLineText(topic.node?.title, topic.node?.name);
  const nodeName = pickSingleLineText(topic.node?.name);

  return createPostInfo({
    title,
    author: entry.author,
    author_handle: entry.authorHandle || creatorHandle,
    body,
    tags: [nodeTitle, nodeName].filter(Boolean),
    metrics,
    source: "v2ex_public_api",
  }, {
    metrics,
    creatorHandle,
    source: "v2ex_public_api",
  });
}

function metricsFromV2exTopic(topic, replies) {
  return {
    like_count: null,
    comment_count: optionalInt(topic.replies) ?? replies.length ?? null,
    view_count: null,
    save_count: null,
    share_count: null,
    source: "v2ex_public_api",
  };
}

function creatorHandleFromV2exMember(member) {
  return pickSingleLineText(member?.username);
}

function displayNameFromV2exMember(member) {
  return pickSingleLineText(member?.username);
}

function v2exMediaHeaders(pageUrl) {
  return {
    Referer: pageUrl,
  };
}

function v2exReplyNumberFromHash(hash) {
  const match = String(hash || "").match(/^#(?:reply|r_?)(\d+)$/i);
  const value = match ? optionalInt(match[1]) : null;

  return value && value > 0 ? value : null;
}
