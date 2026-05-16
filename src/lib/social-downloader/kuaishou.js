import { URL } from "node:url";

import { AppError, ErrorCode } from "./errors";
import {
  cleanUrl,
  dedupeAssets,
  dig,
  fetchTextResponse,
  fetchWithTimeout,
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
  cookieHeaderFromMap,
  cookieHeaderFromSetCookie,
  createMetrics,
  isRedirectStatus,
  jsonFromAssignment,
  mergeCookieMapFromSetCookie,
  postInfoFromHtmlMeta,
  resolveRedirect,
  safeFilenamePart,
  titleFromBody,
  withCookieHeader,
} from "./shared";

const KUAISHOU_HEADERS = {
  ...PAGE_HEADERS,
  "user-agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  accept:
    "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
  "accept-language": "zh-CN,zh;q=0.9,en;q=0.8",
  Referer: "https://www.kuaishou.com/",
};

const KUAISHOU_MOBILE_HEADERS = {
  ...KUAISHOU_HEADERS,
  "user-agent":
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Mobile/15E148 Safari/604.1",
};

export function normalizeKuaishouUrl(parsed) {
  const parts = parsed.pathname.split("/").filter(Boolean);
  const host = parsed.hostname.toLowerCase();

  if (isKuaishouShortHost(host) && parts[0]) {
    return {
      canonical_url: cleanUrl(parsed),
      shortcode: parts[0],
      kind: "short",
      platform: "kuaishou",
    };
  }

  let photoId = "";

  if (parts[0] === "short-video" && parts[1]) {
    photoId = parts[1];
  } else if (parts[0] === "fw" && parts[1] === "photo" && parts[2]) {
    photoId = parts[2];
  } else if (parts[0] === "photo" && parts[1]) {
    photoId = parts[1];
  }

  if (/^[A-Za-z0-9_-]{6,80}$/.test(photoId)) {
    const canonical = new URL(`https://www.kuaishou.com/short-video/${photoId}`);

    parsed.searchParams.forEach((value, key) => {
      canonical.searchParams.set(key, value);
    });

    return {
      canonical_url: canonical.toString(),
      shortcode: photoId,
      kind: "video",
      platform: "kuaishou",
    };
  }

  throw new AppError(ErrorCode.UNSUPPORTED_URL, "仅支持快手短视频或 v.kuaishou.com 分享短链接。", 400);
}

export async function resolveKuaishouPost(normalized, settings) {
  let active = normalized;
  let shortRedirect = null;

  if (active.kind === "short") {
    shortRedirect = await resolveKuaishouShortRedirect(active.canonical_url, settings);
    const redirected = shortRedirect.finalUrl || await resolveRedirect(active.canonical_url, settings, KUAISHOU_HEADERS);

    if (redirected) {
      active = normalizeKuaishouUrl(new URL(redirected));
    }
  }

  if (active.kind === "short" || !active.shortcode) {
    throw new AppError(ErrorCode.NO_MEDIA_FOUND, "快手短链接没有解析到视频 ID。", 404);
  }

  const pageUrl = active.canonical_url;
  const pageResponse = await fetchTextResponse({
    url: pageUrl,
    headers: withCookieHeader(KUAISHOU_HEADERS, shortRedirect?.cookieHeader),
    label: "Kuaishou",
    timeoutMs: settings.httpTimeoutMs,
  });
  const text = pageResponse.text;
  const apolloState = extractKuaishouApolloState(text);
  const detail = findKuaishouVideoDetail(apolloState, active.shortcode);
  const photo = detail?.photo || findKuaishouPhoto(apolloState, active.shortcode);

  if (!photo) {
    const mobileResult = await resolveKuaishouMobilePost({
      mobileUrl: shortRedirect?.mobileUrl || kuaishouMobileShareUrl(active),
      shortcode: active.shortcode,
      settings,
      cookieHeader: shortRedirect?.cookieHeader || cookieHeaderFromSetCookie(pageResponse.headers),
    });

    if (mobileResult) {
      return mobileResult;
    }

    if (looksLikeKuaishouVerification(text)) {
      throw new AppError(
        ErrorCode.UPSTREAM_BLOCKED,
        "快手触发了安全验证，暂时无法从公开页面解析资源。",
        502,
      );
    }

    const fallbackAssets = kuaishouMetaAssets(text, active.shortcode, pageUrl);

    if (fallbackAssets.length > 0) {
      const metrics = createMetrics("kuaishou_public_best_effort");

      return {
        assets: dedupeAssets(fallbackAssets),
        metrics,
        creator_handle: "",
        post_info: postInfoFromHtmlMeta(text, metrics, ""),
      };
    }

    throw new AppError(ErrorCode.NO_MEDIA_FOUND, "快手页面中没有发现可展示资源。", 404);
  }

  const author = detail?.author && typeof detail.author === "object" ? detail.author : {};
  const handle = author.name || author.id || "unknown";
  const filenameBase = `kuaishou_${safeFilenamePart(handle)}_${active.shortcode}`;
  const mediaHeaders = kuaishouMediaHeaders(pageUrl, shortRedirect?.cookieHeader);
  const assets = kuaishouAssetsFromPhoto(photo, filenameBase, mediaHeaders);

  if (assets.length === 0) {
    assets.push(...kuaishouMetaAssets(text, active.shortcode, pageUrl));
  }

  if (assets.length === 0) {
    throw new AppError(ErrorCode.NO_MEDIA_FOUND, "快手页面中没有发现可展示资源。", 404);
  }

  const metrics = metricsFromKuaishou(photo);

  return {
    assets: dedupeAssets(assets),
    metrics,
    creator_handle: handle,
    post_info: postInfoFromKuaishou(photo, detail, metrics, handle),
  };
}

async function resolveKuaishouShortRedirect(url, settings) {
  const cookieMap = new Map();
  let currentUrl = url;
  let mobileUrl = isKuaishouMobileShareUrl(url) ? url : "";

  try {
    for (let index = 0; index < 6; index += 1) {
      const response = await fetchWithTimeout(
        currentUrl,
        {
          headers: withCookieHeader(KUAISHOU_MOBILE_HEADERS, cookieHeaderFromMap(cookieMap)),
          cache: "no-store",
          redirect: "manual",
        },
        settings.httpTimeoutMs,
      );

      mergeCookieMapFromSetCookie(cookieMap, response.headers);

      const location = response.headers.get("location");

      if (isRedirectStatus(response.status) && location) {
        const nextUrl = new URL(htmlUnescape(location), currentUrl).toString();

        if (!mobileUrl && isKuaishouMobileShareUrl(nextUrl)) {
          mobileUrl = nextUrl;
        }

        currentUrl = nextUrl;
        continue;
      }

      return {
        cookieHeader: cookieHeaderFromMap(cookieMap),
        finalUrl: currentUrl !== url ? currentUrl : "",
        mobileUrl,
      };
    }

    return {
      cookieHeader: cookieHeaderFromMap(cookieMap),
      finalUrl: currentUrl !== url ? currentUrl : "",
      mobileUrl,
    };
  } catch {
    return {
      cookieHeader: cookieHeaderFromMap(cookieMap),
      finalUrl: "",
      mobileUrl,
    };
  }
}

function extractKuaishouApolloState(text) {
  return jsonFromAssignment(text, "window.__APOLLO_STATE__");
}

function extractKuaishouInitState(text) {
  return jsonFromAssignment(text, "window.INIT_STATE");
}

async function resolveKuaishouMobilePost({
  mobileUrl,
  shortcode,
  settings,
  cookieHeader,
}) {
  if (!mobileUrl || !shortcode) {
    return null;
  }

  try {
    const mobileResponse = await fetchTextResponse({
      url: mobileUrl,
      headers: withCookieHeader(KUAISHOU_MOBILE_HEADERS, cookieHeader),
      label: "Kuaishou",
      timeoutMs: settings.httpTimeoutMs,
    });
    const text = mobileResponse.text;
    const initState = extractKuaishouInitState(text);
    const detail = findKuaishouMobileDetail(initState, shortcode);
    const photo = detail?.photo && typeof detail.photo === "object" ? detail.photo : null;

    if (!photo) {
      return null;
    }

    const handle = photo.userName || photo.userEid || photo.userId || "unknown";
    const pageUrl = mobileResponse.response?.url || mobileUrl;
    const filenameBase = `kuaishou_${safeFilenamePart(handle)}_${shortcode}`;
    const mediaHeaders = kuaishouMediaHeaders(pageUrl, cookieHeader);
    const assets = kuaishouAssetsFromPhoto(photo, filenameBase, mediaHeaders);

    if (assets.length === 0) {
      assets.push(...kuaishouMetaAssets(text, shortcode, pageUrl));
    }

    if (assets.length === 0) {
      return null;
    }

    const metrics = metricsFromKuaishou(photo);

    return {
      assets: dedupeAssets(assets),
      metrics,
      creator_handle: handle,
      post_info: postInfoFromKuaishou(photo, detail, metrics, handle),
    };
  } catch {
    return null;
  }
}

function findKuaishouMobileDetail(state, photoId) {
  if (!state || typeof state !== "object") {
    return null;
  }

  let fallback = null;

  const visit = (value, depth = 0) => {
    if (!value || typeof value !== "object" || depth > 8) {
      return null;
    }

    if (Array.isArray(value)) {
      for (const item of value) {
        const found = visit(item, depth + 1);

        if (found) {
          return found;
        }
      }

      return null;
    }

    if (isKuaishouMobileDetailCandidate(value, photoId)) {
      return value;
    }

    if (!fallback && isKuaishouMobileDetailCandidate(value, "")) {
      fallback = value;
    }

    for (const child of Object.values(value)) {
      const found = visit(child, depth + 1);

      if (found) {
        return found;
      }
    }

    return null;
  };

  return visit(state) || fallback;
}

function isKuaishouMobileDetailCandidate(value, photoId) {
  const photo = value?.photo && typeof value.photo === "object" ? value.photo : null;

  return Boolean(photo && isKuaishouPhotoCandidate(photo, photoId));
}

function kuaishouApolloClient(state) {
  const client = state?.defaultClient && typeof state.defaultClient === "object"
    ? state.defaultClient
    : state;

  return client && typeof client === "object" ? client : null;
}

function findKuaishouVideoDetail(state, photoId) {
  const client = kuaishouApolloClient(state);
  const root = client?.ROOT_QUERY && typeof client.ROOT_QUERY === "object" ? client.ROOT_QUERY : null;

  if (!client || !root) {
    return null;
  }

  for (const [key, value] of Object.entries(root)) {
    if (!key.startsWith("visionVideoDetail")) {
      continue;
    }

    const detail = hydrateKuaishouApolloValue(client, value);
    const photo = detail?.photo && typeof detail.photo === "object" ? detail.photo : null;

    if (isKuaishouPhotoCandidate(photo, photoId)) {
      return detail;
    }
  }

  return null;
}

function findKuaishouPhoto(state, photoId) {
  const client = kuaishouApolloClient(state);

  if (!client) {
    return null;
  }

  const exact = client[`VisionVideoDetailPhoto:${photoId}`];

  if (exact) {
    const photo = hydrateKuaishouApolloValue(client, exact);

    if (isKuaishouPhotoCandidate(photo, photoId)) {
      return photo;
    }
  }

  for (const [key, value] of Object.entries(client)) {
    if (!key.startsWith("VisionVideoDetailPhoto:")) {
      continue;
    }

    const photo = hydrateKuaishouApolloValue(client, value);

    if (isKuaishouPhotoCandidate(photo, photoId)) {
      return photo;
    }
  }

  return null;
}

function hydrateKuaishouApolloValue(client, value, seen = new Set(), depth = 0) {
  if (!value || typeof value !== "object" || depth > 20) {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((item) => hydrateKuaishouApolloValue(client, item, seen, depth + 1));
  }

  if (value.type === "json" && Object.hasOwn(value, "json")) {
    return hydrateKuaishouApolloValue(client, value.json, seen, depth + 1);
  }

  if (value.type === "id" && typeof value.id === "string" && client[value.id]) {
    if (seen.has(value.id)) {
      return null;
    }

    seen.add(value.id);
    const hydrated = hydrateKuaishouApolloValue(client, client[value.id], seen, depth + 1);

    seen.delete(value.id);
    return hydrated;
  }

  const output = {};

  for (const [key, child] of Object.entries(value)) {
    output[key] = hydrateKuaishouApolloValue(client, child, seen, depth + 1);
  }

  return output;
}

function isKuaishouPhotoCandidate(value, photoId) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  return Boolean(
    (!photoId || kuaishouPhotoMatches(value, photoId)) &&
    (
      value.photoUrl ||
      value.photoH265Url ||
      value.manifest ||
      value.manifestH265 ||
      value.coverUrl ||
      value.coverUrls ||
      value.webpCoverUrls ||
      value.mainMvUrls ||
      value.videoResource
    ),
  );
}

function kuaishouPhotoMatches(value, photoId) {
  if (!photoId) {
    return true;
  }

  if (value.id === photoId || value.photoId === photoId) {
    return true;
  }

  return objectContainsText(value, photoId);
}

function objectContainsText(value, needle, depth = 0) {
  if (!needle || value == null || depth > 8) {
    return false;
  }

  if (typeof value === "string") {
    return value.includes(needle);
  }

  if (typeof value !== "object") {
    return false;
  }

  if (Array.isArray(value)) {
    return value.some((item) => objectContainsText(item, needle, depth + 1));
  }

  return Object.values(value).some((child) => objectContainsText(child, needle, depth + 1));
}

function kuaishouAssetsFromPhoto(photo, filenameBase, mediaHeaders) {
  const assets = [];
  const videoUrls = kuaishouVideoUrls(photo);
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
  } else {
    const coverUrl =
      firstKuaishouUrl(photo.coverUrl) ||
      firstKuaishouUrl(photo.coverUrls) ||
      firstKuaishouUrl(photo.webpCoverUrls);

    if (!coverUrl) {
      return assets;
    }

    assets.push({
      source_url: coverUrl,
      media_type: "image",
      filename_hint: `${filenameBase}_cover.jpg`,
      request_headers: mediaHeaders,
    });
  }

  return assets;
}

function kuaishouVideoUrls(photo) {
  if (!photo || typeof photo !== "object") {
    return [];
  }

  const candidates = [];

  addKuaishouVideoCandidate(candidates, photo.photoUrl, 1_000);
  addKuaishouVideoCandidate(candidates, photo.photoH265Url, 600);
  collectKuaishouManifestVideos(candidates, photo.manifest, 900);
  collectKuaishouManifestVideos(candidates, photo.manifestH265, 580);
  collectKuaishouVideoValues(candidates, photo.videoResource, 850);
  collectKuaishouVideoValues(candidates, photo.mainMvUrls, 820);

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

function collectKuaishouManifestVideos(candidates, manifest, baseScore) {
  if (!manifest || typeof manifest !== "object") {
    return;
  }

  const adaptationSets = Array.isArray(manifest.adaptationSet) ? manifest.adaptationSet : [];

  for (const adaptationSet of adaptationSets) {
    const representations = Array.isArray(adaptationSet?.representation) ? adaptationSet.representation : [];

    for (const representation of representations) {
      if (!representation || typeof representation !== "object") {
        continue;
      }

      const width = optionalInt(representation.width);
      const height = optionalInt(representation.height);
      const bitrate = firstPresentInt(representation.avgBitrate, representation.maxBitrate) || 0;
      const score = baseScore + (width || 0) * (height || 0) + bitrate;

      addKuaishouVideoCandidate(candidates, representation.url, score, width, height);

      const backupUrls = Array.isArray(representation.backupUrl)
        ? representation.backupUrl
        : Array.isArray(representation.backup_url)
          ? representation.backup_url
          : [];

      backupUrls.forEach((url) => addKuaishouVideoCandidate(candidates, url, score - 1, width, height));
    }
  }
}

function collectKuaishouVideoValues(candidates, value, score, depth = 0) {
  if (!value || depth > 6) {
    return;
  }

  if (typeof value === "string") {
    addKuaishouVideoCandidate(candidates, value, score);
    return;
  }

  if (Array.isArray(value)) {
    value.forEach((item, index) => collectKuaishouVideoValues(candidates, item, score - index, depth + 1));
    return;
  }

  if (typeof value !== "object") {
    return;
  }

  addKuaishouVideoCandidate(candidates, value.url, score, optionalInt(value.width), optionalInt(value.height));
  addKuaishouVideoCandidate(candidates, value.src, score, optionalInt(value.width), optionalInt(value.height));

  const backupUrls = Array.isArray(value.backupUrl)
    ? value.backupUrl
    : Array.isArray(value.backup_url)
      ? value.backup_url
      : [];

  backupUrls.forEach((url, index) =>
    addKuaishouVideoCandidate(candidates, url, score - index - 1, optionalInt(value.width), optionalInt(value.height)),
  );

  for (const key of ["h264", "hevc", "h265", "mp4"]) {
    collectKuaishouVideoValues(candidates, value[key], score - 2, depth + 1);
  }
}

function addKuaishouVideoCandidate(candidates, value, score, width = null, height = null) {
  if (typeof value === "string" && /^https?:\/\//i.test(value)) {
    candidates.push({
      url: htmlUnescape(value),
      width,
      height,
      score,
    });
  }
}

function firstKuaishouUrl(value, depth = 0) {
  if (!value || depth > 6) {
    return "";
  }

  if (typeof value === "string") {
    return /^https?:\/\//i.test(value) ? htmlUnescape(value) : "";
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      const url = firstKuaishouUrl(item, depth + 1);

      if (url) {
        return url;
      }
    }

    return "";
  }

  if (typeof value !== "object") {
    return "";
  }

  return firstKuaishouUrl(value.url, depth + 1) || firstKuaishouUrl(value.src, depth + 1);
}

function kuaishouMetaAssets(text, shortcode, pageUrl) {
  const headers = kuaishouMediaHeaders(pageUrl);
  const assets = [];
  const video = metaContents(text, ["og:video", "og:video:url", "og:video:secure_url"])[0];
  const image = metaContents(text, ["og:image", "og:image:url", "og:image:secure_url"])[0];

  if (video) {
    assets.push({
      source_url: video,
      media_type: "video",
      filename_hint: `kuaishou_${shortcode}.mp4`,
      request_headers: headers,
    });
  } else if (image) {
    assets.push({
      source_url: image,
      media_type: "image",
      filename_hint: `kuaishou_${shortcode}.jpg`,
      request_headers: headers,
    });
  }

  return assets;
}

function looksLikeKuaishouVerification(text) {
  return /Need captcha|ANTICRAWL_COMMON|captcha|滑块验证|安全验证|访问频繁/i.test(text);
}

function postInfoFromKuaishou(photo, detail, metrics, creatorHandle) {
  const author = detail?.author && typeof detail.author === "object" ? detail.author : {};
  const body = pickText(
    photo?.caption,
    photo?.captionText,
    photo?.description,
    photo?.content,
    photo?.workDescription,
  );

  return createPostInfo(
    {
      title: pickSingleLineText(photo?.title, photo?.workTitle, titleFromBody(body)),
      author: pickSingleLineText(author.name, photo?.userName, creatorHandle),
      author_handle: pickSingleLineText(author.id, photo?.userEid, photo?.userId, creatorHandle),
      body,
      tags: normalizeTags(kuaishouTags(photo), body),
      metrics,
      source: metrics?.source || "kuaishou_public_best_effort",
    },
    { metrics, creatorHandle, source: metrics?.source || "kuaishou_public_best_effort" },
  );
}

function kuaishouTags(photo) {
  const values = [];

  for (const key of ["tagList", "tags", "topics"]) {
    if (Array.isArray(photo?.[key])) {
      values.push(...photo[key]);
    }
  }

  return values;
}

function metricsFromKuaishou(photo) {
  return {
    like_count: firstPresentInt(optionalInt(photo?.realLikeCount), parseKuaishouCount(photo?.likeCount)),
    comment_count: parseKuaishouCount(photo?.commentCount),
    view_count: parseKuaishouCount(photo?.viewCount),
    save_count: null,
    share_count: parseKuaishouCount(photo?.shareCount),
    source: "kuaishou_public_best_effort",
  };
}

function parseKuaishouCount(value) {
  if (value == null || value === "" || typeof value === "boolean") {
    return null;
  }

  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.trunc(value);
  }

  const text = String(value).trim().replaceAll(",", "");

  if (!text || ["喜欢", "播放", "评论", "分享"].includes(text)) {
    return null;
  }

  const match = /^(\d+(?:\.\d+)?)(亿|万|w|k|千)?$/i.exec(text);

  if (!match) {
    return optionalInt(text);
  }

  const number = Number.parseFloat(match[1]);
  const unit = match[2]?.toLowerCase();
  const multiplier = unit === "亿" ? 100_000_000 : unit === "万" || unit === "w" ? 10_000 : unit === "k" || unit === "千" ? 1_000 : 1;

  return Number.isFinite(number) ? Math.round(number * multiplier) : null;
}

function kuaishouMediaHeaders(pageUrl, cookieHeader = "") {
  return withCookieHeader({
    Referer: pageUrl,
    Origin: "https://www.kuaishou.com",
    "user-agent": KUAISHOU_HEADERS["user-agent"],
    accept: "image/avif,image/webp,image/apng,image/*,video/*,*/*;q=0.8",
    "accept-language": KUAISHOU_HEADERS["accept-language"],
  }, cookieHeader);
}

export function isKuaishouHost(host) {
  return [
    "kuaishou.com",
    "www.kuaishou.com",
    "m.kuaishou.com",
    "v.kuaishou.com",
    "chenzhongtech.com",
    "www.chenzhongtech.com",
    "m.chenzhongtech.com",
    "v.m.chenzhongtech.com",
    "gifshow.com",
    "www.gifshow.com",
    "m.gifshow.com",
  ].includes(host) || host.endsWith(".kuaishou.com") || host.endsWith(".chenzhongtech.com") || host.endsWith(".gifshow.com");
}

function isKuaishouShortHost(host) {
  return ["v.kuaishou.com"].includes(host);
}

function isKuaishouMobileShareUrl(value) {
  try {
    const parsed = new URL(value);
    const host = parsed.hostname.toLowerCase();
    const parts = parsed.pathname.split("/").filter(Boolean);

    return (
      (host.endsWith(".chenzhongtech.com") || host === "chenzhongtech.com" || host.endsWith(".kuaishou.com")) &&
      parts[0] === "fw" &&
      parts[1] === "photo" &&
      Boolean(parts[2])
    );
  } catch {
    return false;
  }
}

function kuaishouMobileShareUrl(normalized) {
  if (!normalized?.shortcode) {
    return "";
  }

  const mobileUrl = new URL(`https://v.m.chenzhongtech.com/fw/photo/${normalized.shortcode}`);

  mobileUrl.searchParams.set("photoId", normalized.shortcode);
  mobileUrl.searchParams.set("kpn", "KUAISHOU");
  mobileUrl.searchParams.set("subBiz", "BROWSE_SLIDE_PHOTO");

  return mobileUrl.toString();
}
