import { URL, URLSearchParams } from "node:url";

import { AppError, ErrorCode } from "./errors";
import {
  decodeJsonString,
  dig,
  escapeRegExp,
  extractEmbeddedJsonObjects,
  fetchText,
  fetchWithTimeout,
  firstPresentInt,
  htmlUnescape,
  metaContents,
  optionalInt,
  PAGE_HEADERS,
  randomAlpha,
  randomToken,
  responseJson,
  scriptTexts,
} from "./utils";

const SUPPORTED_KINDS = new Set(["p", "reel", "reels", "tv"]);
const INSTAGRAM_HOSTS = new Set([
  "instagram.com",
  "www.instagram.com",
  "m.instagram.com",
  "ddinstagram.com",
  "d.ddinstagram.com",
  "g.ddinstagram.com",
]);
const SHORTCODE_RE = /^[A-Za-z0-9_-]{4,64}$/;
const WEB_APP_ID = "936619743392459";
const GQL_DOC_ID = "8845758582119845";

const COMMON_PAGE_HEADERS = {
  ...PAGE_HEADERS,
  accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "cache-control": "no-cache",
};

const MOBILE_HEADERS = {
  "x-ig-app-locale": "en_US",
  "x-ig-device-locale": "en_US",
  "x-ig-mapped-locale": "en_US",
  "user-agent":
    "Instagram 275.0.0.27.98 Android (33/13; 280dpi; 720x1423; Xiaomi; Redmi 7; onclite; qcom; en_US; 458229237)",
  "accept-language": "en-US",
  "x-fb-http-engine": "Liger",
  "x-fb-client-ip": "True",
  "x-fb-server-cluster": "True",
  "content-length": "0",
};

const EMBED_HEADERS = {
  accept:
    "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
  "accept-language": "en-GB,en;q=0.9",
  "cache-control": "max-age=0",
  dnt: "1",
  priority: "u=0, i",
  "sec-ch-ua": '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
  "sec-ch-ua-mobile": "?0",
  "sec-ch-ua-platform": "macOS",
  "sec-fetch-dest": "document",
  "sec-fetch-mode": "navigate",
  "sec-fetch-site": "none",
  "sec-fetch-user": "?1",
  "upgrade-insecure-requests": "1",
  "user-agent": PAGE_HEADERS["user-agent"],
};

const MEDIA_KEY_HINTS = {
  video_url: "video",
  playable_url: "video",
  playable_url_quality_hd: "video",
  contentUrl: "unknown",
  display_url: "image",
  thumbnail_src: "image",
  thumbnail_url: "image",
  thumbnailUrl: "image",
};

const LIKE_COUNT_KEYS = ["like_count", "likeCount"];
const COMMENT_COUNT_KEYS = ["comment_count", "comments_count", "commentCount", "commentsCount"];
const VIEW_COUNT_KEYS = [
  "view_count",
  "views",
  "play_count",
  "plays",
  "video_view_count",
  "video_play_count",
  "ig_play_count",
  "viewCount",
  "playCount",
];
const SAVE_COUNT_KEYS = ["save_count", "saved_count", "saves", "saved", "saveCount"];
const SHARE_COUNT_KEYS = [
  "share_count",
  "shares_count",
  "reshare_count",
  "repost_count",
  "shareCount",
  "sharesCount",
  "reshareCount",
  "repostCount",
];

export function normalizeInstagramUrl(rawUrl) {
  let value = String(rawUrl ?? "").trim();

  if (!value) {
    throw new AppError(ErrorCode.UNSUPPORTED_URL, "请输入 Instagram 帖子链接。", 400);
  }

  if (!value.includes("://")) {
    value = `https://${value}`;
  }

  let parsed;

  try {
    parsed = new URL(value);
  } catch {
    throw new AppError(ErrorCode.UNSUPPORTED_URL, "仅支持 instagram.com 的公开帖子、Reel 或 TV 链接。", 400);
  }

  const host = parsed.hostname.toLowerCase();

  if (!["http:", "https:"].includes(parsed.protocol) || !INSTAGRAM_HOSTS.has(host)) {
    throw new AppError(ErrorCode.UNSUPPORTED_URL, "仅支持 instagram.com 的公开帖子、Reel 或 TV 链接。", 400);
  }

  const [kind, shortcode] = extractKindAndShortcode(parsed.pathname.split("/").filter(Boolean));

  return {
    canonical_url: `https://www.instagram.com/${kind}/${shortcode}/`,
    shortcode,
    kind,
  };
}

export async function resolveInstagramPost(normalized, settings) {
  await ensureInstagramNetwork(settings);

  for (const resolver of [
    resolveFromMobileApi,
    resolveFromEmbedContext,
    resolveFromWebGraphql,
  ]) {
    const post = await resolver(normalized.shortcode, settings);

    if (post.assets.length > 0) {
      return post;
    }
  }

  const html = await fetchPublicPage(normalized.canonical_url, settings);

  return {
    assets: parseAssetsFromHtml(html),
    metrics: parseMetricsFromHtml(html),
    creator_handle: parseCreatorFromHtml(html),
  };
}

async function ensureInstagramNetwork(settings) {
  try {
    await fetchWithTimeout(
      "https://www.instagram.com/",
      {
        method: "HEAD",
        cache: "no-store",
        headers: PAGE_HEADERS,
      },
      Math.min(settings.httpTimeoutMs, 5000),
    );
  } catch (error) {
    if (error?.name === "AbortError") {
      throw new AppError(
        ErrorCode.UPSTREAM_BLOCKED,
        "无法访问 Instagram 页面（连接超时）。请确认服务器网络或系统代理可访问 Instagram，或配置 SOCIAL_PROXY_URL。",
        502,
      );
    }

    const code = error?.cause && typeof error.cause === "object" && "code" in error.cause
      ? String(error.cause.code)
      : "";
    const detail = code === "ENOTFOUND" ? "DNS 解析失败" : "网络连接失败";

    throw new AppError(
      ErrorCode.UPSTREAM_BLOCKED,
      `无法访问 Instagram 页面（${detail}）。请确认服务器网络或系统代理可访问 Instagram，或配置 SOCIAL_PROXY_URL。`,
      502,
      {
        cause: code || (error instanceof Error ? error.message : "fetch failed"),
      },
    );
  }
}

export async function fetchPublicPage(canonicalUrl, settings) {
  const html = await fetchText({
    url: canonicalUrl,
    headers: COMMON_PAGE_HEADERS,
    label: "Instagram",
    timeoutMs: settings.httpTimeoutMs,
  });

  if (!html.trim()) {
    throw new AppError(ErrorCode.NO_MEDIA_FOUND, "Instagram 返回了空页面。", 404);
  }

  if (looksLikeLoginRequired(html)) {
    throw new AppError(ErrorCode.LOGIN_REQUIRED, "这个页面需要登录或无法公开读取。", 403);
  }

  if (looksLikeRateLimitOrChallenge(html)) {
    throw new AppError(ErrorCode.UPSTREAM_BLOCKED, "Instagram 返回了限流或挑战页面。", 429);
  }

  return html;
}

export function parseAssetsFromInstagramData(data) {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return [];
  }

  const assets = [];

  if ("gql_data" in data) {
    extractOldPostAssets(data, assets);
  } else {
    extractMobilePostAssets(data, assets);
  }

  return dedupeInstagramAssets(assets);
}

export function parseMetricsFromInstagramData(data) {
  const metrics = createMetrics();

  extractMetricsFromJson(data, metrics);

  return metrics;
}

export function parseMetricsFromHtml(html) {
  const metrics = createMetrics();

  for (const text of scriptTexts(html, { type: "application/ld+json" })) {
    for (const data of loadsJsonVariants(text)) {
      extractMetricsFromJson(data, metrics);
    }
  }

  for (const text of scriptTexts(html)) {
    if (!text) {
      continue;
    }

    extractRegexMetrics(text, metrics);

    for (const data of extractEmbeddedJsonObjects(text, [
      "window._sharedData",
      "__additionalDataLoaded",
      "__bbox",
      "edge_sidecar_to_children",
    ])) {
      extractMetricsFromJson(data, metrics);
    }
  }

  for (const text of metaContents(html, ["og:description", "twitter:description", "description"])) {
    extractTextMetrics(text, metrics);
  }

  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1];

  if (title) {
    extractTextMetrics(htmlUnescape(title), metrics);
  }

  return metrics;
}

export function parseAssetsFromHtml(html) {
  const candidates = new Map();

  for (const text of scriptTexts(html, { type: "application/ld+json" })) {
    for (const data of loadsJsonVariants(text)) {
      extractFromJson(data, candidates);
    }
  }

  for (const text of scriptTexts(html)) {
    if (!text) {
      continue;
    }

    extractRegexKeyedUrls(text, candidates);

    for (const data of extractEmbeddedJsonObjects(text, [
      "window._sharedData",
      "__additionalDataLoaded",
      "__bbox",
      "edge_sidecar_to_children",
    ])) {
      extractFromJson(data, candidates);
    }
  }

  for (const url of metaContents(html, ["og:video", "og:video:url", "og:video:secure_url", "twitter:player:stream"])) {
    addCandidate(candidates, url, "video");
  }

  if (candidates.size === 0) {
    for (const url of metaContents(html, ["og:image", "og:image:secure_url", "twitter:image"])) {
      addCandidate(candidates, url, "image");
    }
  }

  return [...candidates.values()].sort((a, b) => {
    if (a.media_type === b.media_type) {
      return 0;
    }

    return a.media_type === "video" ? -1 : 1;
  });
}

function extractKindAndShortcode(parts) {
  let kind = "";
  let shortcode = "";

  if (parts.length >= 2 && SUPPORTED_KINDS.has(parts[0])) {
    [kind, shortcode] = parts;
  } else if (parts.length >= 3 && SUPPORTED_KINDS.has(parts[1])) {
    kind = parts[1];
    shortcode = parts[2];
  } else {
    throw new AppError(ErrorCode.UNSUPPORTED_URL, "仅支持帖子、Reel 或 TV 链接。", 400);
  }

  kind = kind === "reels" ? "reel" : kind;

  if (!SHORTCODE_RE.test(shortcode)) {
    throw new AppError(ErrorCode.UNSUPPORTED_URL, "链接中的 shortcode 无效。", 400);
  }

  return [kind, shortcode];
}

async function resolveFromMobileApi(shortcode, settings) {
  const mediaId = await getMediaId(shortcode, settings);

  if (!mediaId) {
    return { assets: [], metrics: createMetrics(), creator_handle: "" };
  }

  const data = await requestMobileMediaInfo(mediaId, settings);

  return {
    assets: parseAssetsFromInstagramData(data),
    metrics: parseMetricsFromInstagramData(data),
    creator_handle: parseCreatorFromInstagramData(data),
  };
}

async function getMediaId(shortcode, settings) {
  try {
    const url = new URL("https://i.instagram.com/api/v1/oembed/");

    url.searchParams.set("url", `https://www.instagram.com/p/${shortcode}/`);

    const response = await fetchWithTimeout(
      url,
      { headers: MOBILE_HEADERS, cache: "no-store" },
      settings.httpTimeoutMs,
    );
    const data = await responseJson(response);
    const mediaId = data && typeof data === "object" ? data.media_id : "";

    return mediaId ? String(mediaId) : "";
  } catch {
    return "";
  }
}

async function requestMobileMediaInfo(mediaId, settings) {
  try {
    const response = await fetchWithTimeout(
      `https://i.instagram.com/api/v1/media/${encodeURIComponent(mediaId)}/info/`,
      { headers: MOBILE_HEADERS, cache: "no-store" },
      settings.httpTimeoutMs,
    );
    const data = await responseJson(response);
    const items = Array.isArray(data?.items) ? data.items : [];

    return items[0] && typeof items[0] === "object" ? items[0] : null;
  } catch {
    return null;
  }
}

async function resolveFromEmbedContext(shortcode, settings) {
  try {
    const response = await fetchWithTimeout(
      `https://www.instagram.com/p/${encodeURIComponent(shortcode)}/embed/captioned/`,
      { headers: EMBED_HEADERS, cache: "no-store" },
      settings.httpTimeoutMs,
    );

    if (response.status >= 400) {
      return { assets: [], metrics: createMetrics(), creator_handle: "" };
    }

    const text = await response.text();
    const match = /"init",\[\],\[(.*?)\]\],/s.exec(text);

    if (!match) {
      return { assets: [], metrics: createMetrics(), creator_handle: "" };
    }

    const payload = JSON.parse(match[1]);
    const contextJson = payload && typeof payload === "object" ? payload.contextJSON : "";
    const data = typeof contextJson === "string" ? JSON.parse(contextJson) : null;

    return {
      assets: parseAssetsFromInstagramData(data),
      metrics: parseMetricsFromInstagramData(data),
      creator_handle: parseCreatorFromInstagramData(data),
    };
  } catch {
    return { assets: [], metrics: createMetrics(), creator_handle: "" };
  }
}

async function resolveFromWebGraphql(shortcode, settings) {
  const params = await getGraphqlParams(shortcode, settings);

  if (!params) {
    return { assets: [], metrics: createMetrics(), creator_handle: "" };
  }

  const { headers, body } = params;
  const requestBody = new URLSearchParams({
    ...body,
    fb_api_caller_class: "RelayModern",
    fb_api_req_friendly_name: "PolarisPostActionLoadPostQueryQuery",
    variables: JSON.stringify({
      shortcode,
      fetch_tagged_user_count: null,
      hoisted_comment_id: null,
      hoisted_reply_id: null,
    }),
    server_timestamps: "true",
    doc_id: GQL_DOC_ID,
  });

  try {
    const response = await fetchWithTimeout(
      "https://www.instagram.com/graphql/query",
      {
        method: "POST",
        cache: "no-store",
        headers: {
          ...EMBED_HEADERS,
          ...headers,
          "content-type": "application/x-www-form-urlencoded",
          "x-fb-friendly-name": "PolarisPostActionLoadPostQueryQuery",
        },
        body: requestBody,
      },
      settings.httpTimeoutMs,
    );
    const data = await responseJson(response);
    const gqlData = data && typeof data === "object" ? data.data : null;
    const wrapped = { gql_data: gqlData };

    return {
      assets: parseAssetsFromInstagramData(wrapped),
      metrics: parseMetricsFromInstagramData(wrapped),
      creator_handle: parseCreatorFromInstagramData(wrapped),
    };
  } catch {
    return { assets: [], metrics: createMetrics(), creator_handle: "" };
  }
}

export function parseCreatorFromInstagramData(data) {
  const directMatches = [
    dig(data, "user", "username"),
    dig(data, "owner", "username"),
    dig(data, "author", "username"),
    dig(data, "gql_data", "shortcode_media", "owner", "username"),
    dig(data, "gql_data", "xdt_shortcode_media", "owner", "username"),
  ];

  for (const candidate of directMatches) {
    const normalized = normalizeCreatorHandle(candidate);

    if (normalized) {
      return normalized;
    }
  }

  return findCreatorHandle(data);
}

export function parseCreatorFromHtml(html) {
  for (const text of scriptTexts(html, { type: "application/ld+json" })) {
    for (const data of loadsJsonVariants(text)) {
      const creatorHandle = parseCreatorFromInstagramData(data);

      if (creatorHandle) {
        return creatorHandle;
      }
    }
  }

  for (const text of scriptTexts(html)) {
    if (!text) {
      continue;
    }

    for (const data of extractEmbeddedJsonObjects(text, [
      "window._sharedData",
      "__additionalDataLoaded",
      "__bbox",
      "edge_sidecar_to_children",
    ])) {
      const creatorHandle = parseCreatorFromInstagramData(data);

      if (creatorHandle) {
        return creatorHandle;
      }
    }
  }

  for (const text of metaContents(html, ["og:title", "og:description", "twitter:title", "title"])) {
    const creatorHandle = creatorHandleFromText(text);

    if (creatorHandle) {
      return creatorHandle;
    }
  }

  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1];

  return creatorHandleFromText(title ? htmlUnescape(title) : "");
}

function findCreatorHandle(data, depth = 0) {
  if (depth > 6 || !data || typeof data !== "object") {
    return "";
  }

  if (Array.isArray(data)) {
    for (const item of data) {
      const nested = findCreatorHandle(item, depth + 1);

      if (nested) {
        return nested;
      }
    }

    return "";
  }

  const direct = normalizeCreatorHandle(data.username);

  if (direct && (
    "profile_pic_url" in data ||
    "is_private" in data ||
    "is_verified" in data ||
    "full_name" in data ||
    "edge_owner_to_timeline_media" in data
  )) {
    return direct;
  }

  for (const key of ["owner", "user", "author", "creator"]) {
    const nested = findCreatorHandle(data[key], depth + 1);

    if (nested) {
      return nested;
    }
  }

  for (const value of Object.values(data)) {
    const nested = findCreatorHandle(value, depth + 1);

    if (nested) {
      return nested;
    }
  }

  return "";
}

function creatorHandleFromText(text) {
  if (!text) {
    return "";
  }

  for (const pattern of [
    /@([A-Za-z0-9._]{2,30})/,
    /\b([A-Za-z0-9._]{2,30})\s+on Instagram\b/i,
  ]) {
    const match = pattern.exec(String(text));

    if (match) {
      const normalized = normalizeCreatorHandle(match[1]);

      if (normalized) {
        return normalized;
      }
    }
  }

  return "";
}

function normalizeCreatorHandle(value) {
  if (typeof value !== "string") {
    return "";
  }

  const normalized = value.trim().replace(/^@+/, "");

  return /^[A-Za-z0-9._]{2,30}$/.test(normalized) ? normalized : "";
}


async function getGraphqlParams(shortcode, settings) {
  try {
    const response = await fetchWithTimeout(
      `https://www.instagram.com/p/${encodeURIComponent(shortcode)}/`,
      { headers: EMBED_HEADERS, cache: "no-store" },
      settings.httpTimeoutMs,
    );

    if (response.status >= 400) {
      return null;
    }

    const html = await response.text();
    const siteData = objectFromEntries("SiteData", html) ?? {};
    const polarisSiteData = objectFromEntries("PolarisSiteData", html) ?? {};
    const webConfig = objectFromEntries("DGWWebConfig", html) ?? {};
    const pushInfo = objectFromEntries("InstagramWebPushInfo", html) ?? {};
    const lsd = objectFromEntries("LSD", html)?.token || randomToken(8);
    const csrf = objectFromEntries("InstagramSecurityConfig", html)?.csrf_token;
    const bloks = objectFromEntries("WebBloksVersioningID", html)?.versioningID;
    const anonCookie = [
      csrf ? `csrftoken=${csrf}` : "",
      polarisSiteData.device_id ? `ig_did=${polarisSiteData.device_id}` : "",
      "wd=1280x720",
      "dpr=2",
      polarisSiteData.machine_id ? `mid=${polarisSiteData.machine_id}` : "",
      "ig_nrcb=1",
    ]
      .filter(Boolean)
      .join("; ");
    const headers = {
      "x-ig-app-id": String(webConfig.appId || WEB_APP_ID),
      "x-fb-lsd": String(lsd),
      "x-asbd-id": "129477",
    };

    if (csrf) {
      headers["x-csrftoken"] = String(csrf);
    }

    if (bloks) {
      headers["x-bloks-version-id"] = String(bloks);
    }

    if (anonCookie) {
      headers.cookie = anonCookie;
    }

    return {
      headers,
      body: {
        __d: "www",
        __a: "1",
        __s: `::${randomAlpha(6)}`,
        __hs: String(siteData.haste_session || "20126.HYP:instagram_web_pkg.2.1...0"),
        __req: "b",
        __ccg: "EXCELLENT",
        __rev: String(pushInfo.rollout_hash || "1019933358"),
        __hsi: String(siteData.hsi || "7436540909012459023"),
        __dyn: randomToken(154),
        __csr: randomToken(154),
        __user: "0",
        __comet_req: String(numberFromQuery("__comet_req", html) || "7"),
        av: "0",
        dpr: "2",
        lsd: String(lsd),
        jazoest: String(numberFromQuery("jazoest", html) || Math.floor(Math.random() * 9000) + 1000),
        __spin_r: String(siteData.__spin_r || "1019933358"),
        __spin_b: String(siteData.__spin_b || "trunk"),
        __spin_t: String(siteData.__spin_t || "1710000000"),
      },
    };
  } catch {
    return null;
  }
}

function extractMobilePostAssets(data, assets) {
  const carousel = Array.isArray(data?.carousel_media) ? data.carousel_media : null;

  if (carousel) {
    for (const item of carousel) {
      if (item && typeof item === "object") {
        appendMobileItem(item, assets);
      }
    }

    return;
  }

  if (data && typeof data === "object") {
    appendMobileItem(data, assets);
  }
}

function appendMobileItem(item, assets) {
  const videoVersions = Array.isArray(item.video_versions) ? item.video_versions : [];

  if (videoVersions.length > 0) {
    const video = bestMediaVersion(videoVersions);

    if (video?.url) {
      const parsed = parsedAssetFromUrl(video.url, "video", video.width, video.height);

      if (parsed) {
        assets.push(parsed);
        return;
      }
    }
  }

  const image = bestImageCandidate(item.image_versions2);

  if (image?.url) {
    const parsed = parsedAssetFromUrl(image.url, "image", image.width, image.height);

    if (parsed) {
      assets.push(parsed);
    }
  }
}

function extractOldPostAssets(data, assets) {
  const gqlData = data.gql_data;

  if (!gqlData || typeof gqlData !== "object") {
    return;
  }

  const shortcodeMedia = gqlData.shortcode_media || gqlData.xdt_shortcode_media;

  if (!shortcodeMedia || typeof shortcodeMedia !== "object") {
    return;
  }

  const edges = Array.isArray(shortcodeMedia.edge_sidecar_to_children?.edges)
    ? shortcodeMedia.edge_sidecar_to_children.edges
    : null;

  if (edges) {
    for (const edge of edges) {
      const node = edge && typeof edge === "object" ? edge.node : null;

      if (node && typeof node === "object") {
        appendOldNode(node, assets);
      }
    }

    return;
  }

  appendOldNode(shortcodeMedia, assets);
}

function appendOldNode(node, assets) {
  const [width, height] = dimensionsFromDict(node);

  if (node.is_video && node.video_url) {
    const parsed = parsedAssetFromUrl(node.video_url, "video", width, height);

    if (parsed) {
      assets.push(parsed);
      return;
    }
  }

  const displayUrl = node.display_url || bestDisplayResourceUrl(node.display_resources);

  if (displayUrl) {
    const parsed = parsedAssetFromUrl(displayUrl, "image", width, height);

    if (parsed) {
      assets.push(parsed);
    }
  }
}

function bestImageCandidate(imageVersions) {
  const candidates = Array.isArray(imageVersions?.candidates) ? imageVersions.candidates : [];

  return bestMediaVersion(candidates);
}

function bestMediaVersion(versions) {
  const candidates = versions.filter((version) => version && typeof version === "object" && version.url);

  if (candidates.length === 0) {
    return null;
  }

  return candidates.reduce((best, candidate) => {
    const bestPixels = (optionalInt(best.width) ?? 0) * (optionalInt(best.height) ?? 0);
    const candidatePixels = (optionalInt(candidate.width) ?? 0) * (optionalInt(candidate.height) ?? 0);

    return candidatePixels > bestPixels ? candidate : best;
  }, candidates[0]);
}

function bestDisplayResourceUrl(resources) {
  if (!Array.isArray(resources)) {
    return "";
  }

  const best = bestMediaVersion(resources);

  return best?.url ? String(best.url) : "";
}

function parsedAssetFromUrl(rawUrl, mediaType, width = null, height = null) {
  if (typeof rawUrl !== "string") {
    return null;
  }

  const url = cleanMediaUrl(rawUrl);

  if (!url) {
    return null;
  }

  return {
    source_url: url,
    media_type: mediaType,
    width: optionalInt(width),
    height: optionalInt(height),
  };
}

function dedupeInstagramAssets(assets) {
  const deduped = new Map();

  for (const asset of assets) {
    const key = dedupeKey(asset.source_url);
    const existing = deduped.get(key);

    if (existing) {
      if (existing.width == null && asset.width) {
        existing.width = asset.width;
      }

      if (existing.height == null && asset.height) {
        existing.height = asset.height;
      }

      continue;
    }

    deduped.set(key, asset);
  }

  return [...deduped.values()];
}

function extractMetricsFromJson(data, metrics) {
  if (Array.isArray(data)) {
    for (const item of data) {
      extractMetricsFromJson(item, metrics);
    }

    return;
  }

  if (!data || typeof data !== "object") {
    return;
  }

  if (looksLikeMediaData(data)) {
    mergeMetric(metrics, "like_count", firstCount(data, LIKE_COUNT_KEYS));
    mergeMetric(metrics, "comment_count", firstCount(data, COMMENT_COUNT_KEYS));
    mergeMetric(metrics, "view_count", firstCount(data, VIEW_COUNT_KEYS));
    mergeMetric(metrics, "save_count", firstCount(data, SAVE_COUNT_KEYS));
    mergeMetric(metrics, "share_count", firstCount(data, SHARE_COUNT_KEYS));
    mergeMetric(metrics, "like_count", countFromValue(data.edge_media_preview_like));
    mergeMetric(metrics, "like_count", countFromValue(data.edge_liked_by));
    mergeMetric(metrics, "comment_count", countFromValue(data.edge_media_to_comment));
    mergeMetric(metrics, "comment_count", countFromValue(data.edge_media_to_parent_comment));
  }

  for (const value of Object.values(data)) {
    if (value && typeof value === "object") {
      extractMetricsFromJson(value, metrics);
    }
  }
}

function looksLikeMediaData(data) {
  const markers = [
    "shortcode",
    "code",
    "media_type",
    "product_type",
    "is_video",
    "display_url",
    "video_url",
    "image_versions2",
    "video_versions",
    "edge_media_preview_like",
    "edge_media_to_comment",
    "edge_media_to_parent_comment",
  ];

  if (markers.some((key) => key in data)) {
    return true;
  }

  const typeName = data.__typename || data["@type"] || "";

  return /Graph|VideoObject|ImageObject/.test(String(typeName));
}

function firstCount(data, keys) {
  for (const key of keys) {
    const value = countFromValue(data[key]);

    if (value != null) {
      return value;
    }
  }

  return null;
}

function countFromValue(value) {
  if (typeof value === "boolean" || value == null) {
    return null;
  }

  if (Number.isInteger(value)) {
    return value >= 0 ? value : null;
  }

  if (typeof value === "number") {
    return value >= 0 ? Math.trunc(value) : null;
  }

  if (typeof value === "string") {
    return parseCountString(value);
  }

  if (value && typeof value === "object" && !Array.isArray(value)) {
    for (const key of ["count", "total_count", "value"]) {
      const count = countFromValue(value[key]);

      if (count != null) {
        return count;
      }
    }
  }

  return null;
}

function mergeMetric(metrics, name, value) {
  if (value == null) {
    return;
  }

  if (metrics[name] == null || value > metrics[name]) {
    metrics[name] = value;
  }
}

function extractRegexMetrics(text, metrics) {
  const unescaped = htmlUnescape(text);

  for (const [name, keys] of [
    ["like_count", LIKE_COUNT_KEYS],
    ["comment_count", COMMENT_COUNT_KEYS],
    ["view_count", VIEW_COUNT_KEYS],
    ["save_count", SAVE_COUNT_KEYS],
    ["share_count", SHARE_COUNT_KEYS],
  ]) {
    for (const key of keys) {
      const valuePattern = new RegExp(
        `"${escapeRegExp(key)}"\\s*:\\s*("?[0-9][0-9,._]*[kKmMbB]?"?)`,
        "g",
      );
      const objectPattern = new RegExp(
        `"${escapeRegExp(key)}"\\s*:\\s*\\{[^{}]*"count"\\s*:\\s*("?[0-9][0-9,._]*[kKmMbB]?"?)`,
        "gs",
      );

      for (const pattern of [valuePattern, objectPattern]) {
        let match;

        while ((match = pattern.exec(unescaped))) {
          mergeMetric(metrics, name, parseCountString(match[1].replace(/^"|"$/g, "")));
        }
      }
    }
  }
}

function extractTextMetrics(text, metrics) {
  for (const [name, pattern] of [
    ["like_count", /([0-9][0-9,._]*\s*[kKmMbB]?)\s+likes?/i],
    ["comment_count", /([0-9][0-9,._]*\s*[kKmMbB]?)\s+comments?/i],
    ["view_count", /([0-9][0-9,._]*\s*[kKmMbB]?)\s+(?:views?|plays?)/i],
    ["share_count", /([0-9][0-9,._]*\s*[kKmMbB]?)\s+(?:shares?|reposts?|reshares?)/i],
  ]) {
    const match = pattern.exec(text);

    if (match) {
      mergeMetric(metrics, name, parseCountString(match[1]));
    }
  }
}

function parseCountString(value) {
  let normalized = String(value).trim().replace(/^"|"$/g, "").replace(/_/g, "").replace(/,/g, "");

  if (!normalized) {
    return null;
  }

  let multiplier = 1;
  const suffix = normalized.slice(-1).toLowerCase();

  if (["k", "m", "b"].includes(suffix)) {
    normalized = normalized.slice(0, -1).trim();
    multiplier = { k: 1_000, m: 1_000_000, b: 1_000_000_000 }[suffix];
  }

  const number = Number.parseFloat(normalized);

  if (!Number.isFinite(number) || number < 0) {
    return null;
  }

  return Math.trunc(number * multiplier);
}

function extractFromJson(data, candidates) {
  if (Array.isArray(data)) {
    for (const item of data) {
      extractFromJson(item, candidates);
    }

    return;
  }

  if (!data || typeof data !== "object") {
    return;
  }

  const [width, height] = dimensionsFromDict(data);
  const typeText = jsonTypeText(data);

  for (const [key, hint] of Object.entries(MEDIA_KEY_HINTS)) {
    const value = data[key];

    if (!value) {
      continue;
    }

    addValueAsCandidate(candidates, value, hintToMediaType(hint, value, typeText), width, height);
  }

  if ("image_versions2" in data) {
    extractImageVersions(data.image_versions2, candidates, width, height);
  }

  if (["string", "object"].includes(typeof data.image) && data.image) {
    addValueAsCandidate(candidates, data.image, "image", width, height);
  }

  if (["string", "object"].includes(typeof data.video) && data.video) {
    addValueAsCandidate(candidates, data.video, "video", width, height);
  }

  for (const value of Object.values(data)) {
    if (value && typeof value === "object") {
      extractFromJson(value, candidates);
    }
  }
}

function extractImageVersions(data, candidates, width, height) {
  if (Array.isArray(data)) {
    for (const item of data) {
      extractImageVersions(item, candidates, width, height);
    }

    return;
  }

  if (!data || typeof data !== "object") {
    return;
  }

  if (Array.isArray(data.candidates)) {
    for (const item of data.candidates) {
      if (item && typeof item === "object" && item.url) {
        addCandidate(candidates, item.url, "image", item.width || width, item.height || height);
      }
    }
  }

  for (const value of Object.values(data)) {
    extractImageVersions(value, candidates, width, height);
  }
}

function addValueAsCandidate(candidates, value, mediaType, width, height) {
  if (typeof value === "string") {
    addCandidate(candidates, value, mediaType, width, height);
    return;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      addValueAsCandidate(candidates, item, mediaType, width, height);
    }

    return;
  }

  if (value && typeof value === "object") {
    const nestedWidth = value.width || width;
    const nestedHeight = value.height || height;

    for (const key of ["url", "contentUrl", "thumbnailUrl"]) {
      if (value[key]) {
        addCandidate(candidates, value[key], mediaType, nestedWidth, nestedHeight);
      }
    }

    extractFromJson(value, candidates);
  }
}

function extractRegexKeyedUrls(text, candidates) {
  const unescaped = htmlUnescape(text);

  for (const [key, hint] of Object.entries(MEDIA_KEY_HINTS)) {
    const pattern = new RegExp(`"${escapeRegExp(key)}"\\s*:\\s*"((?:\\\\.|[^"\\\\])*)"`, "g");
    let match;

    while ((match = pattern.exec(unescaped))) {
      const decoded = decodeJsonString(match[1]);

      addCandidate(candidates, decoded, hintToMediaType(hint, decoded, ""));
    }
  }
}

function jsonTypeText(data) {
  const value = data["@type"] || data.__typename || data.type || "";

  if (Array.isArray(value)) {
    return value.map((item) => String(item).toLowerCase()).join(" ");
  }

  return String(value).toLowerCase();
}

function hintToMediaType(hint, value, typeText) {
  if (hint === "image" || hint === "video") {
    return hint;
  }

  if (typeText.includes("video")) {
    return "video";
  }

  if (typeText.includes("image")) {
    return "image";
  }

  return typeof value === "string" ? mediaTypeFromUrl(value) : null;
}

function mediaTypeFromUrl(url) {
  try {
    const pathname = new URL(url).pathname.toLowerCase();

    if (/\.(mp4|mov|m4v)$/.test(pathname)) {
      return "video";
    }

    if (/\.(jpe?g|png|webp|gif|heic)$/.test(pathname)) {
      return "image";
    }
  } catch {
    return null;
  }

  return null;
}

function addCandidate(candidates, rawUrl, mediaType, width = null, height = null) {
  if (typeof rawUrl !== "string") {
    return;
  }

  const url = cleanMediaUrl(rawUrl);

  if (!url) {
    return;
  }

  const resolvedType = mediaType || mediaTypeFromUrl(url);

  if (!["image", "video"].includes(resolvedType)) {
    return;
  }

  const key = dedupeKey(url);
  const existing = candidates.get(key);

  if (existing) {
    if (existing.width == null && width) {
      existing.width = optionalInt(width);
    }

    if (existing.height == null && height) {
      existing.height = optionalInt(height);
    }

    return;
  }

  candidates.set(key, {
    source_url: url,
    media_type: resolvedType,
    width: optionalInt(width),
    height: optionalInt(height),
  });
}

function cleanMediaUrl(rawUrl) {
  const value = decodeJsonString(rawUrl).trim();

  if (!value) {
    return "";
  }

  let parsed;

  try {
    parsed = new URL(value);
  } catch {
    return "";
  }

  if (!["http:", "https:"].includes(parsed.protocol) || !parsed.hostname) {
    return "";
  }

  parsed.hash = "";
  parsed.searchParams.delete("dl");

  return parsed.toString();
}

function dedupeKey(url) {
  try {
    const parsed = new URL(url);

    parsed.hash = "";
    return parsed.toString();
  } catch {
    return url;
  }
}

function dimensionsFromDict(data) {
  let width = data?.width;
  let height = data?.height;

  if (data?.dimensions && typeof data.dimensions === "object") {
    width = width || data.dimensions.width;
    height = height || data.dimensions.height;
  }

  return [optionalInt(width), optionalInt(height)];
}

function objectFromEntries(name, data) {
  const match = new RegExp(`\\["${escapeRegExp(name)}",.*?,({.*?}),\\d+\\]`).exec(data);

  if (!match) {
    return null;
  }

  try {
    const value = JSON.parse(match[1]);

    return value && typeof value === "object" && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

function numberFromQuery(name, data) {
  const match = new RegExp(`${escapeRegExp(name)}=(\\d+)`).exec(data);

  return match ? optionalInt(match[1]) : null;
}

function loadsJsonVariants(text) {
  const values = [];
  const trimmed = text.trim();

  if (!trimmed) {
    return values;
  }

  try {
    values.push(JSON.parse(trimmed));
    return values;
  } catch {
    // Try an HTML-unescaped variant below.
  }

  const unescaped = htmlUnescape(trimmed);

  if (unescaped !== trimmed) {
    try {
      values.push(JSON.parse(unescaped));
    } catch {
      // Ignore malformed public-page script data.
    }
  }

  return values;
}

function looksLikeLoginRequired(html) {
  const lowered = html.toLowerCase();

  return [
    "login_required",
    "you need to log in",
    "please log in to continue",
    "this content isn't available right now",
  ].some((marker) => lowered.includes(marker));
}

function looksLikeRateLimitOrChallenge(html) {
  const lowered = html.toLowerCase();

  return [
    "please wait a few minutes before you try again",
    "challenge_required",
    "checkpoint_required",
    "suspicious automated behavior",
  ].some((marker) => lowered.includes(marker));
}

function createMetrics() {
  return {
    like_count: null,
    comment_count: null,
    view_count: null,
    save_count: null,
    share_count: null,
    source: "public_best_effort",
  };
}
