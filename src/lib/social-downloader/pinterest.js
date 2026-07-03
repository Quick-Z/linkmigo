import { URL } from "node:url";

import { AppError, ErrorCode } from "./errors";
import {
  cleanUrl,
  dedupeAssets,
  dig,
  extractEmbeddedJsonObjects,
  fetchTextResponse,
  fetchWithTimeout,
  firstPresentInt,
  htmlUnescape,
  metaContents,
  optionalInt,
  PAGE_HEADERS,
  responseJson,
  scriptTexts,
} from "./utils";
import {
  createPostInfo,
  normalizeTags,
  pickSingleLineText,
  pickText,
} from "./post-info";
import {
  cookieHeaderFromSetCookie,
  loadsJsonValues,
  postInfoFromHtmlMeta,
  resolveRedirect,
  safeFilenamePart,
  titleFromBody,
  uniqueUrls,
  withCookieHeader,
} from "./shared";

const PINTEREST_HEADERS = {
  ...PAGE_HEADERS,
  accept:
    "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
  "accept-language": "en-US,en;q=0.9",
  Referer: "https://www.pinterest.com/",
};

export function normalizePinterestUrl(parsed) {
  const parts = parsed.pathname.split("/").filter(Boolean);
  const host = parsed.hostname.toLowerCase();

  if (isPinterestShortHost(host) && parts[0]) {
    return {
      canonical_url: cleanUrl(parsed),
      shortcode: parts[0],
      kind: "short",
      platform: "pinterest",
    };
  }

  const pinIndex = parts.findIndex((part) => part.toLowerCase() === "pin");
  const pinId = pinIndex >= 0 ? parts[pinIndex + 1] : "";

  if (/^\d{5,32}$/.test(pinId)) {
    return {
      canonical_url: `https://www.pinterest.com/pin/${pinId}/`,
      shortcode: pinId,
      kind: "pin",
      platform: "pinterest",
    };
  }

  throw new AppError(ErrorCode.UNSUPPORTED_URL, "仅支持 Pinterest Pin 链接或 pin.it 短链接。", 400);
}

export async function resolvePinterestPost(normalized, settings) {
  let active = normalized;

  if (active.kind === "short") {
    const redirected = await resolveRedirect(active.canonical_url, settings, PINTEREST_HEADERS);

    if (redirected) {
      active = normalizePinterestUrl(new URL(redirected));
    }
  }

  if (active.kind === "short" || !/^\d{5,32}$/.test(active.shortcode)) {
    throw new AppError(ErrorCode.NO_MEDIA_FOUND, "Pinterest 短链接没有解析到 Pin ID。", 404);
  }

  const pageResponse = await fetchTextResponse({
    url: active.canonical_url,
    headers: PINTEREST_HEADERS,
    label: "Pinterest",
    timeoutMs: settings.httpTimeoutMs,
  });
  const pageUrl = pageResponse.response?.url || active.canonical_url;
  const text = pageResponse.text;
  const cookieHeader = cookieHeaderFromSetCookie(pageResponse.headers);
  const pin =
    (await requestPinterestPinResource(active.shortcode, pageUrl, settings, cookieHeader)) ||
    (await requestPinterestWidgetPin(active.shortcode, pageUrl, settings, cookieHeader)) ||
    findPinterestPinData(text, active.shortcode);
  const mediaHeaders = pinterestMediaHeaders(pageUrl, cookieHeader);
  const handle = pinterestCreatorHandle(pin, text);
  const filenameBase = `pinterest_${safeFilenamePart(handle || "pin")}_${active.shortcode}`;
  const assets = pin ? pinterestAssetsFromPin(pin, filenameBase, mediaHeaders) : [];

  if (assets.length === 0) {
    assets.push(...pinterestMetaAssets(text, active.shortcode, mediaHeaders));
  }

  if (assets.length === 0) {
    if (looksLikePinterestLoginRequired(text)) {
      throw new AppError(ErrorCode.LOGIN_REQUIRED, "这个 Pinterest Pin 需要登录后访问。", 403);
    }

    throw new AppError(ErrorCode.NO_MEDIA_FOUND, "Pinterest 页面中没有发现可展示资源。", 404);
  }

  const metrics = metricsFromPinterest(pin);

  return {
    assets: dedupeAssets(assets),
    metrics,
    creator_handle: handle,
    post_info: pin
      ? postInfoFromPinterest(pin, text, metrics, handle)
      : postInfoFromHtmlMeta(text, metrics, handle),
  };
}

async function requestPinterestPinResource(pinId, pageUrl, settings, cookieHeader = "") {
  const resourceUrl = new URL("https://www.pinterest.com/resource/PinResource/get/");
  const data = {
    options: {
      id: pinId,
      field_set_key: "detailed",
    },
    context: {},
  };

  resourceUrl.searchParams.set("source_url", `/pin/${pinId}/`);
  resourceUrl.searchParams.set("data", JSON.stringify(data));

  try {
    const response = await fetchWithTimeout(
      resourceUrl.toString(),
      {
        headers: withCookieHeader({
          ...PINTEREST_HEADERS,
          accept: "application/json, text/javascript, */*; q=0.01",
          "x-requested-with": "XMLHttpRequest",
          Referer: pageUrl,
        }, cookieHeader),
        cache: "no-store",
      },
      settings.httpTimeoutMs,
    );
    const payload = await responseJson(response);
    const data = payload?.resource_response?.data || payload?.resource?.data || payload?.data;

    return isPinterestPinCandidate(data, pinId) ? data : findPinterestPinRecursive(data, pinId);
  } catch {
    return null;
  }
}

async function requestPinterestWidgetPin(pinId, pageUrl, settings, cookieHeader = "") {
  const endpoints = [
    "https://widgets.pinterest.com/v3/pidgets/pins/info/",
    "https://api.pinterest.com/v3/pidgets/pins/info/",
  ];

  for (const endpoint of endpoints) {
    const resourceUrl = new URL(endpoint);

    resourceUrl.searchParams.set("pin_ids", pinId);

    try {
      const response = await fetchWithTimeout(
        resourceUrl.toString(),
        {
          headers: withCookieHeader({
            ...PINTEREST_HEADERS,
            accept: "application/json, text/javascript, */*; q=0.01",
            Referer: pageUrl,
          }, cookieHeader),
          cache: "no-store",
        },
        settings.httpTimeoutMs,
      );
      const payload = await responseJson(response);
      const data = payload?.data?.[pinId] || payload?.resource_response?.data?.[pinId] || payload?.data;
      const pin = isPinterestPinCandidate(data, pinId) ? data : findPinterestPinRecursive(data, pinId);

      if (pin) {
        return pin;
      }
    } catch {
      // Try the next public widget host, then fall back to embedded page data.
    }
  }

  return null;
}

function findPinterestPinData(text, pinId) {
  const sources = [];

  for (const script of scriptTexts(text, { type: "application/ld+json" })) {
    sources.push(...loadsJsonValues(script));
  }

  for (const script of scriptTexts(text)) {
    if (!script || !/(PinResource|video_list|videos|__PWS|props|pin)/i.test(script)) {
      continue;
    }

    sources.push(...loadsJsonValues(script));
    sources.push(...extractEmbeddedJsonObjects(script, [
      "PinResource",
      "video_list",
      "videos",
      "__PWS",
      "props",
      "pin",
    ]));
  }

  for (const data of sources) {
    const pin = findPinterestPinRecursive(data, pinId);

    if (pin) {
      return pin;
    }
  }

  return null;
}

function findPinterestPinRecursive(value, pinId, seen = new WeakSet(), depth = 0) {
  if (!value || typeof value !== "object" || depth > 12 || seen.has(value)) {
    return null;
  }

  seen.add(value);

  if (isPinterestPinCandidate(value, pinId)) {
    return value;
  }

  if (value.data && isPinterestPinCandidate(value.data, pinId)) {
    return value.data;
  }

  if (value.pin && isPinterestPinCandidate(value.pin, pinId)) {
    return value.pin;
  }

  let fallback = isPinterestPinCandidate(value, "") ? value : null;
  const children = Array.isArray(value) ? value : Object.values(value);

  for (const child of children) {
    const found = findPinterestPinRecursive(child, pinId, seen, depth + 1);

    if (found && (!pinId || pinterestPinId(found) === pinId)) {
      return found;
    }

    fallback ||= found;
  }

  return fallback;
}

function isPinterestPinCandidate(value, pinId) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  const id = pinterestPinId(value);
  if (pinId) {
    return id === pinId;
  }

  return Boolean(
    id &&
    (
      value.videos ||
      value.video_list ||
      value.video_url ||
      value.video ||
      dig(value, "story_pin_data", "pages") ||
      dig(value, "images", "orig") ||
      value.image ||
      value.images
    ),
  );
}

function pinterestPinId(value) {
  const id = value?.id ?? value?.pin_id ?? value?.pinId;

  return id == null ? "" : String(id);
}

function pinterestAssetsFromPin(pin, filenameBase, mediaHeaders) {
  const assets = [];
  const videoUrls = pinterestVideoUrls(pin);
  const videoUrl = videoUrls[0];

  if (videoUrl) {
    assets.push({
      source_url: videoUrl.url,
      fallback_urls: videoUrls.slice(1).map((item) => item.url),
      media_type: "video",
      width: videoUrl.width,
      height: videoUrl.height,
      filename_hint: `${filenameBase}.mp4`,
      request_headers: mediaHeaders,
    });
  }

  for (const [index, imageUrl] of pinterestImageUrls(pin).entries()) {
    assets.push({
      source_url: imageUrl.url,
      fallback_urls: imageUrl.fallbackUrls,
      media_type: "image",
      width: imageUrl.width,
      height: imageUrl.height,
      filename_hint: `${filenameBase}_photo_${index + 1}.jpg`,
      request_headers: mediaHeaders,
    });
  }

  return assets;
}

function pinterestVideoUrls(pin) {
  const candidates = [];

  collectPinterestVideoCandidates(candidates, pin, 1100);
  collectPinterestVideoCandidates(candidates, pin?.videos, 1000);
  collectPinterestVideoCandidates(candidates, pin?.video_list, 950);
  collectPinterestVideoCandidates(candidates, dig(pin, "story_pin_data", "videos"), 900);
  collectPinterestStoryPageVideos(candidates, dig(pin, "story_pin_data", "pages"));

  const seen = new Set();

  return candidates
    .sort((left, right) => right.score - left.score)
    .filter((item) => {
      if (!item.url || seen.has(item.url)) {
        return false;
      }

      seen.add(item.url);
      return true;
    });
}

function collectPinterestVideoCandidates(candidates, value, baseScore = 0, inherited = {}) {
  if (!value || typeof value !== "object") {
    if (typeof value === "string") {
      addPinterestVideoUrl(candidates, value, baseScore, inherited);
    }

    return;
  }

  if (Array.isArray(value)) {
    value.forEach((item, index) => collectPinterestVideoCandidates(candidates, item, baseScore - index, inherited));
    return;
  }

  const width = firstPresentInt(value.width, value.duration_width, value.w, inherited.width);
  const height = firstPresentInt(value.height, value.duration_height, value.h, inherited.height);
  const duration = firstPresentInt(value.duration, value.duration_millis, inherited.duration);
  const bitrate = firstPresentInt(value.bitrate, value.bit_rate, value.avg_bitrate);
  const formatScore = pinterestVideoFormatScore(value);
  const nextInherited = {
    width,
    height,
    duration,
  };

  for (const key of ["url", "src", "video_url", "videoUrl", "download_url", "file_url", "playback_url", "hls_url", "dash_url"]) {
    addPinterestVideoUrl(
      candidates,
      value[key],
      baseScore + formatScore + (width || 0) * (height || 0) + (bitrate || 0),
      nextInherited,
    );
  }

  for (const [key, child] of Object.entries(value)) {
    if (["url", "src", "video_url", "videoUrl", "download_url", "file_url", "playback_url", "hls_url", "dash_url"].includes(key)) {
      continue;
    }

    if (child && typeof child === "object") {
      collectPinterestVideoCandidates(
        candidates,
        child,
        baseScore + pinterestVideoQualityScore(key),
        nextInherited,
      );
    }
  }
}

function collectPinterestStoryPageVideos(candidates, pages) {
  if (!Array.isArray(pages)) {
    return;
  }

  pages.forEach((page, index) => {
    collectPinterestVideoCandidates(candidates, page?.videos, 880 - index);
    collectPinterestVideoCandidates(candidates, page?.video, 860 - index);
    collectPinterestVideoCandidates(candidates, page?.blocks, 830 - index);
  });
}

function addPinterestVideoUrl(candidates, value, score = 0, meta = {}) {
  for (const url of pinterestUrlValues(value)) {
    if (!isPinterestMediaUrl(url, "video")) {
      continue;
    }

    candidates.push({
      url,
      width: optionalInt(meta.width),
      height: optionalInt(meta.height),
      isHls: /\.m3u8(?:$|\?)/i.test(url),
      score: score + pinterestUrlScore(url),
    });
  }
}

function pinterestVideoFormatScore(value) {
  const text = [
    value?.format,
    value?.format_note,
    value?.quality,
    value?.profile,
    value?.type,
    value?.tag,
    value?.id,
  ].map((item) => String(item || "").toLowerCase()).join(" ");

  if (/v_?720|720p|hls/.test(text)) {
    return 720;
  }

  if (/v_?480|480p/.test(text)) {
    return 480;
  }

  if (/v_?360|360p/.test(text)) {
    return 360;
  }

  if (/v_?exp|adaptive|mp4/.test(text)) {
    return 280;
  }

  return 0;
}

function pinterestVideoQualityScore(key) {
  const text = String(key || "").toLowerCase();

  if (/v_?720|720p|hls/.test(text)) {
    return 720;
  }

  if (/v_?480|480p/.test(text)) {
    return 480;
  }

  if (/v_?360|360p/.test(text)) {
    return 360;
  }

  if (/video|mp4|exp|adaptive/.test(text)) {
    return 180;
  }

  return 0;
}

function pinterestUrlScore(url) {
  const parsed = (() => {
    try {
      return new URL(url);
    } catch {
      return null;
    }
  })();
  const pathname = parsed?.pathname.toLowerCase() || url.toLowerCase();

  if (pathname.endsWith(".m3u8")) {
    return 650;
  }

  if (pathname.endsWith(".mp4")) {
    return 600;
  }

  if (pathname.endsWith(".webm")) {
    return 500;
  }

  return 0;
}

function pinterestImageUrls(pin) {
  const groups = [
    pinterestImageUrlGroup(pin?.images),
    pinterestImageUrlGroup(pin?.image),
    pinterestImageUrlGroup(dig(pin, "story_pin_data", "cover_image")),
  ].filter((group) => group.urls.length > 0);
  const pages = dig(pin, "story_pin_data", "pages");

  if (Array.isArray(pages)) {
    pages.forEach((page) => {
      for (const value of [page?.image, page?.images, page?.cover_image, page?.blocks]) {
        const group = pinterestImageUrlGroup(value);

        if (group.urls.length > 0) {
          groups.push(group);
        }
      }
    });
  }

  const seenPrimary = new Set();

  return groups
    .map((group) => ({
      url: group.urls[0],
      fallbackUrls: group.urls.slice(1),
      width: group.width,
      height: group.height,
    }))
    .filter((item) => {
      if (!item.url || seenPrimary.has(item.url)) {
        return false;
      }

      seenPrimary.add(item.url);
      return true;
    });
}

function pinterestImageUrlGroup(value) {
  const candidates = [];

  collectPinterestImageCandidates(candidates, value, 0);

  const seen = new Set();
  const sorted = candidates
    .sort((left, right) => right.score - left.score)
    .filter((item) => {
      if (!item.url || seen.has(item.url)) {
        return false;
      }

      seen.add(item.url);
      return true;
    });

  return {
    urls: sorted.map((item) => item.url),
    width: sorted[0]?.width ?? null,
    height: sorted[0]?.height ?? null,
  };
}

function collectPinterestImageCandidates(candidates, value, baseScore = 0, inherited = {}) {
  if (!value || typeof value !== "object") {
    if (typeof value === "string") {
      addPinterestImageUrl(candidates, value, baseScore, inherited);
    }

    return;
  }

  if (Array.isArray(value)) {
    value.forEach((item, index) => collectPinterestImageCandidates(candidates, item, baseScore - index, inherited));
    return;
  }

  const width = firstPresentInt(value.width, value.w, inherited.width);
  const height = firstPresentInt(value.height, value.h, inherited.height);
  const nextInherited = { width, height };

  for (const key of ["url", "src", "image_url", "imageUrl", "download_url", "original_url", "orig"]) {
    addPinterestImageUrl(
      candidates,
      value[key],
      baseScore + (width || 0) * (height || 0) + pinterestImageQualityScore(key),
      nextInherited,
    );
  }

  for (const [key, child] of Object.entries(value)) {
    if (["url", "src", "image_url", "imageUrl", "download_url", "original_url", "orig"].includes(key)) {
      continue;
    }

    if (child && typeof child === "object") {
      collectPinterestImageCandidates(
        candidates,
        child,
        baseScore + pinterestImageQualityScore(key),
        nextInherited,
      );
    }
  }
}

function addPinterestImageUrl(candidates, value, score = 0, meta = {}) {
  for (const url of pinterestUrlValues(value)) {
    if (!isPinterestMediaUrl(url, "image")) {
      continue;
    }

    for (const variantUrl of pinterestImageUrlVariants(url)) {
      candidates.push({
        url: variantUrl,
        width: optionalInt(meta.width) || pinterestImageWidthFromUrl(variantUrl),
        height: optionalInt(meta.height),
        score: score + pinterestImageUrlScore(variantUrl),
      });
    }
  }
}

function pinterestImageQualityScore(key) {
  const text = String(key || "").toLowerCase();

  if (/(?:^|_)orig(?:inal)?|originals|1200x|736x/.test(text)) {
    return 1200;
  }

  if (/564x|600x|large/.test(text)) {
    return 600;
  }

  if (/474x|medium/.test(text)) {
    return 470;
  }

  if (/236x|small|thumb/.test(text)) {
    return 230;
  }

  return 0;
}

function pinterestUrlValues(value) {
  const urls = [];

  if (typeof value === "string") {
    const decoded = htmlUnescape(value).replace(/\\\//g, "/");

    if (/^https?:\/\//i.test(decoded)) {
      urls.push(decoded);
    }

    return urls;
  }

  if (Array.isArray(value)) {
    value.forEach((item) => urls.push(...pinterestUrlValues(item)));
    return urls;
  }

  if (value && typeof value === "object") {
    for (const key of ["url", "src", "href"]) {
      urls.push(...pinterestUrlValues(value[key]));
    }
  }

  return urls;
}

function isPinterestMediaUrl(url, mediaType) {
  const text = String(url || "");

  if (!/^https?:\/\//i.test(text)) {
    return false;
  }

  if (mediaType === "video") {
    return /\.(?:mp4|m4v|mov|webm|m3u8)(?:$|\?)/i.test(text) ||
      /\/videos?\//i.test(text) ||
      /pinimg\.com\/.*(?:hls|exp|video)/i.test(text);
  }

  return isPinterestPinImageUrl(text);
}

function pinterestMetaAssets(text, shortcode, mediaHeaders) {
  const assets = [];
  const videoUrls = sortPinterestMediaUrls([
    ...metaContents(text, ["og:video", "og:video:url", "og:video:secure_url", "twitter:player:stream"]),
    ...pinterestRegexMediaUrls(text, "video"),
  ], "video");
  const imageUrls = sortPinterestMediaUrls([
    ...metaContents(text, ["og:image", "og:image:url", "og:image:secure_url", "twitter:image"]),
    ...pinterestRegexMediaUrls(text, "image"),
  ], "image");

  if (videoUrls[0]) {
    assets.push({
      source_url: videoUrls[0],
      fallback_urls: videoUrls.slice(1),
      media_type: "video",
      filename_hint: `pinterest_${shortcode}.mp4`,
      request_headers: mediaHeaders,
    });
  }

  if (imageUrls[0]) {
    assets.push({
      source_url: imageUrls[0],
      fallback_urls: imageUrls.slice(1),
      media_type: "image",
      filename_hint: `pinterest_${shortcode}.jpg`,
      request_headers: mediaHeaders,
    });
  }

  return assets;
}

function sortPinterestMediaUrls(urls, mediaType) {
  const expanded = mediaType === "image"
    ? urls.flatMap((url) => pinterestImageUrlVariants(url))
    : urls;
  const unique = uniqueUrls(expanded.filter((url) => isPinterestMediaUrl(url, mediaType)));

  return unique.sort((left, right) => {
    const leftScore = mediaType === "image" ? pinterestImageUrlScore(left) : pinterestUrlScore(left);
    const rightScore = mediaType === "image" ? pinterestImageUrlScore(right) : pinterestUrlScore(right);

    return rightScore - leftScore;
  });
}

function pinterestImageUrlVariants(url) {
  const normalized = htmlUnescape(String(url || "")).replace(/\\\//g, "/");

  if (!normalized) {
    return [];
  }

  let parsed;

  try {
    parsed = new URL(normalized);
  } catch {
    return [normalized];
  }

  if (!/pinimg\.com$/i.test(parsed.hostname)) {
    return [normalized];
  }

  const parts = parsed.pathname.split("/").filter(Boolean);
  let tail = [];

  if (/^control\d*$/i.test(parts[0]) && /^[0-9]+x$/i.test(parts[1])) {
    tail = parts.slice(2);
  } else if (/^(?:originals|[0-9]+x)$/i.test(parts[0])) {
    tail = parts.slice(1);
  } else {
    return [normalized];
  }

  if (tail.length < 2) {
    return [normalized];
  }

  const base = `${parsed.protocol}//${parsed.host}`;
  const suffix = tail.join("/");
  const search = parsed.search || "";

  return uniqueUrls([
    `${base}/originals/${suffix}${search}`,
    `${base}/control1/1200x/${suffix}${search}`,
    `${base}/1200x/${suffix}${search}`,
    `${base}/736x/${suffix}${search}`,
    normalized,
  ]);
}

function pinterestImageUrlScore(url) {
  let parsed = null;
  let pathname = "";

  try {
    parsed = new URL(url);
    pathname = parsed.pathname.toLowerCase();
  } catch {
    pathname = String(url || "").toLowerCase();
  }

  if (isPinterestDecorativeImagePath(pathname)) {
    return -10_000;
  }

  const hostBonus = parsed && /^i\.pinimg\.com$/i.test(parsed.hostname) ? 1_500 : 0;

  if (/\/originals\//.test(pathname)) {
    return 5000 + hostBonus;
  }

  const sized = /\/(?:control\d*\/)?([0-9]+)x\//.exec(pathname);

  if (sized) {
    const width = Number.parseInt(sized[1], 10) || 0;
    const controlBonus = /\/control\d*\//.test(pathname) ? 100 : 0;

    return width + controlBonus + hostBonus;
  }

  if (/large|orig|full/.test(pathname)) {
    return 1000 + hostBonus;
  }

  if (/thumb|small|236x/.test(pathname)) {
    return -500;
  }

  return 0;
}

function isPinterestPinImageUrl(url) {
  let parsed;

  try {
    parsed = new URL(url);
  } catch {
    return false;
  }

  const hostname = parsed.hostname.toLowerCase();
  const pathname = parsed.pathname.toLowerCase();

  if (!hostname.endsWith(".pinimg.com") && hostname !== "pinimg.com") {
    return false;
  }

  if (hostname !== "i.pinimg.com") {
    return false;
  }

  if (isPinterestDecorativeImagePath(pathname)) {
    return false;
  }

  if (/\/originals\//i.test(pathname)) {
    return true;
  }

  const sized = /\/(?:control\d*\/)?([0-9]+)x\//i.exec(pathname);

  if (sized) {
    return (Number.parseInt(sized[1], 10) || 0) >= 236;
  }

  return /\.(?:jpe?g|png|webp|gif)(?:$|\?)/i.test(parsed.pathname);
}

function isPinterestDecorativeImagePath(pathname) {
  return /(?:^|\/)(?:webapp|assets|images|static|favicon|logo|icon)(?:\/|$)/i.test(pathname) ||
    /(?:^|\/)(?:avatars?|profile|user\/default)(?:\/|$)/i.test(pathname) ||
    /\/d5\/3b\/01\/d53b014d86a6b6761bf649a0ed813c2b\.png$/i.test(pathname) ||
    /(?:favicon|logo|icon|avatar|default)[^/]*\.(?:png|webp|jpe?g|gif)$/i.test(pathname);
}

function pinterestImageWidthFromUrl(url) {
  try {
    const match = /\/(?:control\d*\/)?([0-9]+)x\//i.exec(new URL(url).pathname);

    return match ? optionalInt(match[1]) : null;
  } catch {
    return null;
  }
}

function pinterestRegexMediaUrls(text, mediaType) {
  const pattern = mediaType === "video"
    ? /https?:\\?\/\\?\/[^"'<>\\\s]+?\.(?:mp4|m4v|mov|webm|m3u8)(?:\?[^"'<>\\\s]*)?/gi
    : /https?:\\?\/\\?\/[^"'<>\\\s]+?\.(?:jpe?g|png|webp|gif)(?:\?[^"'<>\\\s]*)?/gi;
  const urls = [];
  let match;

  while ((match = pattern.exec(text))) {
    urls.push(htmlUnescape(match[0]).replace(/\\\//g, "/"));
  }

  return urls;
}

function postInfoFromPinterest(pin, text, metrics, creatorHandle) {
  const body = pickText(pin?.description, pin?.seo_description, pin?.grid_title, pin?.closeup_description);
  const pinner = pin?.pinner && typeof pin.pinner === "object" ? pin.pinner : {};
  const board = pin?.board && typeof pin.board === "object" ? pin.board : {};

  return createPostInfo(
    {
      title: pickSingleLineText(pin?.title, pin?.grid_title, board.name, titleFromBody(body)),
      author: pickSingleLineText(pinner.full_name, pinner.username, creatorHandle),
      author_handle: pickSingleLineText(pinner.username, creatorHandle),
      body,
      tags: normalizeTags(pinterestTags(pin), body),
      metrics,
      source: metrics?.source || "pinterest_public_best_effort",
    },
    { metrics, creatorHandle, source: metrics?.source || "pinterest_public_best_effort" },
  ) || postInfoFromHtmlMeta(text, metrics, creatorHandle);
}

function pinterestTags(pin) {
  const values = [];

  for (const key of ["hashtags", "rich_metadata_tags", "shopping_tags"]) {
    if (Array.isArray(pin?.[key])) {
      values.push(...pin[key]);
    }
  }

  return values;
}

function metricsFromPinterest(pin) {
  return {
    like_count: firstPresentInt(pin?.like_count, pin?.aggregated_pin_data?.aggregated_stats?.saves),
    comment_count: firstPresentInt(pin?.comment_count, pin?.aggregated_pin_data?.aggregated_stats?.comments),
    view_count: firstPresentInt(pin?.video_view_count, pin?.view_count, pin?.aggregated_pin_data?.aggregated_stats?.views),
    save_count: firstPresentInt(pin?.repin_count, pin?.save_count, pin?.aggregated_pin_data?.aggregated_stats?.saves),
    share_count: firstPresentInt(pin?.share_count, pin?.aggregated_pin_data?.aggregated_stats?.shares),
    source: "pinterest_public_best_effort",
  };
}

function pinterestCreatorHandle(pin, text) {
  const pinner = pin?.pinner && typeof pin.pinner === "object" ? pin.pinner : {};
  const owner = pin?.owner && typeof pin.owner === "object" ? pin.owner : {};

  return pickSingleLineText(
    pinner.username,
    pinner.full_name,
    owner.username,
    owner.full_name,
    metaContents(text, ["author", "article:author"])[0],
  );
}

function looksLikePinterestLoginRequired(text) {
  return /log in to|login|signup|sign up|you need to log in/i.test(text);
}

function pinterestMediaHeaders(pageUrl, cookieHeader = "") {
  return withCookieHeader({
    Referer: pageUrl,
    Origin: "https://www.pinterest.com",
    "user-agent": PINTEREST_HEADERS["user-agent"],
    accept: "image/avif,image/webp,image/apng,image/*,video/*,*/*;q=0.8",
    "accept-language": PINTEREST_HEADERS["accept-language"],
  }, cookieHeader);
}

export function isPinterestHost(host) {
  return [
    "pinterest.com",
    "www.pinterest.com",
    "m.pinterest.com",
    "pin.it",
    "www.pin.it",
  ].includes(host) || host.endsWith(".pinterest.com");
}

function isPinterestShortHost(host) {
  return ["pin.it", "www.pin.it"].includes(host);
}
