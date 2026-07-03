import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { URL } from "node:url";

import { AppError, ErrorCode } from "./errors";
import {
  cleanUrl,
  dedupeAssets,
  dig,
  fetchTextResponse,
  firstPresentInt,
  htmlUnescape,
  metaContents,
  optionalInt,
  PAGE_HEADERS,
} from "./utils";
import {
  createPostInfo,
  normalizeTags,
  pickSingleLineText,
  pickText,
} from "./post-info";
import {
  balancedJsonEndIndex,
  createMetrics,
  postInfoFromHtmlMeta,
  resolveRedirect,
  safeFilenamePart,
  titleFromBody,
  withCookieHeader,
} from "./shared";

const XIAOHONGSHU_HEADERS = {
  ...PAGE_HEADERS,
  accept:
    "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
  "accept-language": "zh-CN,zh;q=0.9,en;q=0.8",
  Referer: "https://www.xiaohongshu.com/",
};
const XIAOHONGSHU_MOBILE_HEADERS = {
  ...XIAOHONGSHU_HEADERS,
  "user-agent":
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
  accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
};
const XIAOHONGSHU_RESTRICTED_HINT =
  "已尝试桌面公开页和移动 H5 公开页。如果浏览器里能打开这条笔记，请在 .env.local 配置 SOCIAL_XIAOHONGSHU_COOKIE 为已登录小红书账号的 Cookie，重启服务后再试；如果浏览器账号也打不开，说明该笔记已被小红书限制访问或删除。";
const XIAOHONGSHU_CURL_FALLBACK_ERRORS = [
  "ERR_HTTP2_STREAM_ERROR",
  "terminated",
  "other side closed",
  "response reading failed",
  "页面响应读取失败",
];
const execFile = promisify(execFileCallback);

export function normalizeXiaohongshuUrl(parsed) {
  const parts = parsed.pathname.split("/").filter(Boolean);
  const host = parsed.hostname.toLowerCase();

  if (isXiaohongshuShortHost(host) && parts.length > 0) {
    return {
      canonical_url: cleanUrl(parsed),
      shortcode: parts.join("-"),
      kind: "short",
      platform: "xiaohongshu",
    };
  }

  let noteId = "";

  if (parts[0] === "explore" && parts[1]) {
    noteId = parts[1];
  } else if (parts.length >= 3 && parts[0] === "discovery" && parts[1] === "item") {
    noteId = parts[2];
  }

  if (/^[A-Za-z0-9_-]{8,80}$/.test(noteId)) {
    const canonical = new URL(`https://www.xiaohongshu.com/explore/${noteId}`);

    for (const key of ["xsec_token", "xsec_source"]) {
      const value = parsed.searchParams.get(key);

      if (value) {
        canonical.searchParams.set(key, value);
      }
    }

    return {
      canonical_url: canonical.toString(),
      shortcode: noteId,
      kind: "note",
      platform: "xiaohongshu",
    };
  }

  throw new AppError(ErrorCode.UNSUPPORTED_URL, "仅支持小红书笔记或分享短链接。", 400);
}

export async function resolveXiaohongshuPost(normalized, settings) {
  let active = normalized;
  const pageHeaders = xiaohongshuPageHeaders(settings);

  if (active.kind === "short") {
    const redirected = await resolveRedirect(active.canonical_url, settings, pageHeaders);

    if (redirected) {
      active = normalizeXiaohongshuUrl(new URL(redirected));
    }
  }

  if (active.kind === "short" || !active.shortcode) {
    throw new AppError(ErrorCode.NO_MEDIA_FOUND, "小红书短链接没有解析到笔记 ID。", 404);
  }

  const pageUrl = active.canonical_url;
  const pageResponse = await fetchXiaohongshuPageTextWithMobileFallback({
    pageUrl,
    pageHeaders,
    shortcode: active.shortcode,
    settings,
  });
  const text = pageResponse.text;
  const initialState = extractXiaohongshuInitialState(text);
  const note = findXiaohongshuNote(initialState, active.shortcode);
  const htmlAssets = xiaohongshuHtmlAssets(text, active.shortcode, pageUrl, settings);

  if (!note) {
    if (looksLikeXiaohongshuVerification(text) && htmlAssets.length === 0) {
      throw xiaohongshuRestrictedError({ reason: "verification_page" });
    }

    const fallbackAssets = [
      ...htmlAssets,
      ...xiaohongshuMetaAssets(text, active.shortcode, pageUrl, settings),
    ];

    if (fallbackAssets.length > 0) {
      const metrics = createMetrics("xiaohongshu_public_best_effort");

      return {
        assets: dedupeAssets(fallbackAssets),
        metrics,
        creator_handle: "",
        post_info: postInfoFromHtmlMeta(text, metrics, ""),
      };
    }

    throw new AppError(ErrorCode.NO_MEDIA_FOUND, "小红书页面中没有发现可展示资源。", 404);
  }

  const user = note.user && typeof note.user === "object" ? note.user : {};
  const handle = user.nickname || user.nickName || user.userId || "unknown";
  const filenameBase = `xiaohongshu_${safeFilenamePart(handle)}_${active.shortcode}`;
  const mediaHeaders = xiaohongshuMediaHeaders(pageUrl, settings);
  const assets = xiaohongshuAssetsFromNote(note, filenameBase, mediaHeaders);

  if (assets.length === 0) {
    assets.push(...htmlAssets);
  }

  if (assets.length === 0) {
    assets.push(...xiaohongshuMetaAssets(text, active.shortcode, pageUrl, settings));
  }

  if (assets.length === 0) {
    throw new AppError(ErrorCode.NO_MEDIA_FOUND, "小红书页面中没有发现可展示资源。", 404);
  }

  const metrics = metricsFromXiaohongshu(note);

  return {
    assets: dedupeAssets(assets),
    metrics,
    creator_handle: handle,
    post_info: postInfoFromXiaohongshu(note, metrics, handle),
  };
}

async function fetchXiaohongshuPageText(options) {
  const allowRestrictedText = Boolean(options.allowRestrictedText);

  if (options.forceCurl) {
    const text = await fetchXiaohongshuPageTextWithCurl(options);

    if (!allowRestrictedText && looksLikeXiaohongshuVerification(text)) {
      throw xiaohongshuRestrictedError({ reason: "curl_verification_page" });
    }

    return {
      headers: new Headers(),
      response: null,
      text,
    };
  }

  try {
    return await fetchTextResponse(options);
  } catch (error) {
    if (isXiaohongshuRestrictedError(error)) {
      throw xiaohongshuRestrictedError({
        reason: "restricted_redirect",
        upstream: error.details,
      });
    }

    if (!shouldUseXiaohongshuCurlFallback(error)) {
      throw error;
    }

    const text = await fetchXiaohongshuPageTextWithCurl(options);

    if (!allowRestrictedText && looksLikeXiaohongshuVerification(text)) {
      throw xiaohongshuRestrictedError({ reason: "curl_verification_page" });
    }

    return {
      headers: new Headers(),
      response: null,
      text,
    };
  }
}

async function fetchXiaohongshuPageTextWithMobileFallback({
  pageUrl,
  pageHeaders,
  shortcode,
  settings,
}) {
  try {
    const response = await fetchXiaohongshuPageText({
      url: pageUrl,
      headers: pageHeaders,
      label: "Xiaohongshu",
      timeoutMs: settings.httpTimeoutMs,
    });

    if (
      looksLikeXiaohongshuVerification(response.text) &&
      xiaohongshuHtmlAssets(response.text, shortcode, pageUrl, settings).length === 0
    ) {
      return await fetchXiaohongshuMobilePageText({
        pageUrl,
        shortcode,
        settings,
        upstream: { reason: "desktop_restricted_text" },
      });
    }

    return response;
  } catch (error) {
    if (!isXiaohongshuRestrictedError(error)) {
      throw error;
    }

    return await fetchXiaohongshuMobilePageText({
      pageUrl,
      shortcode,
      settings,
      upstream: error.details,
    });
  }
}

async function fetchXiaohongshuMobilePageText({
  pageUrl,
  shortcode,
  settings,
  upstream,
}) {
  const mobileHeaders = xiaohongshuMobilePageHeaders(settings);
  const mobileUrl = xiaohongshuMobileUrl(pageUrl, shortcode);
  const mobileResponse = await fetchXiaohongshuPageText({
    url: mobileUrl,
    headers: mobileHeaders,
    label: "Xiaohongshu mobile",
    timeoutMs: settings.httpTimeoutMs,
    allowRestrictedText: true,
    forceCurl: true,
  });
  const mobileAssets = xiaohongshuHtmlAssets(mobileResponse.text, shortcode, pageUrl, settings);

  if (mobileAssets.length === 0 && looksLikeXiaohongshuVerification(mobileResponse.text)) {
    throw xiaohongshuRestrictedError({
      reason: "mobile_h5_restricted",
      upstream,
    });
  }

  return {
    ...mobileResponse,
    source: "xiaohongshu_mobile_h5",
  };
}

function shouldUseXiaohongshuCurlFallback(error) {
  const details = [
    error?.message,
    error?.details,
    error?.cause?.message,
    error?.cause?.code,
  ]
    .filter(Boolean)
    .join(" ");

  return XIAOHONGSHU_CURL_FALLBACK_ERRORS.some((pattern) =>
    details.toLowerCase().includes(pattern.toLowerCase()),
  );
}

async function fetchXiaohongshuPageTextWithCurl({ url, headers, label, timeoutMs }) {
  const timeoutSeconds = Math.max(1, Math.ceil((timeoutMs || 20_000) / 1000));
  const args = [
    "-sS",
    "-L",
    "--compressed",
    "--max-time",
    String(timeoutSeconds),
    "-A",
    headers["user-agent"],
    "-H",
    `accept: ${headers.accept}`,
    "-H",
    `accept-language: ${headers["accept-language"]}`,
    "-H",
    `referer: ${headers.Referer}`,
  ];
  const cookieHeader = headers.cookie || headers.Cookie;

  if (cookieHeader) {
    args.push("-H", `cookie: ${cookieHeader}`);
  }

  args.push("--http1.1", url);

  try {
    const { stdout } = await execFile("curl", args, {
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
      timeout: (timeoutSeconds + 2) * 1000,
    });

    return stdout;
  } catch (error) {
    if (error?.signal === "SIGTERM" || error?.killed) {
      throw new AppError(ErrorCode.UPSTREAM_BLOCKED, `${label} 页面请求超时。`, 504);
    }

    throw new AppError(
      ErrorCode.UPSTREAM_BLOCKED,
      `无法访问 ${label} 页面（curl fallback 失败）。`,
      502,
      error?.message,
    );
  }
}

function xiaohongshuPageHeaders(settings = {}) {
  return withCookieHeader(XIAOHONGSHU_HEADERS, xiaohongshuCookieHeader(settings));
}

function xiaohongshuMobilePageHeaders(settings = {}) {
  return withCookieHeader(XIAOHONGSHU_MOBILE_HEADERS, xiaohongshuCookieHeader(settings));
}

function xiaohongshuMobileUrl(pageUrl, shortcode) {
  const parsed = new URL(pageUrl);

  if (shortcode) {
    parsed.pathname = `/explore/${shortcode}`;
  }

  return parsed.toString();
}

function xiaohongshuCookieHeader(settings = {}) {
  const raw = String(
    settings.xiaohongshuCookie ||
      process.env.SOCIAL_XIAOHONGSHU_COOKIE ||
      process.env.SOCIAL_XHS_COOKIE ||
      process.env.XIAOHONGSHU_COOKIE ||
      process.env.XHS_COOKIE ||
      "",
  )
    .trim()
    .replace(/^cookie\s*:\s*/i, "")
    .replace(/^["']|["']$/g, "");

  return raw.includes("=") ? raw.replace(/[\r\n]+/g, " ").trim() : "";
}

function isXiaohongshuRestrictedError(error) {
  if (
    error instanceof AppError &&
    error.code === ErrorCode.UPSTREAM_BLOCKED &&
    (error.details?.hint === XIAOHONGSHU_RESTRICTED_HINT || /小红书限制/.test(error.message))
  ) {
    return true;
  }

  const details = error?.details;
  const text = [
    error?.message,
    typeof details === "string" ? details : "",
    details?.final_url,
    details?.location,
    details?.body_excerpt,
  ]
    .filter(Boolean)
    .join(" ");

  return looksLikeXiaohongshuRestrictedText(text);
}

function xiaohongshuRestrictedError(details = {}) {
  return new AppError(
    ErrorCode.UPSTREAM_BLOCKED,
    "小红书限制了这条笔记的公开访问或触发了安全验证，暂时无法用匿名公开页面解析资源。",
    502,
    {
      ...details,
      hint: XIAOHONGSHU_RESTRICTED_HINT,
    },
  );
}

function extractXiaohongshuInitialState(text) {
  const assignment = /window\.__INITIAL_STATE__\s*=/i.exec(text);

  if (!assignment) {
    return null;
  }

  const afterAssignment = text.slice(assignment.index + assignment[0].length);
  const encodedMatch = /JSON\.parse\(\s*decodeURIComponent\(\s*["']([^"']+)["']\s*\)\s*\)/i.exec(afterAssignment);

  if (encodedMatch) {
    return parseXiaohongshuStateJson(decodeURIComponentSafe(encodedMatch[1]));
  }

  const startIndex = afterAssignment.indexOf("{");

  if (startIndex < 0) {
    return null;
  }

  const endIndex = balancedJsonEndIndex(afterAssignment, startIndex);

  if (endIndex < 0) {
    return null;
  }

  return parseXiaohongshuStateJson(afterAssignment.slice(startIndex, endIndex));
}

function decodeURIComponentSafe(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function parseXiaohongshuStateJson(rawJson) {
  const decoded = htmlUnescape(String(rawJson || ""));
  const attempts = [
    decoded,
    decoded.replace(/\bundefined\b/g, "null"),
    decoded
      .replace(/([{,]\s*)([A-Za-z_$][\w$]*)\s*:/g, '$1"$2":')
      .replace(/\bundefined\b/g, "null"),
  ];

  for (const attempt of attempts) {
    try {
      return JSON.parse(attempt);
    } catch {
      // Try the next normalization.
    }
  }

  return null;
}

function findXiaohongshuNote(initialState, noteId) {
  if (!initialState || typeof initialState !== "object") {
    return null;
  }

  const detailMap = dig(initialState, "note", "noteDetailMap");
  const currentNoteId = dig(initialState, "note", "currentNoteId");

  for (const key of [noteId, currentNoteId]) {
    const note = noteFromXiaohongshuMap(detailMap, key);

    if (note) {
      return note;
    }
  }

  if (detailMap && typeof detailMap === "object") {
    for (const value of Object.values(detailMap)) {
      const note = value?.note && typeof value.note === "object" ? value.note : value;

      if (isXiaohongshuNoteCandidate(note)) {
        return note;
      }
    }
  }

  return findXiaohongshuNoteRecursive(initialState, noteId);
}

function noteFromXiaohongshuMap(detailMap, noteId) {
  if (!detailMap || typeof detailMap !== "object" || !noteId) {
    return null;
  }

  const entry = detailMap[noteId];
  const note = entry?.note && typeof entry.note === "object" ? entry.note : entry;

  return isXiaohongshuNoteCandidate(note) ? note : null;
}

function findXiaohongshuNoteRecursive(value, noteId, seen = new WeakSet(), depth = 0) {
  if (!value || typeof value !== "object" || depth > 8 || seen.has(value)) {
    return null;
  }

  seen.add(value);

  if (isXiaohongshuNoteCandidate(value) && (!noteId || value.noteId === noteId || value.id === noteId)) {
    return value;
  }

  if (value.note && isXiaohongshuNoteCandidate(value.note)) {
    const note = value.note;

    if (!noteId || note.noteId === noteId || note.id === noteId) {
      return note;
    }
  }

  let fallback = isXiaohongshuNoteCandidate(value) ? value : null;
  const children = Array.isArray(value) ? value : Object.values(value);

  for (const child of children) {
    const found = findXiaohongshuNoteRecursive(child, noteId, seen, depth + 1);

    if (found && (found.noteId === noteId || found.id === noteId)) {
      return found;
    }

    fallback ||= found;
  }

  return fallback;
}

function isXiaohongshuNoteCandidate(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  return Boolean(
    (value.noteId || value.id) &&
    (Array.isArray(value.imageList) || value.video || value.interactInfo || value.user),
  );
}

function xiaohongshuAssetsFromNote(note, filenameBase, mediaHeaders) {
  const assets = [];
  const videoUrls = xiaohongshuVideoUrls(note);

  if (videoUrls.length > 0) {
    assets.push({
      source_url: videoUrls[0].url,
      fallback_urls: videoUrls.slice(1).map((item) => item.url),
      media_type: "video",
      width: videoUrls[0].width,
      height: videoUrls[0].height,
      filename_hint: `${filenameBase}.mp4`,
      request_headers: mediaHeaders,
    });
  }

  const imageList = Array.isArray(note.imageList) ? note.imageList : [];

  imageList.forEach((imageData, index) => {
    const imageUrls = xiaohongshuImageUrls(imageData);
    const imageUrl = imageUrls[0];

    if (imageUrl) {
      assets.push({
        source_url: imageUrl,
        fallback_urls: imageUrls.slice(1),
        media_type: "image",
        width: optionalInt(imageData?.width),
        height: optionalInt(imageData?.height),
        filename_hint: `${filenameBase}_photo_${index + 1}.jpg`,
        request_headers: mediaHeaders,
      });
    }

    const livePhotoUrls = xiaohongshuVideoUrls(imageData);

    if (livePhotoUrls.length > 0) {
      assets.push({
        source_url: livePhotoUrls[0].url,
        fallback_urls: livePhotoUrls.slice(1).map((item) => item.url),
        media_type: "video",
        width: livePhotoUrls[0].width,
        height: livePhotoUrls[0].height,
        filename_hint: `${filenameBase}_live_${index + 1}.mp4`,
        request_headers: mediaHeaders,
      });
    }
  });

  return assets;
}

function xiaohongshuVideoUrls(container) {
  const stream = dig(container, "video", "media", "stream") || container?.stream;

  if (!stream || typeof stream !== "object") {
    return [];
  }

  const candidates = [];

  for (const codec of ["h264", "av1", "h265", "h266"]) {
    const items = Array.isArray(stream[codec]) ? stream[codec] : [];

    items.forEach((item) => {
      if (!item || typeof item !== "object") {
        return;
      }

      const score = xiaohongshuVideoScore(item, codec);
      const urls = [
        item.mediaUrl,
        item.masterUrl,
        item.url,
        item.backupUrl,
        item.backupUrls,
      ].flatMap((value) => Array.isArray(value) ? value : [value]);

      urls.forEach((url) => {
        if (typeof url === "string" && /^https?:\/\//i.test(url)) {
          candidates.push({
            url: htmlUnescape(url),
            width: optionalInt(item.width),
            height: optionalInt(item.height),
            score,
          });
        }
      });
    });
  }

  const seen = new Set();

  return candidates
    .sort((left, right) => right.score - left.score)
    .filter((item) => {
      if (seen.has(item.url)) {
        return false;
      }

      seen.add(item.url);
      return true;
    });
}

function xiaohongshuVideoScore(item, codec) {
  const codecScore = codec === "h264" ? 30 : codec === "av1" ? 20 : 10;
  const width = optionalInt(item.width) || 0;
  const height = optionalInt(item.height) || 0;
  const bitrate = firstPresentInt(item.avgBitrate, item.videoBitrate, item.bitrate, item.size) || 0;

  return codecScore + width * height + bitrate;
}

function xiaohongshuImageUrls(imageData) {
  if (!imageData || typeof imageData !== "object") {
    return [];
  }

  const candidates = [];

  function add(value, score = 0) {
    if (typeof value === "string" && /^https?:\/\//i.test(value)) {
      const url = htmlUnescape(value);
      const watermarkPenalty = /[?&!/](crd_)?wm/i.test(url) ? -20 : 0;

      candidates.push([score + watermarkPenalty, url]);
    }
  }

  add(imageData.urlDefault, 80);
  add(imageData.urlPre, 70);
  add(imageData.url, 60);
  add(imageData.originalUrl, 90);

  if (Array.isArray(imageData.infoList)) {
    imageData.infoList.forEach((item) => {
      const scene = String(item?.imageScene || "");
      const sceneScore = /origin|original/i.test(scene) ? 95 : /wm/i.test(scene) ? 45 : 65;

      add(item?.url, sceneScore);
    });
  }

  for (const url of [...candidates.map((candidate) => candidate[1])]) {
    const noWatermarkUrl = xiaohongshuNoWatermarkImageUrl(url);

    if (noWatermarkUrl) {
      candidates.push([85, noWatermarkUrl]);
    }
  }

  const seen = new Set();

  return candidates
    .sort((left, right) => right[0] - left[0])
    .map((candidate) => candidate[1])
    .filter((url) => {
      if (seen.has(url)) {
        return false;
      }

      seen.add(url);
      return true;
    });
}

function xiaohongshuNoWatermarkImageUrl(value) {
  if (!value) {
    return "";
  }

  try {
    const parsed = new URL(value);
    const spectrumMarker = "/spectrum/";
    const markerIndex = parsed.pathname.includes(spectrumMarker)
      ? parsed.pathname.indexOf(spectrumMarker) + spectrumMarker.length
      : parsed.pathname.lastIndexOf("/") + 1;
    const imagePath = markerIndex >= 0 ? parsed.pathname.slice(markerIndex) : "";
    const imageId = imagePath.split("!", 1)[0].replace(/^\/+/, "");

    if (!imageId || imageId.includes(".")) {
      return "";
    }

    return `https://ci.xiaohongshu.com/notes_pre_post/${imageId}?imageView2/format/jpg`;
  } catch {
    return "";
  }
}

function xiaohongshuHtmlAssets(text, shortcode, pageUrl, settings = {}) {
  const headers = xiaohongshuMediaHeaders(pageUrl, settings);
  const assets = [];
  const imageUrls = xiaohongshuHtmlImageUrls(text);
  const videoUrls = xiaohongshuHtmlVideoUrls(text);

  videoUrls.forEach((url, index) => {
    assets.push({
      source_url: url,
      media_type: "video",
      filename_hint: `xiaohongshu_${shortcode}_h5_video_${index + 1}.mp4`,
      request_headers: headers,
    });
  });

  imageUrls.forEach((url, index) => {
    const originalUrl = xiaohongshuNoWatermarkImageUrl(url);
    const fallbackUrls = [originalUrl].filter((candidate) => candidate && candidate !== url);

    assets.push({
      source_url: url,
      fallback_urls: fallbackUrls,
      media_type: "image",
      filename_hint: `xiaohongshu_${shortcode}_h5_photo_${index + 1}.jpg`,
      request_headers: headers,
    });
  });

  return dedupeAssets(assets);
}

function xiaohongshuHtmlImageUrls(text) {
  const candidates = [];

  for (const match of String(text || "").matchAll(/<img\b[^>]*(?:data-xhs-img|notes_pre_post)[^>]*>/gi)) {
    const src = htmlAttribute(match[0], "src");

    if (isXiaohongshuNoteImageUrl(src)) {
      candidates.push(normalizeXiaohongshuCdnUrl(src));
    }
  }

  for (const match of String(text || "").matchAll(/https?:\\?\/\\?\/[^"'<>\\\s]+notes_pre_post[^"'<>\\\s]*/gi)) {
    const url = decodeXiaohongshuEmbeddedUrl(match[0]);

    if (isXiaohongshuNoteImageUrl(url)) {
      candidates.push(normalizeXiaohongshuCdnUrl(url));
    }
  }

  return uniqueXiaohongshuUrls(candidates);
}

function xiaohongshuHtmlVideoUrls(text) {
  const candidates = [];

  for (const match of String(text || "").matchAll(/<video\b[^>]*>/gi)) {
    const src = htmlAttribute(match[0], "src");

    if (isXiaohongshuVideoUrl(src)) {
      candidates.push(normalizeXiaohongshuCdnUrl(src));
    }
  }

  for (const match of String(text || "").matchAll(/https?:\\?\/\\?\/[^"'<>\\\s]+(?:\.mp4|sns-video|v\.xhscdn)[^"'<>\\\s]*/gi)) {
    const url = decodeXiaohongshuEmbeddedUrl(match[0]);

    if (isXiaohongshuVideoUrl(url)) {
      candidates.push(normalizeXiaohongshuCdnUrl(url));
    }
  }

  return uniqueXiaohongshuUrls(candidates);
}

function htmlAttribute(tag, name) {
  const pattern = new RegExp(`\\b${name}\\s*=\\s*(["'])(.*?)\\1`, "i");
  const match = pattern.exec(tag);

  return match ? htmlUnescape(match[2]) : "";
}

function decodeXiaohongshuEmbeddedUrl(value) {
  return htmlUnescape(String(value || ""))
    .replace(/\\u002[fF]/g, "/")
    .replace(/\\\//g, "/");
}

function normalizeXiaohongshuCdnUrl(value) {
  return decodeXiaohongshuEmbeddedUrl(value);
}

function uniqueXiaohongshuUrls(urls) {
  const seen = new Set();
  const output = [];

  for (const url of urls) {
    if (!url || seen.has(url)) {
      continue;
    }

    seen.add(url);
    output.push(url);
  }

  return output;
}

function isXiaohongshuNoteImageUrl(value) {
  return /^https?:\/\//i.test(String(value || "")) &&
    /xhscdn\.com/i.test(value) &&
    /\/notes_pre_post\//i.test(value);
}

function isXiaohongshuVideoUrl(value) {
  return /^https?:\/\//i.test(String(value || "")) &&
    /xhscdn\.com/i.test(value) &&
    /(?:\.mp4|sns-video|v\.xhscdn)/i.test(value);
}

function xiaohongshuMetaAssets(text, shortcode, pageUrl, settings = {}) {
  const headers = xiaohongshuMediaHeaders(pageUrl, settings);
  const assets = [];
  const video = metaContents(text, ["og:video", "og:video:url", "og:video:secure_url"])[0];
  const image = metaContents(text, ["og:image", "og:image:url", "og:image:secure_url"])[0];

  if (video) {
    assets.push({
      source_url: video,
      media_type: "video",
      filename_hint: `xiaohongshu_${shortcode}.mp4`,
      request_headers: headers,
    });
  }

  if (image) {
    assets.push({
      source_url: image,
      media_type: "image",
      filename_hint: `xiaohongshu_${shortcode}.jpg`,
      request_headers: headers,
    });
  }

  return assets;
}

function looksLikeXiaohongshuVerification(text) {
  return looksLikeXiaohongshuRestrictedText(text);
}

function looksLikeXiaohongshuRestrictedText(text) {
  return /captcha|verify|安全验证|滑块验证|环境异常|访问频繁|\/404\/sec_|error_code=300031|当前笔记暂时无法浏览|当前内容仅支持在小红书 APP 内查看|sec_WZRZJKCu/i.test(String(text || ""));
}

function postInfoFromXiaohongshu(note, metrics, creatorHandle) {
  const user = note?.user && typeof note.user === "object" ? note.user : {};
  const body = pickText(note?.desc, note?.description, note?.content);

  return createPostInfo(
    {
      title: pickSingleLineText(note?.title, titleFromBody(body)),
      author: pickSingleLineText(user.nickname, user.nickName, creatorHandle),
      author_handle: pickSingleLineText(user.userId, user.user_id, creatorHandle),
      body,
      tags: normalizeTags(xiaohongshuTags(note), body),
      metrics,
      source: metrics?.source || "xiaohongshu_public_best_effort",
    },
    { metrics, creatorHandle, source: metrics?.source || "xiaohongshu_public_best_effort" },
  );
}

function xiaohongshuTags(note) {
  const values = [];

  for (const key of ["tagList", "hashTagList", "hashTags", "topicList"]) {
    if (Array.isArray(note?.[key])) {
      values.push(...note[key]);
    }
  }

  return values;
}

function metricsFromXiaohongshu(detail) {
  const stats = detail?.interactInfo && typeof detail.interactInfo === "object" ? detail.interactInfo : {};

  return {
    like_count: parseXiaohongshuCount(stats.likedCount ?? stats.likeCount),
    comment_count: parseXiaohongshuCount(stats.commentCount),
    view_count: parseXiaohongshuCount(stats.viewCount),
    save_count: parseXiaohongshuCount(stats.collectedCount ?? stats.collectCount),
    share_count: parseXiaohongshuCount(stats.shareCount),
    source: "xiaohongshu_public_best_effort",
  };
}

function parseXiaohongshuCount(value) {
  if (value == null || value === "" || typeof value === "boolean") {
    return null;
  }

  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.trunc(value);
  }

  const text = String(value).trim().replaceAll(",", "");

  if (!text || ["赞", "收藏", "评论", "分享"].includes(text)) {
    return null;
  }

  const match = /^(\d+(?:\.\d+)?)(万|w|k|千)?$/i.exec(text);

  if (!match) {
    return optionalInt(text);
  }

  const number = Number.parseFloat(match[1]);
  const unit = match[2]?.toLowerCase();
  const multiplier = unit === "万" || unit === "w" ? 10_000 : unit === "k" || unit === "千" ? 1_000 : 1;

  return Number.isFinite(number) ? Math.round(number * multiplier) : null;
}

function xiaohongshuMediaHeaders(pageUrl, settings = {}) {
  return withCookieHeader({
    Referer: pageUrl,
    Origin: "https://www.xiaohongshu.com",
    "user-agent": XIAOHONGSHU_HEADERS["user-agent"],
    accept: "image/avif,image/webp,image/apng,image/*,video/*,*/*;q=0.8",
    "accept-language": XIAOHONGSHU_HEADERS["accept-language"],
  }, xiaohongshuCookieHeader(settings));
}

export function isXiaohongshuHost(host) {
  return [
    "xiaohongshu.com",
    "www.xiaohongshu.com",
    "m.xiaohongshu.com",
    "xhslink.com",
    "www.xhslink.com",
    "xhs.cn",
    "www.xhs.cn",
    "rednote.com",
    "www.rednote.com",
  ].includes(host) || host.endsWith(".xiaohongshu.com") || host.endsWith(".rednote.com");
}

function isXiaohongshuShortHost(host) {
  return ["xhslink.com", "www.xhslink.com", "xhs.cn", "www.xhs.cn"].includes(host);
}
