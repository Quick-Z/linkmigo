import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { URL, URLSearchParams } from "node:url";

import { AppError, ErrorCode } from "./errors";
import {
  decodeJsonString,
  dig,
  escapeRegExp,
  extractEmbeddedJsonObjects,
  fetchWithTimeout,
  firstPresentInt,
  htmlUnescape,
  metaContents,
  optionalInt,
  PAGE_HEADERS,
  randomAlpha,
  randomToken,
  scriptTexts,
  stripJsonPrefix,
} from "./utils";
import {
  cleanDisplayText,
  cleanSingleLineText,
  createPostInfo,
  pickSingleLineText,
  pickText,
  normalizeTags,
} from "./post-info";

const SUPPORTED_KINDS = new Set(["p", "reel", "reels", "tv"]);
const PROFILE_RESERVED_PATHS = new Set([
  "",
  "accounts",
  "about",
  "api",
  "developer",
  "direct",
  "explore",
  "graphql",
  "legal",
  "privacy",
  "reel",
  "reels",
  "stories",
  "tv",
  "web",
]);
const INSTAGRAM_HOSTS = new Set([
  "instagram.com",
  "www.instagram.com",
  "m.instagram.com",
  "ddinstagram.com",
  "d.ddinstagram.com",
  "g.ddinstagram.com",
]);
const SHORTCODE_RE = /^[A-Za-z0-9_-]{4,64}$/;
const SHORTCODE_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const WEB_APP_ID = "936619743392459";
const GQL_DOC_ID = "8845758582119845";
const PROFILE_PAGE_SIZE = 50;
const PROFILE_POST_LIMIT = 500;
const PROFILE_PREFETCH_LIMIT = 60;
const PROFILE_RENDER_SCROLL_ROUNDS = 18;
const PROFILE_RENDER_SCROLL_IDLE_ROUNDS = 3;
const PROFILE_RENDER_SCROLL_WAIT_MS = 1200;

const COMMON_PAGE_HEADERS = {
  "user-agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/148.0.0.0 Safari/537.36",
  "sec-ch-ua": '"Chromium";v="148", "Google Chrome";v="148", "Not/A)Brand";v="99"',
  "sec-ch-ua-mobile": "?0",
  "sec-ch-ua-platform": '"macOS"',
  "upgrade-insecure-requests": "1",
};

const MOBILE_HEADERS = {
  "x-ig-app-id": "567067343352427",
  "x-ig-app-locale": "en_US",
  "x-ig-device-locale": "en_US",
  "x-ig-mapped-locale": "en_US",
  "x-asbd-id": "129477",
  "user-agent":
    "Instagram 275.0.0.27.98 Android (33/13; 280dpi; 720x1423; Xiaomi; Redmi 7; onclite; qcom; en_US; 458229237)",
  "accept-language": "en-US",
  "x-fb-http-engine": "Liger",
  "x-fb-client-ip": "True",
  "x-fb-server-cluster": "True",
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

function instagramRequestHeaders(baseHeaders, settings = {}, options = {}) {
  const headers = { ...baseHeaders };
  const includeCookie = options.includeCookie !== false;

  if (!includeCookie) {
    return headers;
  }

  const cookie = instagramCookieHeader(settings);

  if (cookie) {
    headers.cookie = cookie;

    const csrf = instagramCookieValue(cookie, "csrftoken");

    if (csrf && !headers["x-csrftoken"]) {
      headers["x-csrftoken"] = csrf;
    }
  }

  return headers;
}

function instagramMediaRequestHeaders() {
  return {
    referer: "https://www.instagram.com/",
  };
}

function instagramCookieHeader(settings = {}) {
  const raw = String(
    settings.instagramCookie ||
      process.env.SOCIAL_INSTAGRAM_COOKIE ||
      process.env.IG_COOKIE ||
      process.env.INSTAGRAM_COOKIE ||
      "",
  )
    .trim()
    .replace(/^cookie\s*:\s*/i, "")
    .replace(/^["']|["']$/g, "");

  return raw.includes("=") ? raw.replace(/[\r\n]+/g, " ").trim() : "";
}

function instagramCookieValue(cookieHeader, name) {
  const wanted = String(name || "").toLowerCase();

  for (const part of String(cookieHeader || "").split(";")) {
    const [rawKey, ...rawValue] = part.split("=");
    const key = rawKey?.trim().toLowerCase();

    if (key === wanted) {
      return rawValue.join("=").trim();
    }
  }

  return "";
}

function mergeInstagramCookieHeaders(...headers) {
  const values = new Map();
  const order = [];

  for (const header of headers) {
    for (const part of String(header || "").split(";")) {
      const [rawKey, ...rawValue] = part.split("=");
      const key = rawKey?.trim();
      const value = rawValue.join("=").trim();

      if (!key || !value) {
        continue;
      }

      const normalizedKey = key.toLowerCase();

      if (!values.has(normalizedKey)) {
        order.push(normalizedKey);
      }

      values.set(normalizedKey, { key, value });
    }
  }

  return order
    .map((key) => values.get(key))
    .filter(Boolean)
    .map(({ key, value }) => `${key}=${value}`)
    .join("; ");
}

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
    throw new AppError(ErrorCode.UNSUPPORTED_URL, "请输入 Instagram 主页或帖子链接。", 400);
  }

  if (!value.includes("://")) {
    value = `https://${value}`;
  }

  let parsed;

  try {
    parsed = new URL(value);
  } catch {
    throw new AppError(ErrorCode.UNSUPPORTED_URL, "仅支持 instagram.com 的公开主页、帖子、Reel 或 TV 链接。", 400);
  }

  const host = parsed.hostname.toLowerCase();

  if (!["http:", "https:"].includes(parsed.protocol) || !INSTAGRAM_HOSTS.has(host)) {
    throw new AppError(ErrorCode.UNSUPPORTED_URL, "仅支持 instagram.com 的公开主页、帖子、Reel 或 TV 链接。", 400);
  }

  const pathParts = parsed.pathname.split("/").filter(Boolean);
  const profileHandle = extractInstagramProfileHandle(pathParts);

  if (profileHandle) {
    return {
      canonical_url: `https://www.instagram.com/${profileHandle}/`,
      creator_handle: profileHandle,
      kind: "profile",
      mode: "profile",
    };
  }

  const [kind, shortcode] = extractKindAndShortcode(pathParts);

  return {
    canonical_url: `https://www.instagram.com/${kind}/${shortcode}/`,
    shortcode,
    kind,
    mode: "post",
  };
}

export function isInstagramHost(host) {
  return INSTAGRAM_HOSTS.has(host);
}

export async function resolveInstagramPost(normalized, settings) {
  const attempts = [
    await collectInstagramPostSources(normalized, settings, { includeCookie: false }),
  ];
  let merged = mergeInstagramResolverPosts(attempts.flatMap((attempt) => attempt.posts));

  // Follow cobalt's anonymous-first strategy. A stale login cookie must not
  // poison public endpoints that work without authentication.
  if (merged.assets.length === 0 && instagramCookieHeader(settings)) {
    attempts.push(await collectInstagramPostSources(normalized, settings, { includeCookie: true }));
    merged = mergeInstagramResolverPosts(attempts.flatMap((attempt) => attempt.posts));
  }

  const htmlText = attempts.map((attempt) => attempt.htmlText).filter(Boolean).join("\n");
  merged.assets = upgradeInstagramAssetsFromText(merged.assets, htmlText);
  merged.assets = await upgradeInstagramAssetsFromRenderedPage(merged.assets, normalized.shortcode, settings);

  if (merged.assets.length > 0) {
    return merged;
  }

  const renderedPost = await resolveFromRenderedPage(normalized.shortcode, settings);

  if (renderedPost.assets.length > 0) {
    return mergeInstagramResolverPosts([merged, renderedPost]);
  }

  const htmlError = attempts.map((attempt) => attempt.htmlError).find(Boolean);
  const resolverError = attempts.map((attempt) => attempt.resolverError).find(Boolean);

  if (htmlError) {
    throw htmlError;
  }

  if (resolverError) {
    throw resolverError;
  }

  return merged;
}

async function collectInstagramPostSources(normalized, settings, options = {}) {

  const resolvedPosts = [];
  let resolverError = null;
  let htmlText = "";

  for (const resolver of [
    resolveFromMobileApi,
    resolveFromEmbedContext,
    resolveFromWebGraphql,
  ]) {
    let post;

    try {
      post = await resolver(normalized.shortcode, settings, options);
    } catch (error) {
      if (error instanceof AppError) {
        resolverError ??= error;
        continue;
      }

      throw error;
    }

    if (post.assets.length > 0) {
      resolvedPosts.push(post);
    }
  }

  let htmlError = null;

  try {
    const html = await fetchPublicPage(normalized.canonical_url, settings, options);
    const metrics = parseMetricsFromHtml(html);
    const creatorHandle = parseCreatorFromHtml(html);

    htmlText = html;
    resolvedPosts.push({
      assets: parseAssetsFromHtml(html),
      metrics,
      creator_handle: creatorHandle,
      post_info: parsePostInfoFromHtml(html, {
        metrics,
        creatorHandle,
        shortcode: normalized.shortcode,
      }),
    });
  } catch (error) {
    htmlError = error;
  }

  return {
    posts: resolvedPosts,
    htmlText,
    htmlError,
    resolverError,
  };
}

export async function resolveInstagramProfile(normalized, settings) {
  const fallbackHandle = normalizeCreatorHandle(normalized?.creator_handle);
  const attempts = [
    await collectInstagramProfileSources(normalized, fallbackHandle, settings, {
      includeCookie: false,
    }),
  ];
  let firstAttempt = mergeInstagramProfileAttempts(...attempts);
  const shouldTryCookie = instagramCookieHeader(settings) && (
    firstAttempt.posts.length === 0 || shouldEnhanceInstagramProfileSnapshot(firstAttempt)
  );

  if (shouldTryCookie) {
    attempts.push(await collectInstagramProfileSources(normalized, fallbackHandle, settings, {
      includeCookie: true,
    }));
    firstAttempt = mergeInstagramProfileAttempts(...attempts);
  }

  if (firstAttempt.posts.length > 0 && !shouldEnhanceInstagramProfileSnapshot(firstAttempt)) {
    return firstAttempt;
  }

  const renderedHtml = await fetchRenderedInstagramProfileHtml(
    normalized.canonical_url,
    settings,
    fallbackHandle,
  );

  if (renderedHtml) {
    const renderedAttempt = await resolveInstagramProfileFromHtml(renderedHtml, fallbackHandle, settings, {
      preserveErrors: firstAttempt.profileErrors,
      fallbackUserId: firstAttempt.profile.user_id || "",
      source: "instagram_rendered_profile_scroll",
    });

    if (renderedAttempt.posts.length > 0) {
      return mergeInstagramProfileAttempts(firstAttempt, renderedAttempt);
    }

    const selectedRenderedError = selectInstagramProfileError(renderedAttempt.profileErrors);

    if (!firstAttempt.posts.length && selectedRenderedError) {
      throw selectedRenderedError;
    }
  }

  if (firstAttempt.posts.length > 0) {
    return firstAttempt;
  }

  const selectedError = selectInstagramProfileError(firstAttempt.profileErrors);

  if (selectedError) {
    throw selectedError;
  }

  throw new AppError(ErrorCode.NO_MEDIA_FOUND, "没有在这个 Instagram 主页里发现可下载的帖子。", 404);
}

async function collectInstagramProfileSources(normalized, fallbackHandle, settings, requestOptions = {}) {
  let html = "";
  const profileErrors = [];

  try {
    html = await fetchPublicPage(normalized.canonical_url, settings, requestOptions);
  } catch (error) {
    profileErrors.push(error);
  }

  return await resolveInstagramProfileFromHtml(html, fallbackHandle, settings, {
    preserveErrors: profileErrors,
    requestOptions,
  });
}

async function resolveInstagramProfileFromHtml(html, fallbackHandle, settings, options = {}) {
  const htmlProfile = parseInstagramProfileFromHtml(html, fallbackHandle);
  const username = normalizeCreatorHandle(htmlProfile.username || fallbackHandle);
  let apiUser = null;
  let feedPage = {
    posts: [],
    nextCursor: "",
    moreAvailable: false,
    userId: "",
  };
  const profileErrors = Array.isArray(options.preserveErrors) ? [...options.preserveErrors] : [];

  if (username) {
    try {
      apiUser = await requestInstagramWebProfileInfo(username, settings, options.requestOptions);
    } catch (error) {
      profileErrors.push(error);
      apiUser = null;
    }
  }

  const mergedProfile = mergeInstagramProfile(
    htmlProfile,
    apiUser ? normalizeInstagramProfileUser(apiUser, username) : null,
  );
  const initialPosts = dedupeInstagramProfilePosts([
    ...normalizeInstagramProfilePostsFromHtml(html, username),
    ...normalizeInstagramProfilePostsFromUser(apiUser, username),
    ...extractInstagramProfilePostsFromRenderedHtml(html, username),
  ]);
  let userId = pickSingleLineText(
    apiUser?.id,
    apiUser?.pk,
    htmlProfile.user_id,
    options.fallbackUserId,
  );

  if (!userId && initialPosts.length > 0) {
    try {
      userId = await requestInstagramUserIdFromPostShortcode(
        initialPosts[0].shortcode,
        settings,
        options.requestOptions,
      );
    } catch (error) {
      profileErrors.push(error);
    }
  }

  if (!userId && initialPosts.length > 0) {
    try {
      userId = await requestInstagramUserIdFromProfilePostCandidates(
        initialPosts,
        username,
        settings,
        options.requestOptions,
      );
    } catch (error) {
      profileErrors.push(error);
    }
  }

  if (userId) {
    try {
      feedPage = await requestInstagramProfileFeedPosts(userId, settings, {
        creatorHandle: username || mergedProfile.username,
        initialShortcodes: initialPosts.map((post) => post.shortcode),
        requestOptions: options.requestOptions,
      });
    } catch (error) {
      profileErrors.push(error);
    }
  }

  const posts = dedupeInstagramProfilePosts([...initialPosts, ...feedPage.posts])
    .sort(compareInstagramProfilePosts);

  if (!mergedProfile.username) {
    mergedProfile.username = username || fallbackHandle;
  }

  if (!mergedProfile.post_count && posts.length > 0) {
    mergedProfile.post_count = posts.length;
  }

  return {
    mode: "profile",
    creator_handle: mergedProfile.username,
    profile: mergedProfile,
    posts,
    profile_pagination: {
      source: feedPage.userId && (feedPage.posts.length > 0 || feedPage.nextCursor)
        ? "instagram_mobile_feed"
        : (options.source || "instagram_public_snapshot"),
      user_id: feedPage.userId || userId,
      next_cursor: feedPage.nextCursor,
      has_more: Boolean(feedPage.moreAvailable && feedPage.nextCursor),
    },
    profileErrors,
  };
}

async function requestInstagramUserIdFromPostShortcode(shortcode, settings, requestOptions = {}) {
  const safeShortcode = cleanSingleLineText(shortcode, { maxLength: 80 });

  if (!SHORTCODE_RE.test(safeShortcode)) {
    return "";
  }

  const mediaId = await getMediaId(safeShortcode, settings, requestOptions);

  if (!mediaId) {
    return "";
  }

  const mediaIdUserId = String(mediaId).split("_").at(1);

  if (/^\d{3,}$/.test(mediaIdUserId || "")) {
    return mediaIdUserId;
  }

  const mediaInfo = await requestMobileMediaInfo(mediaId, settings, requestOptions);

  return pickSingleLineText(
    mediaInfo?.user?.pk,
    mediaInfo?.user?.id,
    mediaInfo?.owner?.pk,
    mediaInfo?.owner?.id,
  );
}

async function requestInstagramUserIdFromProfilePostCandidates(
  posts,
  expectedHandle,
  settings,
  requestOptions = {},
) {
  const handle = normalizeCreatorHandle(expectedHandle);
  const knownShortcodes = new Set(
    (Array.isArray(posts) ? posts : [])
      .map((post) => cleanSingleLineText(post?.shortcode, { maxLength: 80 }))
      .filter((shortcode) => SHORTCODE_RE.test(shortcode)),
  );

  for (const userId of instagramUserIdCandidatesFromProfilePosts(posts)) {
    let page = null;

    try {
      page = await requestInstagramProfileFeedPage(userId, settings, "", requestOptions);
    } catch {
      page = null;
    }

    if (!page?.items?.length) {
      continue;
    }

    const matchesHandle = handle && page.items.some((item) =>
      normalizeCreatorHandle(item?.user?.username || item?.owner?.username) === handle,
    );
    const matchesKnownPost = page.items.some((item) =>
      knownShortcodes.has(pickSingleLineText(item?.code, item?.shortcode)),
    );

    if (matchesHandle || matchesKnownPost) {
      return userId;
    }
  }

  return "";
}

function instagramUserIdCandidatesFromProfilePosts(posts) {
  const candidates = [];
  const seen = new Set();

  for (const post of Array.isArray(posts) ? posts : []) {
    for (const url of [post?.preview_url, post?.post_info?.body, post?.post_info?.title]) {
      for (const candidate of instagramUserIdCandidatesFromText(url)) {
        if (seen.has(candidate)) {
          continue;
        }

        seen.add(candidate);
        candidates.push(candidate);
      }
    }
  }

  return candidates.slice(0, 12);
}

function instagramUserIdCandidatesFromText(value) {
  const text = String(value || "");
  const candidates = [];
  const seen = new Set();

  for (const match of text.matchAll(/\/([^/?#]+\.(?:jpe?g|png|webp|heic|mp4|mov|m4v))(?:[?#]|$)/gi)) {
    const filename = match[1] || "";
    const parts = filename.match(/\d{5,}/g) || [];

    for (const candidate of parts.slice(1)) {
      if (!seen.has(candidate)) {
        seen.add(candidate);
        candidates.push(candidate);
      }
    }
  }

  return candidates;
}

function shouldEnhanceInstagramProfileSnapshot(attempt) {
  if (isDisabledValue(process.env.SOCIAL_RENDERED_INSTAGRAM_FALLBACK)) {
    return false;
  }

  const posts = Array.isArray(attempt?.posts) ? attempt.posts : [];
  const pagination = attempt?.profile_pagination || {};

  if (pagination.has_more || pagination.source === "instagram_mobile_feed") {
    return false;
  }

  const knownPostCount = optionalInt(attempt?.profile?.post_count);

  if (knownPostCount !== null) {
    return knownPostCount > posts.length;
  }

  return posts.length < PROFILE_PREFETCH_LIMIT;
}

function mergeInstagramProfileAttempts(baseAttempt, extraAttempt) {
  const basePosts = Array.isArray(baseAttempt?.posts) ? baseAttempt.posts : [];
  const extraPosts = Array.isArray(extraAttempt?.posts) ? extraAttempt.posts : [];
  const posts = dedupeInstagramProfilePosts([...basePosts, ...extraPosts])
    .sort(compareInstagramProfilePosts);
  const extraPagination = extraAttempt?.profile_pagination || {};
  const basePagination = baseAttempt?.profile_pagination || {};
  const profile = mergeInstagramProfile(baseAttempt?.profile, extraAttempt?.profile);
  const profileErrors = [
    ...(Array.isArray(baseAttempt?.profileErrors) ? baseAttempt.profileErrors : []),
    ...(Array.isArray(extraAttempt?.profileErrors) ? extraAttempt.profileErrors : []),
  ];

  return {
    mode: "profile",
    creator_handle: profile.username || baseAttempt?.creator_handle || extraAttempt?.creator_handle || "",
    profile,
    posts,
    profile_pagination: {
      source: extraPagination.source || basePagination.source || "instagram_public_snapshot",
      user_id: extraPagination.user_id || basePagination.user_id || profile.user_id || "",
      next_cursor: extraPagination.next_cursor || basePagination.next_cursor || "",
      has_more: Boolean(
        (extraPagination.has_more && extraPagination.next_cursor) ||
        (basePagination.has_more && basePagination.next_cursor),
      ),
    },
    profileErrors,
  };
}

function selectInstagramProfileError(errors) {
  const appErrors = Array.isArray(errors) ? errors.filter((error) => error instanceof AppError) : [];
  const loginError = appErrors.find((error) => error.code === ErrorCode.LOGIN_REQUIRED);

  if (loginError) {
    return loginError;
  }

  return (
    appErrors.find((error) => error.code === ErrorCode.UPSTREAM_BLOCKED) ||
    appErrors.find((error) => error.code === ErrorCode.NO_MEDIA_FOUND) ||
    null
  );
}

async function ensureInstagramNetwork(settings) {
  try {
    const response = await fetchWithTimeout(
      "https://www.instagram.com/",
      {
        method: "HEAD",
        cache: "no-store",
        headers: instagramRequestHeaders(PAGE_HEADERS, settings),
      },
      Math.min(settings.httpTimeoutMs, 5000),
    );

    if ([401, 403].includes(response.status)) {
      throw new AppError(
        ErrorCode.UPSTREAM_BLOCKED,
        "当前服务器访问 Instagram 被拒绝（HTTP 403）。请确认服务器网络或系统代理可访问 Instagram；如内容需要登录，请配置 SOCIAL_INSTAGRAM_COOKIE 或 IG_COOKIE。",
        403,
        instagramTroubleshootingDetails({ status_code: response.status, stage: "network_probe" }),
      );
    }

    if (response.status === 429) {
      throw new AppError(
        ErrorCode.UPSTREAM_BLOCKED,
        "Instagram 对当前服务器进行了限流，请稍后重试，或更换可用代理。",
        429,
        instagramTroubleshootingDetails({ status_code: response.status, stage: "network_probe" }),
      );
    }
  } catch (error) {
    if (error instanceof AppError) {
      throw error;
    }

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

export async function fetchPublicPage(canonicalUrl, settings, options = {}) {
  let response;

  try {
    response = await fetchWithTimeout(
      canonicalUrl,
      {
        headers: instagramRequestHeaders(COMMON_PAGE_HEADERS, settings, options),
        cache: "no-store",
      },
      settings.httpTimeoutMs,
    );
  } catch (error) {
    if (error?.name === "AbortError") {
      throw new AppError(ErrorCode.UPSTREAM_BLOCKED, "Instagram 页面请求超时。", 504);
    }

    throw new AppError(
      ErrorCode.UPSTREAM_BLOCKED,
      "无法访问 Instagram 页面（网络连接失败）。",
      502,
      {
        cause: error instanceof Error ? error.message : "fetch failed",
      },
    );
  }

  let html = "";

  try {
    html = await response.text();
  } catch {
    html = "";
  }

  if (!html.trim()) {
    if (response.status === 404) {
      throw new AppError(ErrorCode.NO_MEDIA_FOUND, "没有找到这个 Instagram 内容。", 404);
    }

    if ([401, 403].includes(response.status)) {
      throw new AppError(
        ErrorCode.LOGIN_REQUIRED,
        "Instagram 页面需要登录或拒绝了公开访问。",
        403,
        instagramTroubleshootingDetails({
          status_code: response.status,
          final_url: response.url || "",
          stage: "public_page",
        }),
      );
    }

    throw new AppError(ErrorCode.NO_MEDIA_FOUND, "Instagram 返回了空页面。", 404);
  }

  const accessError = instagramAccessError(html);

  if (accessError && !hasPublicMediaData(html)) {
    throw accessError;
  }

  if (looksLikeRateLimitOrChallenge(html) && !hasPublicMediaData(html)) {
    throw new AppError(ErrorCode.UPSTREAM_BLOCKED, "Instagram 返回了限流或挑战页面。", 429);
  }

  if (response.status === 404 && !hasPublicMediaData(html)) {
    throw new AppError(ErrorCode.NO_MEDIA_FOUND, "没有找到这个 Instagram 内容。", 404);
  }

  if (response.status >= 400 && !hasPublicMediaData(html)) {
    const statusError = instagramAccessError(html, response);

    if (statusError) {
      throw statusError;
    }

    throw new AppError(
      ErrorCode.UPSTREAM_BLOCKED,
      `Instagram 返回异常状态码 ${response.status}。`,
      502,
      instagramTroubleshootingDetails({
        status_code: response.status,
        final_url: response.url || "",
        stage: "public_page",
      }),
    );
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

function mergeInstagramResolverPosts(posts) {
  const usablePosts = posts.filter((post) => post && typeof post === "object");
  const metrics = mergeInstagramMetrics(usablePosts);
  const creatorHandle = pickSingleLineText(...usablePosts.map((post) => post.creator_handle));
  const postInfo = bestInstagramPostInfo(usablePosts);

  return {
    assets: dedupeInstagramAssets(usablePosts.flatMap((post) => post.assets || [])),
    metrics,
    creator_handle: creatorHandle,
    post_info: postInfo,
  };
}

function mergeInstagramMetrics(posts) {
  const metrics = createMetrics();

  for (const post of posts) {
    const sourceMetrics = post.metrics && typeof post.metrics === "object" ? post.metrics : {};

    for (const key of ["like_count", "comment_count", "view_count", "save_count", "share_count"]) {
      const value = optionalInt(sourceMetrics[key]);

      if (value != null && (metrics[key] == null || value > metrics[key])) {
        metrics[key] = value;
      }
    }

    if (sourceMetrics.source && metrics.source === "public_best_effort") {
      metrics.source = sourceMetrics.source;
    }
  }

  return metrics;
}

function bestInstagramPostInfo(posts) {
  let best = null;
  let bestScore = -1;

  for (const post of posts) {
    const info = post.post_info && typeof post.post_info === "object" ? post.post_info : null;

    if (!info) {
      continue;
    }

    const score = [
      info.title,
      info.author,
      info.author_handle,
      info.body,
    ].reduce((sum, value) => sum + (value ? String(value).length : 0), 0) +
      (Array.isArray(info.tags) ? info.tags.length * 20 : 0);

    if (score > bestScore) {
      best = info;
      bestScore = score;
    }
  }

  return best;
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
      "image_versions2",
      "carousel_media",
      "xdt_shortcode_media",
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
      "image_versions2",
      "carousel_media",
      "xdt_shortcode_media",
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

function extractInstagramProfileHandle(parts) {
  if (!Array.isArray(parts) || parts.length !== 1) {
    return "";
  }

  const candidate = normalizeCreatorHandle(parts[0]);

  if (!candidate || PROFILE_RESERVED_PATHS.has(candidate.toLowerCase())) {
    return "";
  }

  return candidate;
}

async function requestInstagramWebProfileInfo(username, settings, requestOptions = {}) {
  const urls = [
    new URL("https://www.instagram.com/api/v1/users/web_profile_info/"),
    new URL("https://i.instagram.com/api/v1/users/web_profile_info/"),
  ];
  let firstError = null;

  for (const url of urls) {
    url.searchParams.set("username", username);

    try {
      const response = await fetchWithTimeout(
        url,
        {
          headers: instagramRequestHeaders(
            {
              ...COMMON_PAGE_HEADERS,
              "x-ig-app-id": WEB_APP_ID,
              "x-requested-with": "XMLHttpRequest",
            },
            settings,
            requestOptions,
          ),
          cache: "no-store",
        },
        settings.httpTimeoutMs,
      );
      const data = await instagramResponseJson(response);
      const accessError = instagramAccessError(data, response);

      if (accessError) {
        throw accessError;
      }

      const user = data && typeof data === "object"
        ? (dig(data, "data", "user") || data.user || null)
        : null;

      if (user && typeof user === "object") {
        return user;
      }
    } catch (error) {
      firstError ??= error;
    }
  }

  if (firstError) {
    throw firstError;
  }

  return null;
}

async function requestInstagramProfileFeedPosts(userId, settings, options = {}) {
  const creatorHandle = normalizeCreatorHandle(options.creatorHandle);
  const seen = new Set(
    (Array.isArray(options.initialShortcodes) ? options.initialShortcodes : [])
      .map((value) => String(value || "").trim())
      .filter(Boolean),
  );
  const posts = [];
  let cursor = pickSingleLineText(options.cursor);
  const limit = Math.max(1, Math.min(PROFILE_POST_LIMIT, Number(options.limit) || PROFILE_PREFETCH_LIMIT));
  let moreAvailable = false;

  while (posts.length < limit) {
    const page = await requestInstagramProfileFeedPage(
      userId,
      settings,
      cursor,
      options.requestOptions,
    );

    if (!page || !page.items.length) {
      cursor = "";
      moreAvailable = false;
      break;
    }

    for (const item of page.items) {
      const post = normalizeInstagramProfilePost(item, creatorHandle);

      if (!post || seen.has(post.shortcode)) {
        continue;
      }

      seen.add(post.shortcode);
      posts.push(post);

      if (posts.length >= limit) {
        break;
      }
    }

    if (!page.nextCursor || !page.moreAvailable) {
      cursor = "";
      moreAvailable = false;
      break;
    }

    if (page.nextCursor === cursor) {
      cursor = "";
      moreAvailable = false;
      break;
    }

    cursor = page.nextCursor;
    moreAvailable = true;
  }

  return {
    posts,
    nextCursor: cursor,
    moreAvailable,
    userId,
  };
}

export async function resolveInstagramProfilePostsPage(options = {}, settings = {}) {
  const username = normalizeCreatorHandle(options.username || options.creatorHandle);
  let userId = pickSingleLineText(options.userId);

  if (!userId && username) {
    const apiUser = await requestInstagramWebProfileInfoAnonymousFirst(username, settings);
    userId = pickSingleLineText(apiUser?.id, apiUser?.pk);
  }

  if (!userId) {
    throw new AppError(ErrorCode.NO_MEDIA_FOUND, "暂时无法读取这个 Instagram 主页的下一页帖子。", 404);
  }

  const page = await requestInstagramProfileFeedPostsAnonymousFirst(userId, settings, {
    cursor: options.cursor,
    creatorHandle: username,
    initialShortcodes: options.initialShortcodes,
    limit: options.limit || PROFILE_PAGE_SIZE,
  });

  return {
    posts: page.posts,
    user_id: page.userId,
    next_cursor: page.nextCursor,
    has_more: Boolean(page.moreAvailable && page.nextCursor),
  };
}

async function requestInstagramWebProfileInfoAnonymousFirst(username, settings) {
  let anonymousError = null;

  try {
    const user = await requestInstagramWebProfileInfo(username, settings, { includeCookie: false });

    if (user || !instagramCookieHeader(settings)) {
      return user;
    }
  } catch (error) {
    anonymousError = error;
  }

  if (instagramCookieHeader(settings)) {
    return await requestInstagramWebProfileInfo(username, settings, { includeCookie: true });
  }

  if (anonymousError) {
    throw anonymousError;
  }

  return null;
}

async function requestInstagramProfileFeedPostsAnonymousFirst(userId, settings, options = {}) {
  let anonymousError = null;

  try {
    const page = await requestInstagramProfileFeedPosts(userId, settings, {
      ...options,
      requestOptions: { includeCookie: false },
    });

    if (page.posts.length > 0 || page.nextCursor || !instagramCookieHeader(settings)) {
      return page;
    }
  } catch (error) {
    anonymousError = error;
  }

  if (instagramCookieHeader(settings)) {
    return await requestInstagramProfileFeedPosts(userId, settings, {
      ...options,
      requestOptions: { includeCookie: true },
    });
  }

  if (anonymousError) {
    throw anonymousError;
  }

  return {
    posts: [],
    nextCursor: "",
    moreAvailable: false,
    userId,
  };
}

async function requestInstagramProfileFeedPage(userId, settings, cursor = "", requestOptions = {}) {
  const url = new URL(`https://i.instagram.com/api/v1/feed/user/${encodeURIComponent(userId)}/`);

  url.searchParams.set("count", String(PROFILE_PAGE_SIZE));

  if (cursor) {
    url.searchParams.set("max_id", cursor);
  }

  const response = await fetchWithTimeout(
    url,
    {
      headers: instagramRequestHeaders(MOBILE_HEADERS, settings, requestOptions),
      cache: "no-store",
    },
    settings.httpTimeoutMs,
  );
  const data = await instagramResponseJson(response);
  const accessError = instagramAccessError(data, response);

  if (accessError) {
    throw accessError;
  }

  const items = Array.isArray(data?.items) ? data.items : [];
  const explicitNextCursor = pickSingleLineText(
    data?.next_max_id,
    data?.next_cursor,
    data?.max_id,
  );
  const fallbackNextCursor = pickSingleLineText(
    items.at(-1)?.id,
    items.at(-1)?.pk,
  );
  const nextCursor = explicitNextCursor || fallbackNextCursor;
  const moreAvailable = explicitNextCursor
    ? Boolean(data?.more_available !== false)
    : Boolean(nextCursor && data?.more_available !== false && items.length >= 1);

  return {
    items,
    nextCursor,
    moreAvailable,
  };
}

function parseInstagramProfileFromHtml(html, fallbackHandle = "") {
  const description = pickText(
    metaContents(html, ["og:description", "description"]),
  );
  const textStats = parseInstagramProfileStatsFromText(description);
  const embeddedObjects = instagramEmbeddedObjectsFromHtml(html, [
    "window._sharedData",
    "__additionalDataLoaded",
    "__bbox",
    "edge_owner_to_timeline_media",
    "xdt_api__v1__feed__user_timeline_graphql_connection",
  ]);
  const profileUser =
    embeddedObjects
      .map((value) => findInstagramProfileUser(value))
      .find(Boolean) || null;
  const username = normalizeCreatorHandle(
    pickSingleLineText(
      profileUser?.username,
      fallbackHandle,
      creatorHandleFromText(htmlTitle(html)),
    ),
  );
  const biography = pickText(profileUser?.biography, description);
  const fullName = pickSingleLineText(
    profileUser?.full_name,
    profileUser?.username,
    username,
  );

  return {
    username,
    full_name: fullName,
    biography,
    avatar_url: instagramCommentAvatarUrl(profileUser),
    post_count: firstPresentInt(
      profileUser?.edge_owner_to_timeline_media?.count,
      profileUser?.edge_felix_video_timeline?.count,
      profileUser?.media_count,
      textStats.post_count,
    ),
    follower_count: firstPresentInt(
      profileUser?.edge_followed_by?.count,
      profileUser?.follower_count,
      textStats.follower_count,
    ),
    following_count: firstPresentInt(
      profileUser?.edge_follow?.count,
      profileUser?.following_count,
      textStats.following_count,
    ),
    is_private: Boolean(profileUser?.is_private),
    is_verified: Boolean(profileUser?.is_verified),
    user_id: pickSingleLineText(
      profileUser?.id,
      profileUser?.pk,
      profileUser?.pk_id,
      extractInstagramProfileUserIdFromHtml(html, username),
    ),
  };
}

function extractInstagramProfileUserIdFromHtml(html, username = "") {
  const text = String(html || "");
  const handle = normalizeCreatorHandle(username);
  const patterns = [
    /"profile_id"\s*:\s*"(\d{3,})"/i,
    /"profile_id"\s*:\s*(\d{3,})/i,
    /"user_id"\s*:\s*"(\d{3,})"/i,
    /"user_id"\s*:\s*(\d{3,})/i,
    /"owner"\s*:\s*\{[^{}]*"id"\s*:\s*"(\d{3,})"/i,
    /"owner"\s*:\s*\{[^{}]*"pk"\s*:\s*"(\d{3,})"/i,
    /"target_user_id"\s*:\s*"(\d{3,})"/i,
    /"target_user_id"\s*:\s*(\d{3,})/i,
  ];

  if (handle) {
    patterns.unshift(
      new RegExp(`"username"\\s*:\\s*"${escapeRegExp(handle)}"[\\s\\S]{0,500}?"(?:id|pk|pk_id)"\\s*:\\s*"?([0-9]{3,})"?`, "i"),
      new RegExp(`"(?:id|pk|pk_id)"\\s*:\\s*"?([0-9]{3,})"?[\\s\\S]{0,500}?"username"\\s*:\\s*"${escapeRegExp(handle)}"`, "i"),
    );
  }

  for (const pattern of patterns) {
    const match = pattern.exec(text);

    if (match?.[1]) {
      return match[1];
    }
  }

  return "";
}

function parseInstagramProfileStatsFromText(text) {
  return {
    follower_count: compactCountFromText(text, [
      /([\d,.]+)\s*([KMB万億亿]?)\s*(?:followers?|位粉丝|粉丝)/i,
    ]),
    following_count: compactCountFromText(text, [
      /(?:following|已关注)\s*([\d,.]+)\s*([KMB万億亿]?)/i,
      /([\d,.]+)\s*([KMB万億亿]?)\s*(?:following|人)/i,
    ]),
    post_count: compactCountFromText(text, [
      /([\d,.]+)\s*([KMB万億亿]?)\s*(?:posts?|篇帖子|帖子)/i,
    ]),
  };
}

function compactCountFromText(text, patterns) {
  const source = String(text || "");

  for (const pattern of patterns) {
    const match = pattern.exec(source);

    if (!match) {
      continue;
    }

    const value = Number.parseFloat(String(match[1] || "").replaceAll(",", ""));
    const suffix = String(match[2] || "").toLowerCase();

    if (!Number.isFinite(value)) {
      continue;
    }

    const multiplier = suffix === "k"
      ? 1_000
      : suffix === "m"
        ? 1_000_000
        : suffix === "b"
          ? 1_000_000_000
          : suffix === "万"
            ? 10_000
            : suffix === "億" || suffix === "亿"
              ? 100_000_000
              : 1;

    return Math.round(value * multiplier);
  }

  return null;
}

function normalizeInstagramProfileUser(user, fallbackHandle = "") {
  if (!user || typeof user !== "object") {
    return null;
  }

  return {
    username: normalizeCreatorHandle(user.username || fallbackHandle),
    full_name: cleanSingleLineText(user.full_name, { maxLength: 180 }),
    biography: cleanDisplayText(user.biography, { maxLength: 4000 }),
    avatar_url: instagramCommentAvatarUrl(user),
    post_count: firstPresentInt(
      user.edge_owner_to_timeline_media?.count,
      user.media_count,
    ),
    follower_count: firstPresentInt(
      user.edge_followed_by?.count,
      user.follower_count,
    ),
    following_count: firstPresentInt(
      user.edge_follow?.count,
      user.following_count,
    ),
    is_private: Boolean(user.is_private),
    is_verified: Boolean(user.is_verified),
    user_id: pickSingleLineText(user.id, user.pk, user.pk_id, user.profile_id),
  };
}

function mergeInstagramProfile(...profiles) {
  const merged = {
    username: "",
    full_name: "",
    biography: "",
    avatar_url: "",
    post_count: null,
    follower_count: null,
    following_count: null,
    is_private: false,
    is_verified: false,
    user_id: "",
  };

  for (const profile of profiles) {
    if (!profile || typeof profile !== "object") {
      continue;
    }

    merged.username ||= normalizeCreatorHandle(profile.username);
    merged.full_name ||= cleanSingleLineText(profile.full_name, { maxLength: 180 });
    merged.biography ||= cleanDisplayText(profile.biography, { maxLength: 4000 });
    merged.avatar_url ||= cleanSingleLineText(profile.avatar_url, { maxLength: 4096 });
    merged.post_count ??= optionalInt(profile.post_count);
    merged.follower_count ??= optionalInt(profile.follower_count);
    merged.following_count ??= optionalInt(profile.following_count);
    merged.is_private ||= Boolean(profile.is_private);
    merged.is_verified ||= Boolean(profile.is_verified);
    merged.user_id ||= pickSingleLineText(profile.user_id);
  }

  return merged;
}

function normalizeInstagramProfilePostsFromHtml(html, fallbackHandle = "") {
  return dedupeInstagramProfilePosts(
    instagramEmbeddedObjectsFromHtml(html, [
      "window._sharedData",
      "__additionalDataLoaded",
      "__bbox",
      "edge_owner_to_timeline_media",
      "xdt_api__v1__feed__user_timeline_graphql_connection",
    ]).flatMap((value) => extractInstagramProfilePostsFromData(value, fallbackHandle)),
  );
}

function normalizeInstagramProfilePostsFromUser(user, fallbackHandle = "") {
  return dedupeInstagramProfilePosts(extractInstagramProfilePostsFromData(user, fallbackHandle));
}

function extractInstagramProfilePostsFromData(data, fallbackHandle = "", depth = 0) {
  if (!data || typeof data !== "object" || depth > 8) {
    return [];
  }

  if (Array.isArray(data)) {
    return data.flatMap((item) => extractInstagramProfilePostsFromData(item, fallbackHandle, depth + 1));
  }

  const edges = Array.isArray(data?.edge_owner_to_timeline_media?.edges)
    ? data.edge_owner_to_timeline_media.edges
    : Array.isArray(data?.xdt_api__v1__feed__user_timeline_graphql_connection?.edges)
      ? data.xdt_api__v1__feed__user_timeline_graphql_connection.edges
      : Array.isArray(data?.edges)
        ? data.edges
        : [];
  const posts = [];

  for (const edge of edges) {
    const post = normalizeInstagramProfilePost(edge?.node || edge, fallbackHandle);

    if (post) {
      posts.push(post);
    }
  }

  if (posts.length > 0) {
    return posts;
  }

  const nestedPosts = [];

  for (const value of Object.values(data)) {
    nestedPosts.push(...extractInstagramProfilePostsFromData(value, fallbackHandle, depth + 1));
  }

  return nestedPosts;
}

function normalizeInstagramProfilePost(rawPost, fallbackHandle = "") {
  if (!rawPost || typeof rawPost !== "object") {
    return null;
  }

  const shortcode = cleanSingleLineText(
    rawPost.code || rawPost.shortcode || rawPost.id,
    { maxLength: 80 },
  );

  if (!SHORTCODE_RE.test(shortcode)) {
    return null;
  }

  const creatorHandle = normalizeCreatorHandle(
    pickSingleLineText(
      rawPost.owner?.username,
      rawPost.user?.username,
      rawPost.username,
      fallbackHandle,
    ),
  );
  const metrics = parseMetricsFromInstagramData(rawPost);
  const postInfo = parsePostInfoFromInstagramData(rawPost, { metrics, creatorHandle });
  const kind = instagramProfilePostKind(rawPost);
  const previewUrl = instagramProfilePreviewUrl(rawPost);
  const takenAt = firstPresentInt(rawPost.taken_at_timestamp, rawPost.taken_at);
  const previewWidth = firstPresentInt(
    rawPost.dimensions?.width,
    rawPost.thumbnail_resources?.[0]?.config_width,
    rawPost.display_resources?.[0]?.config_width,
  );
  const previewHeight = firstPresentInt(
    rawPost.dimensions?.height,
    rawPost.thumbnail_resources?.[0]?.config_height,
    rawPost.display_resources?.[0]?.config_height,
  );

  return {
    id: shortcode,
    shortcode,
    canonical_url: `https://www.instagram.com/${kind}/${shortcode}/`,
    kind,
    media_type: instagramProfileMediaType(rawPost),
    preview_url: previewUrl,
    preview_width: previewWidth,
    preview_height: previewHeight,
    taken_at: takenAt ? new Date(takenAt * 1000).toISOString() : "",
    metrics,
    post_info: postInfo,
  };
}

function dedupeInstagramProfilePosts(posts) {
  const deduped = [];
  const byShortcode = new Map();

  for (const post of posts) {
    if (!post || !post.shortcode) {
      continue;
    }

    const existing = byShortcode.get(post.shortcode);

    if (!existing || instagramProfilePostScore(post) > instagramProfilePostScore(existing)) {
      byShortcode.set(post.shortcode, post);
    }
  }

  for (const post of byShortcode.values()) {
    deduped.push(post);
  }

  return deduped;
}

function compareInstagramProfilePosts(left, right) {
  const leftTime = Date.parse(left?.taken_at || "") || 0;
  const rightTime = Date.parse(right?.taken_at || "") || 0;

  if (leftTime !== rightTime) {
    return rightTime - leftTime;
  }

  return String(right?.shortcode || "").localeCompare(String(left?.shortcode || ""));
}

function instagramProfilePostScore(post) {
  return [
    post?.preview_url,
    post?.post_info?.body,
    post?.post_info?.title,
    post?.taken_at,
  ].reduce((sum, value) => sum + (value ? String(value).length : 0), 0);
}

function instagramProfilePostKind(rawPost) {
  const productType = cleanSingleLineText(rawPost?.product_type, { maxLength: 40 }).toLowerCase();

  if (productType === "clips" || productType === "reels") {
    return "reel";
  }

  return "p";
}

function instagramProfileMediaType(rawPost) {
  if (
    Boolean(rawPost?.is_video) ||
    optionalInt(rawPost?.media_type) === 2 ||
    Array.isArray(rawPost?.video_versions)
  ) {
    return "video";
  }

  return "image";
}

function instagramProfilePreviewUrl(rawPost) {
  return pickInstagramUrl(
    rawPost?.display_url,
    rawPost?.thumbnail_src,
    rawPost?.thumbnail_url,
    rawPost?.thumbnail?.src,
    rawPost?.image_versions2?.candidates?.[0]?.url,
    rawPost?.display_resources?.at?.(-1)?.src,
    rawPost?.thumbnail_resources?.at?.(-1)?.src,
    rawPost?.carousel_media?.[0]?.image_versions2?.candidates?.[0]?.url,
    rawPost?.carousel_media?.[0]?.display_url,
    rawPost?.video_versions?.[0]?.url,
  );
}

function pickInstagramUrl(...values) {
  for (const value of values.flat()) {
    const url = cleanSingleLineText(decodeJsonString(value || ""), { maxLength: 4096 });

    if (url) {
      return url;
    }
  }

  return "";
}

function extractInstagramProfilePostsFromRenderedHtml(html, fallbackHandle = "") {
  if (!html) {
    return [];
  }

  const posts = [];
  const seen = new Set();
  const pattern = /<a\b[^>]*href=(["'])(?:https?:\/\/(?:www\.)?instagram\.com)?\/(?:(?!p\/|reel\/)([^"'/?#]+)\/)?(p|reel)\/([A-Za-z0-9_-]{4,64})(?:\/|[?#])?[^"']*\1[^>]*>([\s\S]*?)<\/a>/gi;
  let match;

  while ((match = pattern.exec(html))) {
    const [, , rawHandle, rawKind, shortcode, anchorHtml] = match;
    const creatorHandle = normalizeCreatorHandle(rawHandle || fallbackHandle);

    if (!creatorHandle || seen.has(shortcode)) {
      continue;
    }

    seen.add(shortcode);

    const previewUrl = pickInstagramUrl(
      matchAttribute(anchorHtml, "src"),
      matchAttribute(anchorHtml, "srcset")?.split(",").at(-1)?.trim().split(/\s+/)[0],
    );
    const alt = cleanDisplayText(matchAttribute(anchorHtml, "alt"), { maxLength: 4000 });
    const mediaType = rawKind === "reel" ? "video" : "image";
    const title = alt ? instagramTitleFromCaption(alt) : `Instagram ${rawKind} by ${creatorHandle}`;

    posts.push({
      id: shortcode,
      shortcode,
      canonical_url: `https://www.instagram.com/${rawKind}/${shortcode}/`,
      kind: rawKind,
      media_type: mediaType,
      preview_url: previewUrl,
      preview_width: null,
      preview_height: null,
      taken_at: "",
      metrics: createMetrics(),
      post_info: createPostInfo(
        {
          title,
          author: creatorHandle,
          author_handle: creatorHandle,
          body: alt,
          tags: normalizeTags([], alt),
          metrics: createMetrics(),
          source: "instagram_rendered_profile_html",
        },
        {
          metrics: createMetrics(),
          creatorHandle,
          source: "instagram_rendered_profile_html",
        },
      ),
    });
  }

  return posts;
}

function matchAttribute(html, attributeName) {
  if (!html || !attributeName) {
    return "";
  }

  const escapedName = escapeRegExp(attributeName);
  const match = new RegExp(`${escapedName}="([^"]+)"`, "i").exec(html);

  return match ? htmlUnescape(match[1]) : "";
}

function instagramEmbeddedObjectsFromHtml(html, markers) {
  const values = [];

  for (const text of scriptTexts(html, { type: "application/ld+json" })) {
    values.push(...loadsJsonVariants(text));
  }

  for (const text of scriptTexts(html)) {
    if (!text) {
      continue;
    }

    values.push(...extractEmbeddedJsonObjects(text, markers));
  }

  return values;
}

function findInstagramProfileUser(data, depth = 0) {
  if (!data || typeof data !== "object" || depth > 8) {
    return null;
  }

  if (Array.isArray(data)) {
    for (const item of data) {
      const nested = findInstagramProfileUser(item, depth + 1);

      if (nested) {
        return nested;
      }
    }

    return null;
  }

  const username = normalizeCreatorHandle(data.username);
  const hasProfileShape = username && (
    "edge_owner_to_timeline_media" in data ||
    "edge_followed_by" in data ||
    "edge_follow" in data ||
    "biography" in data ||
    "full_name" in data
  );

  if (hasProfileShape) {
    return data;
  }

  for (const value of Object.values(data)) {
    const nested = findInstagramProfileUser(value, depth + 1);

    if (nested) {
      return nested;
    }
  }

  return null;
}

async function resolveFromMobileApi(shortcode, settings, options = {}) {
  const mediaId = await getMediaId(shortcode, settings, options);

  if (!mediaId) {
    return { assets: [], metrics: createMetrics(), creator_handle: "" };
  }

  const data = await requestMobileMediaInfo(mediaId, settings, options);
  const metrics = parseMetricsFromInstagramData(data);
  const creatorHandle = parseCreatorFromInstagramData(data);

  return {
    assets: parseAssetsFromInstagramData(data),
    metrics,
    creator_handle: creatorHandle,
    post_info: parsePostInfoFromInstagramData(data, { metrics, creatorHandle }),
  };
}

async function getMediaId(shortcode, settings, options = {}) {
  try {
    const url = new URL("https://i.instagram.com/api/v1/oembed/");

    url.searchParams.set("url", `https://www.instagram.com/p/${shortcode}/`);

    const response = await fetchWithTimeout(
      url,
      { headers: instagramRequestHeaders(MOBILE_HEADERS, settings, options), cache: "no-store" },
      settings.httpTimeoutMs,
    );
    const data = await instagramResponseJson(response);
    const accessError = instagramAccessError(data, response);

    if (accessError) {
      throw accessError;
    }

    const mediaId = data && typeof data === "object" ? (data.media_id || data.media_igid) : "";

    if (mediaId) {
      return String(mediaId);
    }
  } catch (error) {
    if (error instanceof AppError) {
      throw error;
    }

    // Fall back to decoding the public shortcode below.
  }

  return mediaIdFromShortcode(shortcode);
}

function mediaIdFromShortcode(shortcode) {
  let mediaId = 0n;

  for (const character of String(shortcode || "")) {
    const value = SHORTCODE_ALPHABET.indexOf(character);

    if (value < 0) {
      return "";
    }

    mediaId = mediaId * 64n + BigInt(value);
  }

  return mediaId > 0n ? mediaId.toString() : "";
}

async function requestMobileMediaInfo(mediaId, settings, options = {}) {
  try {
    const response = await fetchWithTimeout(
      `https://i.instagram.com/api/v1/media/${encodeURIComponent(mediaId)}/info/`,
      { headers: instagramRequestHeaders(MOBILE_HEADERS, settings, options), cache: "no-store" },
      settings.httpTimeoutMs,
    );
    const data = await instagramResponseJson(response);
    const accessError = instagramAccessError(data, response);

    if (accessError) {
      throw accessError;
    }

    const items = Array.isArray(data?.items) ? data.items : [];

    return items[0] && typeof items[0] === "object" ? items[0] : null;
  } catch (error) {
    if (error instanceof AppError) {
      throw error;
    }

    return null;
  }
}

export async function resolveInstagramComments(normalized, options = {}, settings = {}) {
  await ensureInstagramNetwork(settings);

  const limit = normalizeInstagramCommentLimit(options.limit);
  const cursor = parseInstagramCommentCursor(options.cursor);
  const mediaId = await getMediaId(normalized.shortcode, settings);

  if (mediaId && cursor.type !== "snapshot") {
    const page = await requestMobileComments(mediaId, cursor.type === "mobile" ? cursor.value : "", limit, settings);
    const hasMobilePayload = page && (page.comments.length > 0 || page.nextCursor || page.totalCount != null);

    if (hasMobilePayload || cursor.type === "mobile") {
      const comments = page?.comments ?? [];
      const totalCount = page?.totalCount ?? null;
      const publicCount = page?.publicCount ?? totalCount;

      return {
        platform: "instagram",
        shortcode: normalized.shortcode,
        canonical_url: normalized.canonical_url,
        comments,
        next_cursor: page?.nextCursor ? `mobile:${page.nextCursor}` : null,
        has_more: Boolean(page?.nextCursor),
        total_count: totalCount,
        public_count: publicCount,
        is_partial_public_snapshot: totalCount != null && !page?.nextCursor && totalCount > comments.length,
        source: "instagram_mobile_comments",
      };
    }
  }

  const snapshot = await instagramPublicCommentSnapshot(normalized, mediaId, settings);
  const offset = cursor.type === "snapshot" ? cursor.offset : 0;
  const endOffset = offset + limit;
  const comments = snapshot.comments.slice(offset, endOffset);
  const nextCursor = endOffset < snapshot.comments.length ? `snapshot:${endOffset}` : null;
  const totalCount = snapshot.totalCount ?? snapshot.comments.length;

  return {
    platform: "instagram",
    shortcode: normalized.shortcode,
    canonical_url: normalized.canonical_url,
    comments,
    next_cursor: nextCursor,
    has_more: Boolean(nextCursor),
    total_count: totalCount,
    public_count: snapshot.comments.length,
    is_partial_public_snapshot: totalCount > snapshot.comments.length,
    source: snapshot.source,
  };
}

async function requestMobileComments(mediaId, minId, limit, settings) {
  const url = new URL(`https://i.instagram.com/api/v1/media/${encodeURIComponent(mediaId)}/comments/`);

  url.searchParams.set("can_support_threading", "true");
  url.searchParams.set("permalink_enabled", "false");
  url.searchParams.set("count", String(limit));

  if (minId) {
    url.searchParams.set("min_id", minId);
  }

  try {
    const response = await fetchWithTimeout(
      url,
      { headers: instagramRequestHeaders(MOBILE_HEADERS, settings), cache: "no-store" },
      settings.httpTimeoutMs,
    );
    const data = await instagramResponseJson(response);
    const accessError = instagramAccessError(data, response);

    if (accessError) {
      throw accessError;
    }

    if (!data || typeof data !== "object") {
      return null;
    }

    const comments = normalizeInstagramCommentsFromData(data);
    const nextCursor = pickSingleLineText(
      data.next_min_id,
      data.next_max_id,
      data.next_cursor,
    );
    const totalCount = firstInstagramCommentCount(
      data.comment_count,
      data.comments_count,
      data.total_count,
    );

    return {
      comments,
      nextCursor,
      totalCount,
      publicCount: totalCount,
    };
  } catch {
    return null;
  }
}

async function instagramPublicCommentSnapshot(normalized, mediaId, settings) {
  const sources = [];

  if (mediaId) {
    const mediaInfo = await requestMobileMediaInfo(mediaId, settings);

    if (mediaInfo) {
      sources.push({ data: mediaInfo, source: "instagram_mobile_media_snapshot" });
    }
  }

  const gqlData = await requestWebGraphqlPostData(normalized.shortcode, settings);

  if (gqlData) {
    sources.push({ data: { gql_data: gqlData }, source: "instagram_web_graphql_snapshot" });
  }

  try {
    const html = await fetchPublicPage(normalized.canonical_url, settings);

    for (const text of scriptTexts(html)) {
      if (!text) {
        continue;
      }

      for (const data of extractEmbeddedJsonObjects(text, [
        "window._sharedData",
        "__additionalDataLoaded",
        "__bbox",
        "edge_media_to_parent_comment",
        "edge_media_preview_comment",
        "xdt_shortcode_media",
      ])) {
        sources.push({ data, source: "instagram_public_page_snapshot" });
      }
    }
  } catch {
    // The mobile and GraphQL snapshots above are usually enough for public comments.
  }

  const comments = dedupeInstagramComments(
    sources.flatMap((source) => normalizeInstagramCommentsFromData(source.data)),
  );
  const totalCount = maxInstagramCommentCount(
    ...sources.map((source) => parseMetricsFromInstagramData(source.data).comment_count),
  );
  const source = sources.find((item) => normalizeInstagramCommentsFromData(item.data).length > 0)?.source ||
    "instagram_public_comment_snapshot";

  return {
    comments,
    totalCount,
    source,
  };
}

function normalizeInstagramCommentLimit(value) {
  const parsed = Number.parseInt(String(value ?? ""), 10);

  if (!Number.isFinite(parsed)) {
    return 12;
  }

  return Math.max(1, Math.min(30, parsed));
}

function parseInstagramCommentCursor(value) {
  const raw = String(value ?? "").trim();

  if (!raw) {
    return { type: "initial", value: "", offset: 0 };
  }

  if (raw.startsWith("mobile:")) {
    return { type: "mobile", value: raw.slice("mobile:".length), offset: 0 };
  }

  if (raw.startsWith("snapshot:")) {
    return { type: "snapshot", value: "", offset: normalizeInstagramCommentOffset(raw.slice("snapshot:".length)) };
  }

  const offset = normalizeInstagramCommentOffset(raw);

  if (String(offset) === raw) {
    return { type: "snapshot", value: "", offset };
  }

  return { type: "mobile", value: raw, offset: 0 };
}

function normalizeInstagramCommentOffset(value) {
  const parsed = Number.parseInt(String(value ?? ""), 10);

  if (!Number.isFinite(parsed) || parsed < 0) {
    return 0;
  }

  return parsed;
}

function normalizeInstagramCommentsFromData(data) {
  const candidates = [];

  collectInstagramCommentCandidates(data, candidates);

  return dedupeInstagramComments(
    candidates
      .map((comment) => normalizeInstagramComment(comment))
      .filter((comment) => comment.id && (comment.text || comment.author_name)),
  );
}

function collectInstagramCommentCandidates(data, candidates, depth = 0, seen = new WeakSet()) {
  if (!data || typeof data !== "object" || depth > 8 || seen.has(data)) {
    return;
  }

  seen.add(data);

  if (Array.isArray(data)) {
    for (const item of data) {
      collectInstagramCommentCandidates(item, candidates, depth + 1, seen);
    }

    return;
  }

  for (const key of ["comments", "preview_comments", "top_comments"]) {
    appendInstagramCommentList(candidates, data[key]);
  }

  for (const key of ["edge_media_to_parent_comment", "edge_media_to_comment", "edge_media_preview_comment"]) {
    appendInstagramCommentEdge(candidates, data[key]);
  }

  for (const key of ["gql_data", "shortcode_media", "xdt_shortcode_media", "media", "item", "items", "data"]) {
    collectInstagramCommentCandidates(data[key], candidates, depth + 1, seen);
  }
}

function appendInstagramCommentEdge(candidates, edge) {
  if (!edge || typeof edge !== "object") {
    return;
  }

  appendInstagramCommentList(candidates, edge.edges);
}

function appendInstagramCommentList(candidates, list) {
  if (!Array.isArray(list)) {
    return;
  }

  for (const item of list) {
    const comment = unwrapInstagramCommentNode(item);

    if (looksLikeInstagramComment(comment)) {
      candidates.push(comment);
    }
  }
}

function unwrapInstagramCommentNode(value) {
  if (!value || typeof value !== "object") {
    return null;
  }

  if (value.node && typeof value.node === "object") {
    return value.node;
  }

  if (value.comment && typeof value.comment === "object") {
    return value.comment;
  }

  return value;
}

function looksLikeInstagramComment(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  return Boolean(
    pickText(value.text, value.comment_text, value.content) &&
      (value.user || value.owner || value.author || value.pk || value.id || value.comment_id),
  );
}

function normalizeInstagramComment(comment) {
  const node = unwrapInstagramCommentNode(comment) ?? {};
  const author = instagramCommentAuthor(node);
  const text = cleanDisplayText(pickText(node.text, node.comment_text, node.content), { maxLength: 5000 });
  const createdAt = normalizeInstagramCommentTime(
    node.created_at_utc,
    node.created_at,
    node.taken_at,
    node.created_time,
  );
  const authorHandle = normalizeCreatorHandle(
    pickSingleLineText(author.username, author.handle, author.id),
  );
  const authorName = pickSingleLineText(
    author.full_name,
    author.name,
    author.username,
    authorHandle,
    "Instagram 用户",
  );
  const id = pickSingleLineText(node.pk, node.id, node.comment_id, node.node_id) ||
    `instagram-comment-${hashInstagramComment([authorHandle, authorName, createdAt, text].join("|"))}`;
  const replies = instagramCommentReplies(node)
    .slice(0, 3)
    .map((reply) => normalizeInstagramComment(reply))
    .filter((reply) => reply.id);

  return {
    id,
    text,
    author_name: authorName,
    author_handle: authorHandle,
    avatar_url: instagramCommentAvatarUrl(author),
    created_at: createdAt,
    like_count: firstInstagramCommentCount(
      node.comment_like_count,
      node.like_count,
      node.likes_count,
      node.edge_liked_by,
    ),
    reply_count: firstInstagramCommentCount(
      node.child_comment_count,
      node.inline_child_comment_count,
      node.reply_count,
      node.edge_threaded_comments,
      replies.length,
    ),
    ip_loc: "",
    has_voice: false,
    replies,
  };
}

function instagramCommentAuthor(comment) {
  for (const key of ["user", "owner", "author"]) {
    const value = comment?.[key];

    if (value && typeof value === "object") {
      return value;
    }
  }

  return {};
}

function instagramCommentAvatarUrl(author) {
  for (const value of instagramAvatarUrlCandidates(author)) {
    const url = cleanSingleLineText(decodeJsonString(value || ""), { maxLength: 4096 });

    if (isHttpUrl(url)) {
      return url;
    }
  }

  return "";
}

function instagramAvatarUrlCandidates(author) {
  if (!author || typeof author !== "object") {
    return [];
  }

  return [
    author.profile_pic_url,
    author.profile_pic_url_hd,
    author.profile_picture,
    author.avatar_url,
    author.picture,
    author.profile_pic?.url,
    author.profile_pic?.uri,
    author.profile_pic_url_info?.url,
    author.profile_pic_url_info?.uri,
    author.hd_profile_pic_url_info?.url,
    author.hd_profile_pic_url_info?.uri,
    ...(Array.isArray(author.hd_profile_pic_versions)
      ? author.hd_profile_pic_versions.flatMap((item) => [item?.url, item?.uri])
      : []),
  ].flatMap((value) => avatarUrlCandidateValues(value));
}

function avatarUrlCandidateValues(value) {
  if (!value) {
    return [];
  }

  if (typeof value === "string") {
    return [value];
  }

  if (Array.isArray(value)) {
    return value.flatMap((item) => avatarUrlCandidateValues(item));
  }

  if (typeof value === "object") {
    return [
      value.url,
      value.uri,
      value.src,
      value.href,
    ].filter(Boolean);
  }

  return [];
}

function isHttpUrl(value) {
  try {
    const parsed = new URL(value);

    return ["http:", "https:"].includes(parsed.protocol) && Boolean(parsed.hostname);
  } catch {
    return false;
  }
}

function instagramCommentReplies(comment) {
  const replies = [];

  for (const key of ["child_comments", "preview_child_comments", "preview_child_comments_v2", "replies"]) {
    const value = comment?.[key];

    if (Array.isArray(value)) {
      replies.push(...value.map((item) => unwrapInstagramCommentNode(item)).filter(Boolean));
    }
  }

  for (const key of ["edge_threaded_comments", "edge_comment_to_parent_comment"]) {
    const edges = comment?.[key]?.edges;

    if (Array.isArray(edges)) {
      replies.push(...edges.map((item) => unwrapInstagramCommentNode(item)).filter(Boolean));
    }
  }

  return dedupeInstagramCommentNodes(replies);
}

function dedupeInstagramCommentNodes(comments) {
  const seen = new Set();
  const deduped = [];

  for (const comment of comments) {
    const node = unwrapInstagramCommentNode(comment);
    const key = pickSingleLineText(node?.pk, node?.id, node?.comment_id) ||
      hashInstagramComment(`${instagramCommentAuthor(node).username || ""}|${node?.created_at || ""}|${node?.text || ""}`);

    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    deduped.push(node);
  }

  return deduped;
}

function dedupeInstagramComments(comments) {
  const seen = new Set();
  const deduped = [];

  for (const comment of comments) {
    const key = comment.id || hashInstagramComment(`${comment.author_handle || ""}|${comment.created_at || ""}|${comment.text || ""}`);

    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    deduped.push(comment);
  }

  return deduped;
}

function normalizeInstagramCommentTime(...values) {
  for (const value of values) {
    if (value == null || value === "") {
      continue;
    }

    const numeric = typeof value === "number" || /^\d+$/.test(String(value).trim())
      ? optionalInt(value)
      : null;

    if (numeric != null) {
      const timestamp = numeric > 10_000_000_000 ? numeric : numeric * 1000;
      const date = new Date(timestamp);

      if (!Number.isNaN(date.getTime())) {
        return date.toISOString();
      }
    }

    const date = new Date(String(value));

    if (!Number.isNaN(date.getTime())) {
      return date.toISOString();
    }
  }

  return null;
}

function firstInstagramCommentCount(...values) {
  for (const value of values) {
    const count = countFromValue(value);

    if (count != null) {
      return count;
    }
  }

  return null;
}

function maxInstagramCommentCount(...values) {
  let max = null;

  for (const value of values) {
    const count = countFromValue(value);

    if (count != null && (max == null || count > max)) {
      max = count;
    }
  }

  return max;
}

function hashInstagramComment(value) {
  let hash = 5381;

  for (const character of String(value || "")) {
    hash = ((hash << 5) + hash) ^ character.charCodeAt(0);
  }

  return Math.abs(hash >>> 0).toString(36);
}

async function resolveFromEmbedContext(shortcode, settings, options = {}) {
  try {
    const response = await fetchWithTimeout(
      `https://www.instagram.com/p/${encodeURIComponent(shortcode)}/embed/captioned/`,
      { headers: instagramRequestHeaders(EMBED_HEADERS, settings, options), cache: "no-store" },
      settings.httpTimeoutMs,
    );

    if (response.status >= 400) {
      return { assets: [], metrics: createMetrics(), creator_handle: "" };
    }

    const text = await response.text();
    const accessError = instagramAccessError(text, response);

    if (accessError && !hasPublicMediaData(text)) {
      throw accessError;
    }

    const match = /"init",\[\],\[(.*?)\]\],/s.exec(text);

    if (!match) {
      return { assets: [], metrics: createMetrics(), creator_handle: "" };
    }

    const payload = JSON.parse(match[1]);
    const contextJson = payload && typeof payload === "object" ? payload.contextJSON : "";
    const data = typeof contextJson === "string" ? JSON.parse(contextJson) : null;
    const metrics = parseMetricsFromInstagramData(data);
    const creatorHandle = parseCreatorFromInstagramData(data);

    return {
      assets: parseAssetsFromInstagramData(data),
      metrics,
      creator_handle: creatorHandle,
      post_info: parsePostInfoFromInstagramData(data, { metrics, creatorHandle }),
    };
  } catch (error) {
    if (error instanceof AppError) {
      throw error;
    }

    return { assets: [], metrics: createMetrics(), creator_handle: "" };
  }
}

async function resolveFromWebGraphql(shortcode, settings, options = {}) {
  const gqlData = await requestWebGraphqlPostData(shortcode, settings, options);

  if (!gqlData) {
    return { assets: [], metrics: createMetrics(), creator_handle: "" };
  }

  const wrapped = { gql_data: gqlData };
  const metrics = parseMetricsFromInstagramData(wrapped);
  const creatorHandle = parseCreatorFromInstagramData(wrapped);

  return {
    assets: parseAssetsFromInstagramData(wrapped),
    metrics,
    creator_handle: creatorHandle,
    post_info: parsePostInfoFromInstagramData(wrapped, { metrics, creatorHandle }),
  };
}

async function resolveFromRenderedPage(shortcode, settings) {
  const html = await fetchRenderedInstagramHtml(shortcode, settings);

  if (!html) {
    return { assets: [], metrics: createMetrics(), creator_handle: "" };
  }

  const metrics = parseMetricsFromHtml(html);
  const creatorHandle = parseCreatorFromHtml(html);

  return {
    assets: parseAssetsFromHtml(html),
    metrics,
    creator_handle: creatorHandle,
    post_info: parsePostInfoFromHtml(html, {
      metrics,
      creatorHandle,
      shortcode,
    }),
  };
}

async function requestWebGraphqlPostData(shortcode, settings, options = {}) {
  const params = await getGraphqlParams(shortcode, settings, options);

  if (!params) {
    return null;
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
          ...instagramRequestHeaders(EMBED_HEADERS, settings, options),
          ...headers,
          "content-type": "application/x-www-form-urlencoded",
          "x-fb-friendly-name": "PolarisPostActionLoadPostQueryQuery",
        },
        body: requestBody,
      },
      settings.httpTimeoutMs,
    );
    const data = await instagramResponseJson(response);
    const accessError = instagramAccessError(data, response);

    if (accessError) {
      throw accessError;
    }

    return data && typeof data === "object" ? data.data : null;
  } catch (error) {
    if (error instanceof AppError) {
      throw error;
    }

    return null;
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
      "image_versions2",
      "carousel_media",
      "xdt_shortcode_media",
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

export function parsePostInfoFromInstagramData(data, options = {}) {
  const media = firstInstagramMediaData(data) || (data && typeof data === "object" ? data : {});
  const metrics = options.metrics ?? parseMetricsFromInstagramData(data);
  const creatorHandle = cleanSingleLineText(
    options.creatorHandle || parseCreatorFromInstagramData(data),
    { maxLength: 120 },
  );
  const body = pickText(
    instagramCaptionText(media),
    instagramCaptionText(data),
  );
  const author = pickSingleLineText(
    dig(media, "user", "full_name"),
    dig(media, "user", "username"),
    dig(media, "owner", "full_name"),
    dig(media, "owner", "username"),
    dig(media, "author", "name"),
    dig(media, "author", "username"),
    dig(data, "gql_data", "shortcode_media", "owner", "full_name"),
    dig(data, "gql_data", "xdt_shortcode_media", "owner", "full_name"),
    creatorHandle,
  );
  const title = pickSingleLineText(
    media.title,
    media.name,
    instagramTitleFromCaption(body),
    author ? `Instagram post by ${author}` : "",
  );

  return createPostInfo(
    {
      title,
      author,
      author_handle: creatorHandle,
      body,
      tags: normalizeTags(instagramTagsFromData(media), body),
      metrics,
      source: metrics?.source || "instagram_public_best_effort",
    },
    {
      metrics,
      creatorHandle,
      source: metrics?.source || "instagram_public_best_effort",
    },
  );
}

export function parsePostInfoFromHtml(html, options = {}) {
  const metrics = options.metrics ?? parseMetricsFromHtml(html);
  const creatorHandle = cleanSingleLineText(
    options.creatorHandle || parseCreatorFromHtml(html),
    { maxLength: 120 },
  );

  for (const text of scriptTexts(html, { type: "application/ld+json" })) {
    for (const data of loadsJsonVariants(text)) {
      const postInfo = parsePostInfoFromInstagramData(data, { metrics, creatorHandle });

      if (postInfo.body || postInfo.title || postInfo.author || postInfo.author_handle) {
        return postInfo;
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
      "image_versions2",
      "carousel_media",
      "xdt_shortcode_media",
    ])) {
      const postInfo = parsePostInfoFromInstagramData(data, { metrics, creatorHandle });

      if (postInfo.body || postInfo.title || postInfo.author || postInfo.author_handle) {
        return postInfo;
      }
    }
  }

  const metaTitle = pickSingleLineText(
    metaContents(html, ["og:title", "twitter:title", "title"]),
    htmlTitle(html),
  );
  const descriptions = metaContents(html, ["og:description", "twitter:description", "description"]);
  const body = pickText(
    descriptions.map((description) => captionFromInstagramDescription(description)),
    descriptions,
  );
  const title = cleanInstagramMetaTitle(metaTitle) ||
    pickSingleLineText(instagramTitleFromCaption(body), creatorHandle ? `Instagram post by ${creatorHandle}` : "");

  return createPostInfo(
    {
      title,
      author: creatorHandle,
      author_handle: creatorHandle,
      body,
      tags: normalizeTags([], body),
      metrics,
      source: metrics?.source || "instagram_public_best_effort",
    },
    {
      metrics,
      creatorHandle,
      source: metrics?.source || "instagram_public_best_effort",
    },
  );
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

function firstInstagramMediaData(data, depth = 0) {
  if (!data || typeof data !== "object" || depth > 7) {
    return null;
  }

  if (Array.isArray(data)) {
    for (const item of data) {
      const nested = firstInstagramMediaData(item, depth + 1);

      if (nested) {
        return nested;
      }
    }

    return null;
  }

  const gqlMedia = dig(data, "gql_data", "shortcode_media") || dig(data, "gql_data", "xdt_shortcode_media");

  if (gqlMedia && typeof gqlMedia === "object") {
    return gqlMedia;
  }

  if (looksLikeMediaData(data)) {
    return data;
  }

  for (const key of ["items", "media", "shortcode_media", "xdt_shortcode_media", "node"]) {
    const nested = firstInstagramMediaData(data[key], depth + 1);

    if (nested) {
      return nested;
    }
  }

  for (const value of Object.values(data)) {
    const nested = firstInstagramMediaData(value, depth + 1);

    if (nested) {
      return nested;
    }
  }

  return null;
}

function instagramCaptionText(data) {
  if (!data || typeof data !== "object") {
    return "";
  }

  const edgeCaption = captionFromEdge(data.edge_media_to_caption);
  const parentCaption = captionFromEdge(data.edge_media_to_parent_comment);

  return pickText(
    dig(data, "caption", "text"),
    typeof data.caption === "string" ? data.caption : "",
    edgeCaption,
    parentCaption,
    data.caption_text,
    data.text,
    data.description,
  );
}

function captionFromEdge(edge) {
  const edges = Array.isArray(edge?.edges) ? edge.edges : [];
  const first = edges[0]?.node;

  return first && typeof first === "object" ? first.text : "";
}

function instagramTagsFromData(data) {
  if (!data || typeof data !== "object") {
    return [];
  }

  const tags = [];
  const taggedUsers = data.usertags?.in || data.edge_media_to_tagged_user?.edges;

  if (Array.isArray(taggedUsers)) {
    for (const item of taggedUsers) {
      const user = item?.user || item?.node?.user || item?.node;
      const username = user && typeof user === "object" ? user.username : "";

      if (username) {
        tags.push(username);
      }
    }
  }

  return tags;
}

function instagramTitleFromCaption(caption) {
  const firstLine = cleanSingleLineText(String(caption || "").split("\n")[0], { maxLength: 120 });

  if (!firstLine) {
    return "";
  }

  return firstLine.length > 96 ? `${firstLine.slice(0, 93).trimEnd()}...` : firstLine;
}

function captionFromInstagramDescription(value) {
  const text = cleanDisplayText(value, { maxLength: 8000 });

  if (!text) {
    return "";
  }

  const quoted = /:\s*["']([\s\S]+?)["']\s*$/.exec(text);

  if (quoted) {
    return cleanDisplayText(quoted[1], { maxLength: 8000 });
  }

  const colon = /\bon\b[^:]{1,80}:\s*([\s\S]+)$/i.exec(text);

  if (colon) {
    return cleanDisplayText(colon[1].replace(/^["']|["']$/g, ""), { maxLength: 8000 });
  }

  return "";
}

function cleanInstagramMetaTitle(value) {
  return cleanSingleLineText(value, { maxLength: 220 })
    .replace(/\s*[•-]\s*Instagram(?: photos and videos)?\s*$/i, "")
    .trim();
}

function htmlTitle(html) {
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1];

  return title ? htmlUnescape(title) : "";
}


async function getGraphqlParams(shortcode, settings, options = {}) {
  try {
    const response = await fetchWithTimeout(
      `https://www.instagram.com/p/${encodeURIComponent(shortcode)}/`,
      { headers: instagramRequestHeaders(EMBED_HEADERS, settings, options), cache: "no-store" },
      settings.httpTimeoutMs,
    );

    if (response.status >= 400) {
      return null;
    }

    const html = await response.text();
    const accessError = instagramAccessError(html, response);

    if (accessError && !hasPublicMediaData(html)) {
      throw accessError;
    }

    const siteData = objectFromEntries("SiteData", html) ?? {};
    const polarisSiteData = objectFromEntries("PolarisSiteData", html) ?? {};
    const webConfig = objectFromEntries("DGWWebConfig", html) ?? {};
    const pushInfo = objectFromEntries("InstagramWebPushInfo", html) ?? {};
    const lsd = objectFromEntries("LSD", html)?.token || randomToken(8);
    const csrf = objectFromEntries("InstagramSecurityConfig", html)?.csrf_token;
    const bloks = objectFromEntries("WebBloksVersioningID", html)?.versioningID;
    const authCookie = options.includeCookie === false ? "" : instagramCookieHeader(settings);
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
    const cookie = mergeInstagramCookieHeaders(authCookie, anonCookie);
    const userId = instagramCookieValue(cookie, "ds_user_id") || "0";
    const csrfToken = csrf || instagramCookieValue(cookie, "csrftoken");
    const headers = {
      "x-ig-app-id": String(webConfig.appId || WEB_APP_ID),
      "x-fb-lsd": String(lsd),
      "x-asbd-id": "129477",
    };

    if (csrfToken) {
      headers["x-csrftoken"] = String(csrfToken);
    }

    if (bloks) {
      headers["x-bloks-version-id"] = String(bloks);
    }

    if (cookie) {
      headers.cookie = cookie;
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
        __user: userId,
        __comet_req: String(numberFromQuery("__comet_req", html) || "7"),
        av: userId,
        dpr: "2",
        lsd: String(lsd),
        jazoest: String(numberFromQuery("jazoest", html) || Math.floor(Math.random() * 9000) + 1000),
        __spin_r: String(siteData.__spin_r || "1019933358"),
        __spin_b: String(siteData.__spin_b || "trunk"),
        __spin_t: String(siteData.__spin_t || "1710000000"),
      },
    };
  } catch (error) {
    if (error instanceof AppError) {
      throw error;
    }

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

  return candidates.reduce((best, candidate) =>
    compareInstagramMediaVersions(candidate, best) > 0 ? candidate : best,
  candidates[0]);
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
  const urls = instagramMediaUrlVariants(url, mediaType);

  if (!url) {
    return null;
  }

  return {
    source_url: urls[0],
    fallback_urls: urls.slice(1),
    media_type: mediaType,
    request_headers: instagramMediaRequestHeaders(),
    width: optionalInt(width),
    height: optionalInt(height),
  };
}

function dedupeInstagramAssets(assets) {
  const deduped = new Map();
  const keyAliases = new Map();
  const order = [];

  for (const asset of assets) {
    const keys = instagramAssetMatchKeys(asset);
    const key = keys.map((candidateKey) => keyAliases.get(candidateKey)).find(Boolean) || keys[0];
    const existing = deduped.get(key);

    if (existing) {
      if (compareInstagramAssets(asset, existing) > 0) {
        deduped.set(key, {
          ...existing,
          ...asset,
          width: asset.width ?? existing.width ?? null,
          height: asset.height ?? existing.height ?? null,
        });
      }

      continue;
    }

    deduped.set(key, asset);
    keys.forEach((candidateKey) => keyAliases.set(candidateKey, key));
    order.push(key);
  }

  return order.map((key) => deduped.get(key)).filter(Boolean);
}

function upgradeInstagramAssetsFromText(assets, text) {
  if (!assets.length || !text) {
    return assets;
  }

  const candidates = instagramUpgradeCandidatesFromText(text);

  if (candidates.length === 0) {
    return assets;
  }

  const upgradedAssets = assets.map((asset) => {
    let best = asset;
    const assetKeys = new Set(instagramAssetMatchKeys(asset));

    for (const candidateAsset of candidates) {
      const candidate = {
        ...asset,
        ...candidateAsset,
        width: candidateAsset.width ?? asset.width ?? null,
        height: candidateAsset.height ?? asset.height ?? null,
        fallback_urls: [asset.source_url, ...(asset.fallback_urls || [])],
      };

      if (
        instagramAssetMatchKeys(candidate).some((key) => assetKeys.has(key)) &&
        compareInstagramAssets(candidate, best) > 0
      ) {
        best = candidate;
      }
    }

    return best;
  });

  return supplementInstagramVideoAssets(upgradedAssets, candidates, text);
}

function supplementInstagramVideoAssets(assets, candidates, text) {
  if (assets.some((asset) => asset?.media_type === "video") || !instagramTextSuggestsVideo(text)) {
    return assets;
  }

  const videos = candidates
    .filter((asset) => asset?.media_type === "video" && asset.source_url)
    .sort((left, right) => compareInstagramAssets(right, left));

  if (!videos.length) {
    return assets;
  }

  if (assets.length === 1 && assets[0]?.media_type === "image") {
    return [videos[0]];
  }

  return dedupeInstagramAssets([
    ...assets,
    ...videos.slice(0, Math.max(1, assets.length)),
  ]);
}

function instagramTextSuggestsVideo(text) {
  return /"is_video"\s*:\s*true|GraphVideo|VideoObject|"media_type"\s*:\s*2|"product_type"\s*:\s*"(?:clips|reels?)"/i
    .test(String(text || ""));
}

async function upgradeInstagramAssetsFromRenderedPage(assets, shortcode, settings) {
  if (!shouldUseRenderedInstagramFallback(assets)) {
    return assets;
  }

  const html = await fetchRenderedInstagramHtml(shortcode, settings);

  return html ? upgradeInstagramAssetsFromText(assets, html) : assets;
}

function shouldUseRenderedInstagramFallback(assets) {
  if (isDisabledValue(process.env.SOCIAL_RENDERED_INSTAGRAM_FALLBACK)) {
    return false;
  }

  return assets.some((asset) =>
    asset?.media_type === "image" &&
    ((optionalInt(asset.width) || 0) <= 1080 || !/ig_cache_key=|xpids\.1440/i.test(asset.source_url || "")),
  );
}

async function fetchRenderedInstagramHtml(shortcode, settings) {
  const chromePath = resolveChromePath();

  if (!chromePath) {
    return "";
  }

  const timeoutMs = Math.min(Math.max(settings.httpTimeoutMs * 2, 20_000), 45_000);

  try {
    const { stdout } = await execFileAsync(
      chromePath,
      [
        "--headless=new",
        "--disable-gpu",
        "--no-sandbox",
        "--dump-dom",
        "--virtual-time-budget=7000",
        `https://www.instagram.com/p/${encodeURIComponent(shortcode)}/`,
      ],
      {
        timeout: timeoutMs,
        maxBuffer: 30 * 1024 * 1024,
      },
    );

    return stdout;
  } catch {
    return "";
  }
}

async function fetchRenderedInstagramProfileHtml(profileUrl, settings, fallbackHandle = "") {
  if (isDisabledValue(process.env.SOCIAL_RENDERED_INSTAGRAM_FALLBACK)) {
    return "";
  }

  const chromePath = resolveChromePath();

  if (!chromePath) {
    return "";
  }

  const timeoutMs = Math.min(Math.max(settings.httpTimeoutMs * 3, 30_000), 70_000);

  const scrolledHtml = await fetchScrolledRenderedInstagramProfileHtml(
    chromePath,
    profileUrl,
    timeoutMs,
    settings,
    fallbackHandle,
  );

  if (scrolledHtml) {
    return scrolledHtml;
  }

  return await fetchDumpedRenderedInstagramProfileHtml(chromePath, profileUrl, timeoutMs);
}

async function fetchScrolledRenderedInstagramProfileHtml(chromePath, profileUrl, timeoutMs, settings, fallbackHandle = "") {
  let userDataDir = "";
  let chromeProcess = null;
  let session = null;

  try {
    const port = await findFreePort();
    userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), "linkmigo-ig-profile-"));
    chromeProcess = spawn(
      chromePath,
      [
        "--headless=new",
        "--disable-gpu",
        "--no-sandbox",
        "--disable-dev-shm-usage",
        "--disable-background-networking",
        "--disable-sync",
        "--disable-extensions",
        "--mute-audio",
        "--remote-allow-origins=*",
        `--remote-debugging-port=${port}`,
        `--user-data-dir=${userDataDir}`,
        "about:blank",
      ],
      {
        stdio: "ignore",
      },
    );

    const pageInfo = await openChromeDevToolsPage(port, timeoutMs);
    session = await openChromeDevToolsSession(pageInfo.webSocketDebuggerUrl, timeoutMs);

    await session.send("Runtime.enable", {}, 5000);
    await session.send("Network.enable", {}, 5000);
    await session.send("Page.enable", {}, 5000);
    await setChromeInstagramCookies(session, profileUrl, settings);
    await session.send("Page.navigate", { url: profileUrl }, 5000);
    await delay(3000);

    const deadline = Date.now() + timeoutMs;
    const postsByShortcode = new Map();
    let idleRounds = 0;
    let scrollRounds = 0;

    while (
      Date.now() < deadline &&
      idleRounds < PROFILE_RENDER_SCROLL_IDLE_ROUNDS &&
      scrollRounds < PROFILE_RENDER_SCROLL_ROUNDS
    ) {
      scrollRounds += 1;
      const beforeSize = postsByShortcode.size;
      const result = await evaluateChromeRuntime(
        session,
        renderedProfileCollectExpression(fallbackHandle),
        Math.min(10_000, Math.max(1000, deadline - Date.now())),
      );
      const rows = Array.isArray(result?.anchors) ? result.anchors : [];

      for (const row of rows) {
        const shortcode = cleanSingleLineText(row?.shortcode, { maxLength: 80 });
        const kind = row?.kind === "reel" ? "reel" : "p";

        if (!SHORTCODE_RE.test(shortcode) || postsByShortcode.has(shortcode)) {
          continue;
        }

        postsByShortcode.set(shortcode, {
          shortcode,
          kind,
          handle: normalizeCreatorHandle(row?.handle || fallbackHandle),
          previewUrl: pickInstagramUrl(row?.previewUrl, row?.srcsetUrl),
          alt: cleanDisplayText(row?.alt, { maxLength: 4000 }),
        });
      }

      idleRounds = postsByShortcode.size === beforeSize ? idleRounds + 1 : 0;

      if (postsByShortcode.size >= PROFILE_POST_LIMIT && idleRounds > 0) {
        break;
      }

      await delay(PROFILE_RENDER_SCROLL_WAIT_MS);
    }

    const outerHtml = await evaluateChromeRuntime(
      session,
      "document.documentElement.outerHTML",
      Math.min(10_000, Math.max(1000, deadline - Date.now())),
    ).catch(() => "");

    return renderedProfileRowsToHtml([...postsByShortcode.values()], fallbackHandle, outerHtml);
  } catch {
    return "";
  } finally {
    if (session) {
      session.close();
    }

    await stopChromeProcess(chromeProcess);

    if (userDataDir) {
      await fs.rm(userDataDir, { recursive: true, force: true }).catch(() => {});
    }
  }
}

async function fetchDumpedRenderedInstagramProfileHtml(chromePath, profileUrl, timeoutMs) {
  try {
    const { stdout } = await execFileAsync(
      chromePath,
      [
        "--headless=new",
        "--disable-gpu",
        "--no-sandbox",
        "--dump-dom",
        "--virtual-time-budget=9000",
        profileUrl,
      ],
      {
        timeout: timeoutMs,
        maxBuffer: 30 * 1024 * 1024,
      },
    );

    return stdout;
  } catch {
    return "";
  }
}

async function setChromeInstagramCookies(session, profileUrl, settings = {}) {
  const cookieHeader = instagramCookieHeader(settings);
  const cookieEntries = instagramCookieEntries(cookieHeader);

  await session.send(
    "Network.setExtraHTTPHeaders",
    {
      headers: {
        "accept-language": "en-US,en;q=0.9",
        referer: "https://www.instagram.com/",
      },
    },
    5000,
  ).catch(() => {});

  if (!cookieEntries.length) {
    return;
  }

  for (const cookie of cookieEntries) {
    for (const domain of ["instagram.com", ".instagram.com"]) {
      await session.send(
        "Network.setCookie",
        {
          name: cookie.name,
          value: cookie.value,
          domain,
          path: "/",
          secure: true,
          httpOnly: false,
          sameSite: "None",
          url: profileUrl,
        },
        5000,
      ).catch(() => {});
    }
  }
}

function instagramCookieEntries(cookieHeader) {
  const entries = [];
  const seen = new Set();

  for (const part of String(cookieHeader || "").split(";")) {
    const [rawName, ...rawValue] = part.split("=");
    const name = rawName?.trim();
    const value = rawValue.join("=").trim();

    if (!name || !value || seen.has(name)) {
      continue;
    }

    seen.add(name);
    entries.push({ name, value });
  }

  return entries;
}

function renderedProfileCollectExpression(fallbackHandle = "") {
  const safeFallbackHandle = JSON.stringify(normalizeCreatorHandle(fallbackHandle));

  return `(() => {
    const fallbackHandle = ${safeFallbackHandle};
    const shortcodePattern = /^[A-Za-z0-9_-]{4,64}$/;
    const instagramHostPattern = /(^|\\.)instagram\\.com$/i;
    const lastSrcsetUrl = (srcset) => String(srcset || "")
      .split(",")
      .map((part) => part.trim().split(/\\s+/)[0])
      .filter(Boolean)
      .at(-1) || "";
    const cleanHandle = (value) => String(value || "")
      .trim()
      .replace(/^@+/, "")
      .replace(/[^A-Za-z0-9._]/g, "")
      .slice(0, 120);
    const anchors = Array.from(document.querySelectorAll("a[href]"))
      .map((anchor) => {
        let parsed;

        try {
          parsed = new URL(anchor.getAttribute("href") || "", location.href);
        } catch {
          return null;
        }

        if (!instagramHostPattern.test(parsed.hostname)) {
          return null;
        }

        const parts = parsed.pathname.split("/").filter(Boolean);
        let handle = fallbackHandle;
        let kind = "";
        let shortcode = "";

        if ((parts[0] === "p" || parts[0] === "reel") && parts[1]) {
          kind = parts[0];
          shortcode = parts[1];
        } else if (parts.length >= 3 && (parts[1] === "p" || parts[1] === "reel")) {
          handle = cleanHandle(parts[0]) || fallbackHandle;
          kind = parts[1];
          shortcode = parts[2];
        }

        if (!kind || !shortcodePattern.test(shortcode)) {
          return null;
        }

        const image = anchor.querySelector("img");
        const srcset = image?.getAttribute("srcset") || "";

        return {
          handle,
          kind,
          shortcode,
          previewUrl: image?.currentSrc || image?.src || image?.getAttribute("src") || "",
          srcsetUrl: lastSrcsetUrl(srcset),
          alt: image?.getAttribute("alt") || anchor.getAttribute("aria-label") || anchor.textContent || "",
        };
      })
      .filter(Boolean);
    const scrollHeight = Math.max(
      document.body?.scrollHeight || 0,
      document.documentElement?.scrollHeight || 0
    );

    window.scrollTo(0, scrollHeight);

    return {
      anchors,
      scrollHeight,
      scrollY: window.scrollY,
      readyState: document.readyState,
      title: document.title,
      url: location.href,
    };
  })()`;
}

function renderedProfileRowsToHtml(rows, fallbackHandle = "", baseHtml = "") {
  const safeRows = Array.isArray(rows) ? rows : [];

  if (!safeRows.length && !baseHtml) {
    return "";
  }

  const anchors = safeRows
    .map((row) => {
      const handle = normalizeCreatorHandle(row.handle || fallbackHandle);
      const kind = row.kind === "reel" ? "reel" : "p";
      const shortcode = cleanSingleLineText(row.shortcode, { maxLength: 80 });

      if (!handle || !SHORTCODE_RE.test(shortcode)) {
        return "";
      }

      const previewUrl = escapeHtmlAttribute(row.previewUrl || "");
      const alt = escapeHtmlAttribute(row.alt || "");

      return `<a href="/${handle}/${kind}/${shortcode}/"><img src="${previewUrl}" alt="${alt}"></a>`;
    })
    .filter(Boolean)
    .join("");

  if (!baseHtml) {
    return anchors ? `<html><body>${anchors}</body></html>` : "";
  }

  if (!anchors) {
    return baseHtml;
  }

  return /<\/body>/i.test(baseHtml)
    ? baseHtml.replace(/<\/body>/i, `<div data-linkmigo-rendered-profile-posts>${anchors}</div></body>`)
    : `${baseHtml}<div data-linkmigo-rendered-profile-posts>${anchors}</div>`;
}

function escapeHtmlAttribute(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

async function findFreePort() {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();

    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;

      server.close(() => {
        if (port) {
          resolve(port);
        } else {
          reject(new Error("Unable to allocate Chrome debugging port."));
        }
      });
    });
  });
}

async function openChromeDevToolsPage(port, timeoutMs) {
  await waitForChromeDevTools(port, timeoutMs);

  const response = await fetchLocalChrome(
    `http://127.0.0.1:${port}/json/new?${encodeURIComponent("about:blank")}`,
    {
      method: "PUT",
      cache: "no-store",
    },
    Math.min(timeoutMs, 5000),
  );
  const pageInfo = await response.json();

  if (pageInfo?.webSocketDebuggerUrl) {
    return pageInfo;
  }

  throw new Error("Chrome DevTools did not return a page websocket URL.");
}

async function waitForChromeDevTools(port, timeoutMs) {
  const startedAt = Date.now();
  let lastError = null;

  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetchLocalChrome(
        `http://127.0.0.1:${port}/json/version`,
        {
          cache: "no-store",
        },
        1000,
      );

      if (response.ok) {
        return;
      }
    } catch (error) {
      lastError = error;
    }

    await delay(150);
  }

  throw lastError || new Error("Timed out waiting for Chrome DevTools.");
}

async function fetchLocalChrome(url, init = {}, timeoutMs = 5000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, {
      ...init,
      signal: init.signal ?? controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
}

async function openChromeDevToolsSession(webSocketUrl, timeoutMs) {
  if (!webSocketUrl || typeof WebSocket !== "function") {
    throw new Error("Chrome DevTools websocket is unavailable.");
  }

  const socket = new WebSocket(webSocketUrl);
  const pending = new Map();
  let nextId = 1;

  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error("Timed out connecting to Chrome DevTools websocket."));
    }, Math.min(timeoutMs, 5000));

    socket.addEventListener("open", () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
    socket.addEventListener("error", () => {
      clearTimeout(timer);
      reject(new Error("Failed to connect to Chrome DevTools websocket."));
    }, { once: true });
  });

  socket.addEventListener("message", (event) => {
    const text = typeof event.data === "string" ? event.data : String(event.data || "");
    let message;

    try {
      message = JSON.parse(text);
    } catch {
      return;
    }

    if (!message?.id || !pending.has(message.id)) {
      return;
    }

    const entry = pending.get(message.id);
    pending.delete(message.id);
    clearTimeout(entry.timer);

    if (message.error) {
      entry.reject(new Error(message.error.message || "Chrome DevTools command failed."));
      return;
    }

    entry.resolve(message.result);
  });

  socket.addEventListener("close", () => {
    for (const entry of pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(new Error("Chrome DevTools websocket closed."));
    }

    pending.clear();
  });

  return {
    send(method, params = {}, commandTimeoutMs = 10_000) {
      const id = nextId;
      nextId += 1;

      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`Chrome DevTools command timed out: ${method}`));
        }, commandTimeoutMs);

        pending.set(id, { resolve, reject, timer });
        socket.send(JSON.stringify({ id, method, params }));
      });
    },
    close() {
      try {
        socket.close();
      } catch {
        // Best-effort cleanup.
      }
    },
  };
}

async function evaluateChromeRuntime(session, expression, timeoutMs) {
  const result = await session.send(
    "Runtime.evaluate",
    {
      expression,
      awaitPromise: true,
      returnByValue: true,
      timeout: timeoutMs,
    },
    timeoutMs + 1000,
  );

  if (result?.exceptionDetails) {
    throw new Error("Chrome runtime evaluation failed.");
  }

  return result?.result?.value || null;
}

async function stopChromeProcess(chromeProcess) {
  if (!chromeProcess || chromeProcess.exitCode !== null || chromeProcess.signalCode !== null) {
    return;
  }

  await new Promise((resolve) => {
    const timer = setTimeout(() => {
      try {
        chromeProcess.kill("SIGKILL");
      } catch {
        // Best-effort cleanup.
      }

      resolve();
    }, 1000);

    chromeProcess.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });

    try {
      chromeProcess.kill("SIGTERM");
    } catch {
      clearTimeout(timer);
      resolve();
    }
  });
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function execFileAsync(file, args, options) {
  return new Promise((resolve, reject) => {
    execFile(file, args, options, (error, stdout, stderr) => {
      if (error) {
        reject(error);
        return;
      }

      resolve({ stdout, stderr });
    });
  });
}

function resolveChromePath() {
  const candidates = [
    process.env.CHROME_PATH,
    process.env.GOOGLE_CHROME_PATH,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
  ];

  return candidates.find((candidate) =>
    typeof candidate === "string" &&
    candidate.length > 0 &&
    existsSync(candidate),
  ) || "";
}

function instagramUpgradeCandidatesFromText(text) {
  const candidates = parseAssetsFromHtml(text);

  for (const url of instagramRawMediaCandidates(text)) {
    const mediaType = mediaTypeFromUrl(url);

    if (!mediaType) {
      continue;
    }

    candidates.push({
      source_url: url,
      media_type: mediaType,
      width: null,
      height: null,
    });
  }

  return dedupeInstagramAssets(candidates);
}

function instagramRawMediaCandidates(text) {
  const candidates = [];
  const seen = new Set();
  const unescaped = htmlUnescape(String(text || ""))
    .replace(/\\u003a/gi, ":")
    .replace(/\\u002f/gi, "/")
    .replace(/\\u003f/gi, "?")
    .replace(/\\u0025/gi, "%")
    .replace(/\\u0026/gi, "&")
    .replace(/\\u003d/gi, "=")
    .replace(/\\u002e/gi, ".")
    .replace(/\\\//g, "/");
  const pattern =
    /https?:\\?\/\\?\/[^"'<>\\\s]+?(?:cdninstagram|fbcdn)[^"'<>\\\s]+?\.(?:jpe?g|png|webp|heic|mp4|mov|m4v)(?:\?[^"'<>\\\s]*)?/gi;
  let match;

  while ((match = pattern.exec(unescaped))) {
    const url = cleanMediaUrl(match[0]);

    if (!url || seen.has(url)) {
      continue;
    }

    seen.add(url);
    candidates.push(url);
  }

  return candidates;
}

function isDisabledValue(value) {
  return /^(?:0|false|no|off|disabled)$/i.test(String(value || "").trim());
}

function compareInstagramMediaVersions(candidate, current) {
  const left = instagramVersionScore(candidate);
  const right = instagramVersionScore(current);

  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) {
      return left[index] - right[index];
    }
  }

  return 0;
}

function instagramVersionScore(version) {
  const width = optionalInt(version?.width) || 0;
  const height = optionalInt(version?.height) || 0;
  const url = version?.url;

  return [
    instagramUrlCompletenessScore(url),
    width * height,
    Math.max(width, height),
    instagramUrlQualityScore(url),
    firstPresentInt(version?.bitrate, version?.bandwidth, version?.size) || 0,
  ];
}

function compareInstagramAssets(candidate, current) {
  return compareInstagramMediaVersions(
    {
      url: candidate?.source_url,
      width: candidate?.width,
      height: candidate?.height,
    },
    {
      url: current?.source_url,
      width: current?.width,
      height: current?.height,
    },
  );
}

function instagramAssetDedupeKey(asset) {
  const keys = instagramAssetMatchKeys(asset);

  return keys[0] || `${asset.media_type}:${dedupeKey(asset.source_url)}`;
}

function instagramAssetMatchKeys(asset) {
  const keys = [];

  try {
    const parsed = new URL(asset.source_url);
    const cacheKey = parsed.searchParams.get("ig_cache_key");

    if (cacheKey) {
      keys.push(`${asset.media_type}:ig:${cacheKey}`);
    }

    const host = parsed.hostname.toLowerCase();

    if (/(?:cdninstagram|fbcdn|instagram)\.com$/.test(host) || host.includes("cdninstagram.com")) {
      keys.push(`${asset.media_type}:path:${parsed.pathname}`);
    }
  } catch {
    // Fall back to the full URL below.
  }

  keys.push(`${asset.media_type}:url:${dedupeKey(asset.source_url)}`);

  return keys;
}

function instagramUrlQualityScore(rawUrl) {
  if (typeof rawUrl !== "string") {
    return 0;
  }

  let score = 0;
  let text = rawUrl;

  try {
    const parsed = new URL(rawUrl);

    text = `${parsed.pathname} ${parsed.search}`;
    score += instagramEncodedFormatScore(parsed.searchParams.get("efg"));
    score += instagramEncodedFormatScore(parsed.searchParams.get("__sig"));
  } catch {
    // Use the raw text below.
  }

  const lowered = text.toLowerCase();
  const sizeMatches = [...lowered.matchAll(/(?:^|[._/-])(\d{3,4})(?:x\d{3,4})?(?:[._/-]|$)/g)]
    .map((match) => Number.parseInt(match[1], 10))
    .filter((value) => Number.isFinite(value));

  if (sizeMatches.length > 0) {
    score += Math.max(...sizeMatches);
  }

  if (/original|orig|full|high|hd|uhd|1440/.test(lowered)) {
    score += 300;
  }

  if (instagramImageTransformHasCrop(lowered)) {
    score -= 800;
  }

  if (/thumbnail|thumb|preview|p\d+x\d+/.test(lowered)) {
    score -= 500;
  }

  return score;
}

function instagramUrlCompletenessScore(rawUrl) {
  if (typeof rawUrl !== "string") {
    return 0;
  }

  let text = rawUrl;

  try {
    const parsed = new URL(rawUrl);

    text = `${parsed.pathname} ${parsed.search}`;
  } catch {
    // Use the raw text below.
  }

  const lowered = text.toLowerCase();
  let score = 0;

  if (!/[\?&]stp=/.test(lowered) || /xpids\.1440|original|orig|full|hd/.test(lowered)) {
    score += 200;
  }

  if (instagramImageTransformHasCrop(lowered)) {
    score -= 1200;
  }

  if (/thumbnail|thumb|preview|p\d+x\d+/.test(lowered)) {
    score -= 500;
  }

  for (const match of lowered.matchAll(/(?:^|[_&=-])s(\d{2,4})x(\d{2,4})(?:[_&-]|$)/g)) {
    const width = Number.parseInt(match[1], 10);
    const height = Number.parseInt(match[2], 10);

    if (Number.isFinite(width) && Number.isFinite(height) && Math.max(width, height) < 1080) {
      score -= 200;
    }
  }

  return score;
}

function instagramImageTransformHasCrop(text) {
  return /(?:^|[_=&?-])c\d+(?:\.\d+){2,4}a?(?:[_&-]|$)/i.test(String(text || ""));
}

function instagramMediaUrlVariants(url, mediaType) {
  if (mediaType !== "image") {
    return [url];
  }

  let parsed;

  try {
    parsed = new URL(url);
  } catch {
    return [url];
  }

  const host = parsed.hostname.toLowerCase();

  if (!/(?:cdninstagram|fbcdn|instagram)\.com$/.test(host) && !host.includes("cdninstagram.com")) {
    return [url];
  }

  const variants = [];
  const stp = parsed.searchParams.get("stp") || "";

  if (stp) {
    const decroppedStpVariants = instagramDecroppedStpVariants(stp);
    const unresized = new URL(parsed);

    unresized.searchParams.delete("stp");
    variants.push(unresized.toString());

    for (const decroppedStp of decroppedStpVariants) {
      const decropped = new URL(parsed);

      decropped.searchParams.set("stp", decroppedStp);
      variants.push(decropped.toString());
    }

    if (/s\d{3,4}x\d{3,4}/i.test(stp)) {
      const larger = new URL(parsed);

      larger.searchParams.set("stp", stp.replace(/s\d{3,4}x\d{3,4}/gi, "s1440x1440"));
      variants.push(larger.toString());
    }
  }

  variants.push(url);

  return uniqueInstagramUrls(variants);
}

function instagramDecroppedStpVariants(stp) {
  const normalized = String(stp || "");
  const withoutCrop = normalized
    .split("_")
    .filter((part) => !/^c\d+(?:\.\d+){2,4}a?$/i.test(part))
    .join("_");
  const variants = [];

  if (withoutCrop && withoutCrop !== normalized) {
    if (/s\d{3,4}x\d{3,4}/i.test(withoutCrop)) {
      variants.push(withoutCrop.replace(/s\d{3,4}x\d{3,4}/gi, "s1440x1440"));
    }

    variants.push(withoutCrop);
  }

  return uniqueInstagramUrls(variants);
}

function uniqueInstagramUrls(urls) {
  const seen = new Set();

  return urls.filter((candidate) => {
    if (!candidate || seen.has(candidate)) {
      return false;
    }

    seen.add(candidate);
    return true;
  });
}

function instagramEncodedFormatScore(value) {
  if (!value) {
    return 0;
  }

  const decoded = decodeBase64Text(value);
  const match = /(?:^|[._-])(\d{3,4})(?:[._-]|$)/.exec(decoded);
  const size = match ? Number.parseInt(match[1], 10) : 0;

  return (Number.isFinite(size) ? size : 0) + (/original|orig|hd|high/i.test(decoded) ? 300 : 0);
}

function decodeBase64Text(value) {
  try {
    const normalized = String(value).replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");

    return Buffer.from(padded, "base64").toString("utf8");
  } catch {
    return "";
  }
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

  if ("video_versions" in data) {
    addValueAsCandidate(candidates, data.video_versions, "video", width, height);
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

  const urls = instagramMediaUrlVariants(url, resolvedType);
  const key = dedupeKey(urls[0]);
  const existing = candidates.get(key);

  if (existing) {
    if (existing.width == null && width) {
      existing.width = optionalInt(width);
    }

    if (existing.height == null && height) {
      existing.height = optionalInt(height);
    }

    existing.fallback_urls = uniqueInstagramUrls([
      ...(existing.fallback_urls || []),
      ...urls.slice(1),
    ]);

    return;
  }

  candidates.set(key, {
    source_url: urls[0],
    fallback_urls: urls.slice(1),
    media_type: resolvedType,
    request_headers: instagramMediaRequestHeaders(),
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

async function instagramResponseJson(response) {
  const text = stripJsonPrefix(await response.text());

  if (!text) {
    return null;
  }

  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function instagramAccessError(data, response = null) {
  const text = instagramAccessText(data).toLowerCase();
  const details = instagramAccessDetails(data, response);
  const status = optionalInt(response?.status);
  const finalUrl = String(response?.url || "");

  if (looksLikeInstagramRateLimitText(text) || status === 429) {
    return new AppError(
      ErrorCode.UPSTREAM_BLOCKED,
      "Instagram 返回了限流或挑战页面。",
      429,
      details,
    );
  }

  if (looksLikeInstagramAgeOrGeoText(text)) {
    return new AppError(
      ErrorCode.LOGIN_REQUIRED,
      "这个 Instagram 内容受到年龄或地区限制，匿名接口无法读取。请配置 SOCIAL_INSTAGRAM_COOKIE 或 IG_COOKIE 后重试。",
      403,
      instagramTroubleshootingDetails(details),
    );
  }

  if (looksLikeInstagramLoginText(text) || /\/accounts\/login\//i.test(finalUrl) || [401, 403].includes(status)) {
    return new AppError(
      ErrorCode.LOGIN_REQUIRED,
      "这个 Instagram 内容需要登录或当前网络无法公开读取。请配置 SOCIAL_INSTAGRAM_COOKIE 或 IG_COOKIE，或确认服务器/代理可访问 www.instagram.com 和 i.instagram.com。",
      403,
      instagramTroubleshootingDetails(details),
    );
  }

  return null;
}

function instagramTroubleshootingDetails(details = {}) {
  return {
    ...(details || {}),
    hint: "如果浏览器里能打开该帖子，但服务端解析失败，请在 .env.local 配置 SOCIAL_INSTAGRAM_COOKIE（或 IG_COOKIE）为已登录 Instagram 的 Cookie；如果服务器无法直连 Instagram，请配置 SOCIAL_PROXY_URL。",
  };
}

function instagramAccessText(data) {
  if (typeof data === "string") {
    return data;
  }

  if (!data || typeof data !== "object") {
    return "";
  }

  const values = [];
  const keys = [
    "message",
    "error_message",
    "error_type",
    "error_title",
    "error_body",
    "title",
    "description",
    "status",
    "gating_type",
    "blocks_logging_data",
    "geo_block_rule_type",
    "logout_reason",
    "logout_expectedness",
  ];

  for (const key of keys) {
    const value = data[key];

    if (value != null && value !== "") {
      values.push(String(value));
    }
  }

  if (data.require_login === true || data.requires_login === true) {
    values.push("login_required");
  }

  if (Array.isArray(data.errors)) {
    for (const error of data.errors) {
      values.push(instagramAccessText(error));
    }
  }

  return values.filter(Boolean).join(" ");
}

function instagramAccessDetails(data, response = null) {
  const details = {};

  if (response?.status) {
    details.status_code = response.status;
  }

  if (response?.url && /\/accounts\/login\//i.test(String(response.url))) {
    details.redirected_to_login = true;
  }

  if (data && typeof data === "object" && !Array.isArray(data)) {
    for (const key of [
      "message",
      "error_title",
      "error_body",
      "title",
      "description",
      "gating_type",
      "blocks_logging_data",
      "geo_block_rule_type",
      "media_igid",
      "status",
    ]) {
      if (data[key] != null && data[key] !== "") {
        details[key] = data[key];
      }
    }
  }

  return Object.keys(details).length > 0 ? details : undefined;
}

function looksLikeInstagramAgeOrGeoText(text) {
  return [
    "geoblock_required",
    "geo_block",
    "min_age",
    "under 18",
    "age-restricted",
    "age restricted",
    "people under 18",
    "limits on who can see",
  ].some((marker) => text.includes(marker));
}

function looksLikeInstagramLoginText(text) {
  return [
    "login_required",
    "logged out",
    "please log back in",
    "you need to log in",
    "please log in to continue",
    "private account",
    "this account is private",
    "media is private",
    '"is_private":true',
    "this content isn't available right now",
  ].some((marker) => text.includes(marker));
}

function looksLikeInstagramRateLimitText(text) {
  return [
    "please wait a few minutes before you try again",
    "challenge_required",
    "checkpoint_required",
    "suspicious automated behavior",
  ].some((marker) => text.includes(marker));
}

function looksLikeRateLimitOrChallenge(html) {
  return looksLikeInstagramRateLimitText(html.toLowerCase());
}

function hasPublicMediaData(html) {
  return [
    '"image_versions2"',
    '"video_versions"',
    '"carousel_media"',
    '"edge_sidecar_to_children"',
    '"xdt_shortcode_media"',
    '"shortcode_media"',
  ].some((marker) => html.includes(marker));
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
