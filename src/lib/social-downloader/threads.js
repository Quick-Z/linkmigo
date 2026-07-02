import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { URL } from "node:url";

import { AppError, ErrorCode } from "./errors";
import { createPostInfo, normalizeTags, pickSingleLineText } from "./post-info";
import {
  createMetrics,
  firstJsonCount,
  firstRegexInt,
  loadsJsonValues,
  postInfoFromHtmlMeta,
  safeFilenamePart,
} from "./shared";
import {
  dedupeAssets,
  fetchTextResponse,
  fetchWithTimeout,
  htmlUnescape,
  PAGE_HEADERS,
  responseJson,
  scriptTexts,
} from "./utils";
import {
  parseAssetsFromInstagramData,
  parseCreatorFromHtml,
  parseCreatorFromInstagramData,
  parseMetricsFromInstagramData,
  parseMetricsFromHtml,
  parsePostInfoFromInstagramData,
} from "./instagram";

const THREADS_HOSTS = new Set([
  "threads.com",
  "www.threads.com",
  "m.threads.com",
  "threads.net",
  "www.threads.net",
  "m.threads.net",
]);

const THREADS_HEADERS = {
  ...PAGE_HEADERS,
  "accept-language": "en-US,en;q=0.9",
  Referer: "https://www.threads.com/",
};

const THREADS_PRIMARY_MEDIA_CLUSTER_DISTANCE = 12_000;
const THREADS_POST_ID_RE = /^[A-Za-z0-9_-]{4,128}$/;
const THREADS_HANDLE_RE = /^[A-Za-z0-9._]{1,30}$/;

export function isThreadsHost(host) {
  return THREADS_HOSTS.has(host);
}

export function normalizeThreadsUrl(parsed) {
  if (!["http:", "https:"].includes(parsed.protocol) || !isThreadsHost(parsed.hostname.toLowerCase())) {
    throw new AppError(ErrorCode.UNSUPPORTED_URL, "仅支持 Threads 公开帖子链接。", 400);
  }

  const parts = parsed.pathname.split("/").filter(Boolean);
  let creatorHandle = "";
  let shortcode = "";
  let kind = "post";

  if (parts.length >= 3 && parts[0].startsWith("@") && parts[1].toLowerCase() === "post") {
    creatorHandle = parts[0].slice(1);
    shortcode = parts[2];
  } else if (parts.length >= 2 && parts[0].toLowerCase() === "post") {
    shortcode = parts[1];
  } else if (parts.length >= 2 && parts[0].toLowerCase() === "t") {
    shortcode = parts[1];
    kind = "thread";
  } else {
    throw new AppError(ErrorCode.UNSUPPORTED_URL, "仅支持 Threads 公开帖子链接。", 400);
  }

  if (creatorHandle && !THREADS_HANDLE_RE.test(creatorHandle)) {
    throw new AppError(ErrorCode.UNSUPPORTED_URL, "链接中的 Threads 用户名无效。", 400);
  }

  if (!THREADS_POST_ID_RE.test(shortcode)) {
    throw new AppError(ErrorCode.UNSUPPORTED_URL, "链接中的 Threads 帖子 ID 无效。", 400);
  }

  const canonicalPath = creatorHandle
    ? `/@${creatorHandle}/post/${shortcode}`
    : kind === "thread"
      ? `/t/${shortcode}`
      : `/post/${shortcode}`;

  return {
    canonical_url: `https://www.threads.com${canonicalPath}`,
    shortcode,
    kind,
    platform: "threads",
    creator_handle: creatorHandle,
  };
}

export async function resolveThreadsPost(normalized, settings) {
  const pageResponse = await fetchTextResponse({
    url: normalized.canonical_url,
    headers: THREADS_HEADERS,
    label: "Threads",
    timeoutMs: settings.httpTimeoutMs,
  });
  const pageUrl = pageResponse.response?.url || normalized.canonical_url;
  let text = pageResponse.text;
  const graphqlDebug = {};
  const renderedDebug = {};
  const targetPostID = threadsPostIdFromShortcode(normalized.shortcode);
  let relayMedia = findThreadsRelayMedia(text, {
    shortcode: normalized.shortcode,
    postID: targetPostID,
  });

  if (!relayMedia) {
    relayMedia = await requestThreadsRelayMedia(
      text,
      pageUrl,
      normalized.shortcode,
      settings,
      graphqlDebug,
      targetPostID,
    );
  }
  let creatorHandle = pickSingleLineText(
    normalized.creator_handle,
    relayMedia ? parseCreatorFromInstagramData(relayMedia) : "",
    parseCreatorFromHtml(text),
    creatorHandleFromUrl(pageUrl),
  );
  let metrics = threadsMetricsFromHtml(text, relayMedia);
  let assets = threadsAssetsFromHtml(text, {
    creatorHandle,
    pageUrl,
    shortcode: normalized.shortcode,
    relayMedia,
  });

  if (shouldUseRenderedThreadsFallback(text, assets, relayMedia) || shouldEnhanceThreadsFromRenderedPage(text, relayMedia)) {
    const renderedHtml = await fetchRenderedThreadsHtml(pageUrl, settings, renderedDebug);

    if (renderedHtml) {
      text = renderedHtml;
      relayMedia = findThreadsRelayMedia(text, {
        shortcode: normalized.shortcode,
        postID: targetPostID,
      }) || relayMedia;
      creatorHandle = pickSingleLineText(
        normalized.creator_handle,
        relayMedia ? parseCreatorFromInstagramData(relayMedia) : "",
        parseCreatorFromHtml(text),
        creatorHandleFromUrl(pageUrl),
      );
      metrics = threadsMetricsFromHtml(text, relayMedia);
      assets = threadsAssetsFromHtml(text, {
        creatorHandle,
        pageUrl,
        shortcode: normalized.shortcode,
        relayMedia,
      });
    }
  }

  if (assets.length === 0) {
    if (looksLikeThreadsUnavailable(text)) {
      throw new AppError(ErrorCode.NO_MEDIA_FOUND, "没有找到这个公开的 Threads 帖子。", 404);
    }

    throw new AppError(
      ErrorCode.NO_MEDIA_FOUND,
      "Threads 页面中没有发现可下载媒体。",
      404,
      {
        ...threadsHtmlDiagnostics(text),
        graphql_debug: graphqlDebug,
        rendered_debug: renderedDebug,
      },
    );
  }

  return {
    assets,
    metrics,
    creator_handle: creatorHandle,
    post_info: threadsPostInfoFromHtml(text, metrics, creatorHandle, relayMedia),
  };
}

function threadsAssetsFromHtml(html, options = {}) {
  const filenameBase = `threads_${safeFilenamePart(options.creatorHandle || "post")}_${options.shortcode}`;
  const tagAssets = selectPrimaryThreadsTagAssets(parseThreadsMediaTagAssets(html));
  const relayAssets = options.relayMedia
    ? parseAssetsFromInstagramData(options.relayMedia)
    : [];
  const relayFallbackAssets = relayAssets.length === 0 && options.relayMedia
    ? threadsAssetsFromRelayMedia(options.relayMedia)
    : [];

  if (tagAssets.length > 0) {
    return dedupeAssets(
      tagAssets.map((asset, index) => ({
        ...asset,
        filename_hint: `${filenameBase}_${index + 1}`,
        request_headers: threadsMediaHeaders(options.pageUrl),
      })),
    );
  }

  if (relayAssets.length > 0) {
    return dedupeAssets(
      relayAssets.map((asset, index) => ({
        ...asset,
        filename_hint: `${filenameBase}_${index + 1}`,
        request_headers: threadsMediaHeaders(options.pageUrl),
      })),
    );
  }

  if (relayFallbackAssets.length > 0) {
    return dedupeAssets(
      relayFallbackAssets.map((asset, index) => ({
        ...asset,
        filename_hint: `${filenameBase}_${index + 1}`,
        request_headers: threadsMediaHeaders(options.pageUrl),
      })),
    );
  }

  // Threads permalink pages often embed related-post media and multiple CDN size
  // variants in scripts. Falling back to whole-page media extraction creates slow,
  // noisy results, so we only trust relay data or rendered primary tags here.
  return [];
}

 function threadsMetricsFromHtml(html, relayMedia = null) {
  const metrics = relayMedia ? parseMetricsFromInstagramData(relayMedia) : createMetrics();
  const htmlMetrics = parseMetricsFromHtml(html) || createMetrics();

  metrics.like_count ??= htmlMetrics.like_count;
  metrics.comment_count ??= htmlMetrics.comment_count;
  metrics.view_count ??= htmlMetrics.view_count;
  metrics.save_count ??= htmlMetrics.save_count;
  metrics.share_count ??= htmlMetrics.share_count;

  metrics.like_count ??= firstJsonCount(html, [
    "like_count",
    "likes_count",
    "favorite_count",
    "favorites_count",
    "reaction_count",
  ]);
  metrics.comment_count ??= firstJsonCount(html, [
    "comment_count",
    "comments_count",
    "reply_count",
    "replies_count",
  ]);
  metrics.view_count ??= firstJsonCount(html, [
    "view_count",
    "views_count",
    "play_count",
    "video_view_count",
  ]);
  metrics.share_count ??= firstJsonCount(html, [
    "share_count",
    "shares_count",
    "repost_count",
    "reshare_count",
    "quote_count",
  ]);

  metrics.like_count ??= firstRegexInt(html, /"like_count"\s*:\s*(\d+)/);
  metrics.comment_count ??= firstRegexInt(html, /"(?:comment|reply)_count"\s*:\s*(\d+)/);
  metrics.view_count ??= firstRegexInt(html, /"(?:view|play)_count"\s*:\s*(\d+)/);
  metrics.share_count ??= firstRegexInt(html, /"(?:share|repost|reshare)_count"\s*:\s*(\d+)/);
  metrics.source = "threads_public_best_effort";

  return metrics;
}

function threadsPostInfoFromHtml(html, metrics, creatorHandle, relayMedia = null) {
  if (relayMedia) {
    const relayPostInfo = parsePostInfoFromInstagramData(relayMedia, { metrics, creatorHandle });

    if (relayPostInfo.body || relayPostInfo.title || relayPostInfo.author || relayPostInfo.author_handle) {
      return createPostInfo(
        {
          ...relayPostInfo,
          title: cleanThreadsTitle(relayPostInfo.title),
          body: cleanThreadsBody(relayPostInfo.body),
          metrics,
          source: metrics?.source || "threads_public_best_effort",
        },
        {
          metrics,
          creatorHandle,
          source: metrics?.source || "threads_public_best_effort",
        },
      );
    }
  }

  const fallback = postInfoFromHtmlMeta(html, metrics, creatorHandle);
  const title = cleanThreadsTitle(fallback.title);
  const body = cleanThreadsBody(fallback.body);

  return createPostInfo(
    {
      ...fallback,
      title,
      author: pickSingleLineText(fallback.author, creatorHandle),
      author_handle: creatorHandle,
      body,
      tags: normalizeTags(fallback.tags, body),
      metrics,
      source: metrics?.source || "threads_public_best_effort",
    },
    {
      metrics,
      creatorHandle,
      source: metrics?.source || "threads_public_best_effort",
    },
  );
}

function threadsMediaHeaders(pageUrl) {
  return {
    "accept-language": THREADS_HEADERS["accept-language"],
    Referer: pageUrl || "https://www.threads.com/",
    Origin: "https://www.threads.com",
    "sec-fetch-dest": "empty",
    "sec-fetch-mode": "cors",
    "sec-fetch-site": "cross-site",
  };
}

function creatorHandleFromUrl(url) {
  try {
    const parsed = new URL(url);
    const firstPart = parsed.pathname.split("/").filter(Boolean)[0] || "";

    if (!firstPart.startsWith("@")) {
      return "";
    }

    const creatorHandle = firstPart.slice(1);

    return THREADS_HANDLE_RE.test(creatorHandle) ? creatorHandle : "";
  } catch {
    return "";
  }
}

function cleanThreadsTitle(value) {
  return String(value || "")
    .replace(/\s*[|•-]\s*Threads\s*$/i, "")
    .replace(/\s+on Threads\s*$/i, "")
    .trim();
}

function cleanThreadsBody(value) {
  return String(value || "")
    .replace(/\s+[|•-]\s*Threads\s*$/i, "")
    .trim();
}

function looksLikeThreadsUnavailable(html) {
  return [
    "this page isn't available",
    "this content isn't available",
    "the page may have been removed",
    "login_required",
    "not available right now",
  ].some((pattern) => html.toLowerCase().includes(pattern));
}

function shouldUseRenderedThreadsFallback(html, assets, relayMedia) {
  if (isDisabledValue(process.env.SOCIAL_RENDERED_THREADS_FALLBACK)) {
    return false;
  }

  if (relayMedia || assets.length > 0) {
    return false;
  }

  return (
    html.includes("cdninstagram.com") ||
    html.includes("ScheduledServerJS") ||
    /login|log in|sign up/i.test(html)
  );
}

function shouldEnhanceThreadsFromRenderedPage(html, relayMedia) {
  if (isDisabledValue(process.env.SOCIAL_RENDERED_THREADS_FALLBACK)) {
    return false;
  }

  if (!relayMedia) {
    return false;
  }

  return parseThreadsMediaTagAssets(html).length === 0;
}

async function fetchRenderedThreadsHtml(pageUrl, settings, debug = {}) {
  const chromePath = resolveChromePath();
  debug.chrome_path_found = Boolean(chromePath);

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
        "--virtual-time-budget=9000",
        pageUrl,
      ],
      {
        timeout: timeoutMs,
        maxBuffer: 30 * 1024 * 1024,
      },
    );

    debug.rendered_html_length = stdout.length;
    debug.rendered_has_video = stdout.includes("<video");
    debug.rendered_has_img = stdout.includes("<img");
    debug.rendered_has_mp4 = stdout.includes(".mp4");
    debug.rendered_cdninstagram_count = countOccurrences(stdout, "cdninstagram.com");

    return stdout;
  } catch (error) {
    debug.render_failed = true;
    debug.render_error = error instanceof Error ? error.message : String(error);
    return "";
  }
}

async function requestThreadsRelayMedia(html, pageUrl, shortcode, settings, debug = {}, targetPostID = "") {
  const preloader = findThreadsGraphqlPreloader(html) || defaultThreadsGraphqlPreloader(shortcode);
  debug.preloader = preloader
    ? {
        preloader_id: preloader.preloaderID,
        query_id: preloader.queryID,
        query_name: preloader.queryName,
        variable_keys: Object.keys(preloader.variables || {}),
      }
    : null;

  if (!preloader?.queryID || !preloader?.queryName || !preloader?.variables) {
    return null;
  }

  const endpoint = new URL("/api/graphql/", pageUrl).toString();
  const lsd = extractThreadsLsdToken(html);
  debug.endpoint = endpoint;
  debug.lsd_present = Boolean(lsd);
  const body = new URLSearchParams();

  body.set("fb_api_caller_class", "RelayModern");
  body.set("fb_api_req_friendly_name", preloader.queryName);
  body.set("variables", JSON.stringify(preloader.variables));
  body.set("server_timestamps", "true");
  body.set("doc_id", preloader.queryID);

  if (lsd) {
    body.set("lsd", lsd);
  }

  try {
    const response = await fetchWithTimeout(
      endpoint,
      {
        method: "POST",
        headers: {
          ...THREADS_HEADERS,
          accept: "*/*",
          "content-type": "application/x-www-form-urlencoded",
          "x-fb-friendly-name": preloader.queryName,
          ...(lsd ? { "x-fb-lsd": lsd } : {}),
        },
        body: body.toString(),
        cache: "no-store",
      },
      settings.httpTimeoutMs,
    );
    debug.response_status = response.status;
    const payload = await responseJson(response);
    debug.response_keys = payload && typeof payload === "object" ? Object.keys(payload).slice(0, 12) : [];

    return findThreadsRelayMediaInValue(payload, {
      shortcode,
      postID: targetPostID || threadsPostIdFromShortcode(shortcode),
    });
  } catch {
    debug.request_failed = true;
    return null;
  }
}

function findThreadsRelayMedia(html, target = {}) {
  for (const text of scriptTexts(html)) {
    if (!text || (!text.includes("RelayPrefetchedStreamCache") && !text.includes("carousel_media"))) {
      continue;
    }

    for (const value of loadsJsonValues(text)) {
      const media = findThreadsRelayMediaInValue(value, target);

      if (media) {
        return media;
      }
    }
  }

  return null;
}

function findThreadsGraphqlPreloader(html) {
  for (const text of scriptTexts(html)) {
    if (!text || !text.includes("BarcelonaPermalinkMobilePostColumnPageQueryRelayPreloader")) {
      continue;
    }

    for (const value of loadsJsonValues(text)) {
      const preloader = findThreadsGraphqlPreloaderInValue(value);

      if (preloader) {
        return preloader;
      }
    }
  }

  return null;
}

function defaultThreadsGraphqlPreloader(shortcode) {
  const postID = threadsPostIdFromShortcode(shortcode);

  if (!postID) {
    return null;
  }

  return {
    preloaderID: "default_BarcelonaPermalinkMobilePostColumnPageQueryRelayPreloader",
    queryID: "27242423648710139",
    queryName: "BarcelonaPermalinkMobilePostColumnPageQuery",
    variables: {
      postID,
      __relay_internal__pv__BarcelonaHasInlineReplyComposerrelayprovider: false,
      __relay_internal__pv__BarcelonaHasDearAlgoConsumptionrelayprovider: true,
      __relay_internal__pv__BarcelonaIsLoggedInrelayprovider: false,
      __relay_internal__pv__BarcelonaHasEventBadgerelayprovider: false,
      __relay_internal__pv__BarcelonaGenAIRepliesEnabledrelayprovider: false,
      __relay_internal__pv__BarcelonaIsSearchDiscoveryEnabledrelayprovider: false,
      __relay_internal__pv__BarcelonaHasCommunitiesrelayprovider: true,
      __relay_internal__pv__BarcelonaHasGameScoreSharerelayprovider: true,
      __relay_internal__pv__BarcelonaHasPublicViewCountCardrelayprovider: true,
      __relay_internal__pv__BarcelonaHasCommunityEntityCardrelayprovider: false,
      __relay_internal__pv__BarcelonaHasScorecardCommunityrelayprovider: false,
      __relay_internal__pv__BarcelonaHasSportTeamAllegianceCardrelayprovider: false,
      __relay_internal__pv__BarcelonaHasMusicrelayprovider: true,
      __relay_internal__pv__BarcelonaHasNewspaperLinkStylerelayprovider: false,
      __relay_internal__pv__BarcelonaMessagingHasGroupChatsrelayprovider: false,
      __relay_internal__pv__BarcelonaHasMessagingrelayprovider: false,
      __relay_internal__pv__BarcelonaHasViewerRepliedrelayprovider: true,
      __relay_internal__pv__BarcelonaHasGhostPostEmojiActivationrelayprovider: false,
      __relay_internal__pv__BarcelonaOptionalCookiesEnabledrelayprovider: true,
      __relay_internal__pv__BarcelonaHasDearAlgoWebProductionrelayprovider: false,
      __relay_internal__pv__BarcelonaHasWebFaviconsrelayprovider: false,
      __relay_internal__pv__BarcelonaIsCrawlerrelayprovider: false,
      __relay_internal__pv__BarcelonaHasCommunityTopContributorsrelayprovider: false,
      __relay_internal__pv__BarcelonaCanSeeSponsoredContentrelayprovider: false,
      __relay_internal__pv__BarcelonaShouldShowFediverseM075Featuresrelayprovider: false,
      __relay_internal__pv__BarcelonaIsInternalUserrelayprovider: false,
    },
  };
}

function findThreadsGraphqlPreloaderInValue(value, seen = new WeakSet(), depth = 0) {
  if (!value || typeof value !== "object" || depth > 10 || seen.has(value)) {
    return null;
  }

  seen.add(value);

  if (Array.isArray(value)) {
    for (const item of value) {
      const nested = findThreadsGraphqlPreloaderInValue(item, seen, depth + 1);

      if (nested) {
        return nested;
      }
    }

    return null;
  }

  if (
    typeof value.preloaderID === "string" &&
    value.preloaderID.includes("BarcelonaPermalinkMobilePostColumnPageQueryRelayPreloader") &&
    typeof value.queryID === "string" &&
    value.variables &&
    typeof value.queryName === "string"
  ) {
    return value;
  }

  for (const child of Object.values(value)) {
    const nested = findThreadsGraphqlPreloaderInValue(child, seen, depth + 1);

    if (nested) {
      return nested;
    }
  }

  return null;
}

function findThreadsRelayMediaInValue(value, target = {}, seen = new WeakSet(), depth = 0) {
  if (!value || typeof value !== "object" || depth > 12 || seen.has(value)) {
    return null;
  }

  seen.add(value);
  let best = null;
  let bestScore = -1;

  if (Array.isArray(value)) {
    for (const item of value) {
      const nested = findThreadsRelayMediaInValue(item, target, seen, depth + 1);

      if (nested) {
        const score = scoreThreadsRelayMediaCandidate(nested, target);

        if (score > bestScore) {
          best = nested;
          bestScore = score;
        }
      }
    }

    return best;
  }

  if (looksLikeThreadsRelayMedia(value)) {
    best = value;
    bestScore = scoreThreadsRelayMediaCandidate(value, target);
  }

  for (const child of Object.values(value)) {
    const nested = findThreadsRelayMediaInValue(child, target, seen, depth + 1);

    if (nested) {
      const score = scoreThreadsRelayMediaCandidate(nested, target);

      if (score > bestScore) {
        best = nested;
        bestScore = score;
      }
    }
  }

  return best;
}

function looksLikeThreadsRelayMedia(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  return (
    Array.isArray(value.carousel_media) ||
    value.image_versions2 ||
    Array.isArray(value.video_versions) ||
    (value.text_post_app_info && value.user && value.pk)
  );
}

function scoreThreadsRelayMediaCandidate(value, target = {}) {
  if (!looksLikeThreadsRelayMedia(value)) {
    return -1;
  }

  let score = 0;
  const candidateText = serializeThreadsCandidate(value);

  if (target.postID && candidateText.includes(target.postID)) {
    score += 10_000;
  }

  if (target.shortcode && candidateText.includes(target.shortcode)) {
    score += 2_000;
  }

  if (Array.isArray(value.carousel_media) && value.carousel_media.length > 0) {
    score += 200;
  }

  if (Array.isArray(value.video_versions) && value.video_versions.length > 0) {
    score += 120;
  }

  if (value.image_versions2) {
    score += 80;
  }

  if (value.text_post_app_info && value.user && value.pk) {
    score += 40;
  }

  return score + threadsAssetScore(value);
}

function serializeThreadsCandidate(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return "";
  }
}

function extractThreadsLsdToken(html) {
  for (const pattern of [
    /\["LSD"\s*,\s*\[\]\s*,\s*\{"token":"([^"]+)"\}/,
    /"LSD",\[\],\{"token":"([^"]+)"/,
    /"token":"([^"]+)","__bbox"/,
  ]) {
    const match = pattern.exec(html);

    if (match?.[1]) {
      return match[1];
    }
  }

  return "";
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

function isDisabledValue(value) {
  return /^(?:0|false|no|off|disabled)$/i.test(String(value || "").trim());
}

function threadsPostIdFromShortcode(shortcode) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  let mediaId = 0n;

  for (const character of String(shortcode || "")) {
    const value = alphabet.indexOf(character);

    if (value < 0) {
      return "";
    }

    mediaId = mediaId * 64n + BigInt(value);
  }

  return mediaId > 0n ? mediaId.toString() : "";
}

function threadsHtmlDiagnostics(html) {
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] || "";
  const ogTitle = /<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']*)["']/i.exec(html)?.[1] || "";
  const bodySnippet = htmlUnescape(String(html).slice(0, 2000)).replace(/\s+/g, " ").trim();

  return {
    html_length: html.length,
    title: cleanThreadsTitle(htmlUnescape(title)),
    og_title: cleanThreadsTitle(htmlUnescape(ogTitle)),
    has_video_tag: html.includes("<video"),
    has_img_tag: html.includes("<img"),
    has_mp4: html.includes(".mp4"),
    has_srcset: html.includes("srcset="),
    has_cdninstagram: html.includes("cdninstagram.com"),
    has_login_text: /login|log in|登录/i.test(html),
    occurrence_counts: {
      cdninstagram: countOccurrences(html, "cdninstagram.com"),
      image_versions2: countOccurrences(html, "image_versions2"),
      video_versions: countOccurrences(html, "video_versions"),
      relay_prefetched_stream_cache: countOccurrences(html, "RelayPrefetchedStreamCache"),
      xdt_shortcode_media: countOccurrences(html, "xdt_shortcode_media"),
      scheduled_server_js: countOccurrences(html, "ScheduledServerJS"),
      polarisviewer: countOccurrences(html, "PolarisViewer"),
    },
    snippets: {
      cdninstagram: htmlContextSnippets(html, "cdninstagram.com"),
      image_versions2: htmlContextSnippets(html, "image_versions2"),
      video_versions: htmlContextSnippets(html, "video_versions"),
      relay_prefetched_stream_cache: htmlContextSnippets(html, "RelayPrefetchedStreamCache"),
      xdt_shortcode_media: htmlContextSnippets(html, "xdt_shortcode_media"),
    },
    body_snippet: bodySnippet,
  };
}

function countOccurrences(text, needle) {
  if (!needle) {
    return 0;
  }

  let count = 0;
  let fromIndex = 0;

  while (fromIndex >= 0) {
    const index = text.indexOf(needle, fromIndex);

    if (index < 0) {
      break;
    }

    count += 1;
    fromIndex = index + needle.length;
  }

  return count;
}

function htmlContextSnippets(text, needle, radius = 220, limit = 3) {
  if (!needle) {
    return [];
  }

  const snippets = [];
  let fromIndex = 0;

  while (snippets.length < limit) {
    const index = text.indexOf(needle, fromIndex);

    if (index < 0) {
      break;
    }

    const start = Math.max(0, index - radius);
    const end = Math.min(text.length, index + needle.length + radius);
    snippets.push(
      htmlUnescape(text.slice(start, end)).replace(/\s+/g, " ").trim(),
    );
    fromIndex = index + needle.length;
  }

  return snippets;
}

function parseThreadsMediaTagAssets(html) {
  const assets = [];

  for (const match of html.matchAll(/<(video|source)\b[^>]*>/gi)) {
    const tag = match[0];
    const attrs = htmlAttributes(tag);
    const src = pickSingleLineText(attrs.src, attrs["data-src"]);

    if (!looksLikeMediaUrl(src, "video")) {
      continue;
    }

    assets.push({
      source_url: src,
      media_type: "video",
      width: optionalDimension(attrs.width),
      height: optionalDimension(attrs.height),
      _index: match.index ?? 0,
      _is_cover: false,
    });
  }

  for (const match of html.matchAll(/<img\b[^>]*>/gi)) {
    const tag = match[0];
    const attrs = htmlAttributes(tag);
    const srcsetCandidate = bestSrcsetCandidate(attrs.srcset);
    const sourceUrl = pickSingleLineText(srcsetCandidate?.url, attrs.src, attrs["data-src"]);
    const width = maxDimension(
      optionalDimension(attrs.width),
      optionalDimension(attrs["data-width"]),
      srcsetCandidate?.width ?? null,
    );
    const height = maxDimension(
      optionalDimension(attrs.height),
      optionalDimension(attrs["data-height"]),
      srcsetCandidate?.height ?? null,
    );
    const alt = pickSingleLineText(attrs.alt);

    if (!looksLikeMediaUrl(sourceUrl, "image")) {
      continue;
    }

    if (looksLikeAvatarAlt(alt)) {
      continue;
    }

    if (!looksLikePrimaryImageAsset(sourceUrl, width, height, attrs.srcset || "")) {
      continue;
    }

    assets.push({
      source_url: sourceUrl,
      media_type: "image",
      width,
      height,
      _index: match.index ?? 0,
      _is_cover: looksLikeVideoCoverImage(sourceUrl),
    });
  }

  return assets;
}

function threadsAssetsFromRelayMedia(media) {
  const items = Array.isArray(media?.carousel_media) && media.carousel_media.length > 0
    ? media.carousel_media
    : [media];
  const assets = [];

  for (const item of items) {
    const video = bestThreadsVideoAsset(item);

    if (video) {
      assets.push(video);
      continue;
    }

    const image = bestThreadsImageAsset(item);

    if (image) {
      assets.push(image);
    }
  }

  return assets;
}

function bestThreadsVideoAsset(item) {
  const versions = Array.isArray(item?.video_versions) ? item.video_versions : [];

  if (versions.length === 0) {
    return null;
  }

  const best = versions
    .filter((version) => typeof version?.url === "string" && /^https?:\/\//i.test(version.url))
    .sort((left, right) => threadsAssetScore(right) - threadsAssetScore(left))[0];

  if (!best?.url) {
    return null;
  }

  return {
    source_url: best.url,
    media_type: "video",
    width: optionalDimension(best.width),
    height: optionalDimension(best.height),
  };
}

function bestThreadsImageAsset(item) {
  const candidates = Array.isArray(item?.image_versions2?.candidates)
    ? item.image_versions2.candidates
    : [];

  if (candidates.length === 0) {
    return null;
  }

  const best = candidates
    .filter((candidate) => typeof candidate?.url === "string" && /^https?:\/\//i.test(candidate.url))
    .sort((left, right) => threadsAssetScore(right) - threadsAssetScore(left))[0];

  if (!best?.url) {
    return null;
  }

  return {
    source_url: best.url,
    media_type: "image",
    width: optionalDimension(best.width),
    height: optionalDimension(best.height),
  };
}

function threadsAssetScore(value) {
  const width = optionalDimension(value?.width) || 0;
  const height = optionalDimension(value?.height) || 0;

  return width * height;
}

function selectPrimaryThreadsTagAssets(assets) {
  if (!Array.isArray(assets) || assets.length === 0) {
    return [];
  }

  const ordered = assets
    .filter((asset) => asset?.source_url)
    .sort((left, right) => (left._index || 0) - (right._index || 0));
  const firstVideo = ordered.find((asset) => asset.media_type === "video");
  let focused = ordered;

  if (firstVideo) {
    focused = ordered.filter((asset) =>
      Math.abs((asset._index || 0) - firstVideo._index) <= THREADS_PRIMARY_MEDIA_CLUSTER_DISTANCE
    );
  }

  const hasVideo = focused.some((asset) => asset.media_type === "video");
  const hasNonCoverImage = focused.some((asset) => asset.media_type === "image" && !asset._is_cover);

  if (hasVideo && hasNonCoverImage) {
    focused = focused.filter((asset) => asset.media_type !== "image" || !asset._is_cover);
  }

  focused = dedupeThreadsPrimaryAssets(focused);

  return focused.map(({ _index, _is_cover, ...asset }) => asset);
}

function dedupeThreadsPrimaryAssets(assets) {
  const grouped = new Map();

  for (const asset of assets) {
    const key = threadsPrimaryAssetKey(asset);
    const current = grouped.get(key);

    if (!current || compareThreadsPrimaryAssets(asset, current) > 0) {
      grouped.set(key, asset);
    }
  }

  return [...grouped.values()].sort((left, right) => {
    if (left.media_type !== right.media_type) {
      return left.media_type === "video" ? -1 : 1;
    }

    return (left._index || 0) - (right._index || 0);
  });
}

function threadsPrimaryAssetKey(asset) {
  const url = String(asset?.source_url || "");
  const match = /[?&]ig_cache_key=([^&]+)/i.exec(url);

  if (match?.[1]) {
    return `${asset.media_type}:${decodeURIComponent(match[1])}`;
  }

  if (asset.media_type === "video") {
    return `${asset.media_type}:${url.replace(/[?&]oh=[^&]+/i, "").replace(/[?&]oe=[^&]+/i, "")}`;
  }

  return `${asset.media_type}:${url.split("?")[0]}`;
}

function compareThreadsPrimaryAssets(left, right) {
  const leftScore = [
    left.media_type === "video" ? 1 : 0,
    threadsAssetScore(left),
    left._is_cover ? 0 : 1,
  ];
  const rightScore = [
    right.media_type === "video" ? 1 : 0,
    threadsAssetScore(right),
    right._is_cover ? 0 : 1,
  ];

  for (let index = 0; index < leftScore.length; index += 1) {
    if (leftScore[index] !== rightScore[index]) {
      return leftScore[index] - rightScore[index];
    }
  }

  return 0;
}

function htmlAttributes(tag) {
  const attrs = {};
  const pattern = /([A-Za-z_:][-A-Za-z0-9_:.]*)\s*=\s*("([^"]*)"|'([^']*)')/g;
  let match;

  while ((match = pattern.exec(tag))) {
    const key = match[1].toLowerCase();
    const value = htmlUnescape(match[3] ?? match[4] ?? "");

    attrs[key] = value;
  }

  return attrs;
}

function bestSrcsetCandidate(srcset) {
  const candidates = String(srcset || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => {
      const [rawUrl, descriptor = ""] = item.split(/\s+/, 2);
      const widthMatch = /(\d+)w\b/i.exec(descriptor);

      return {
        url: htmlUnescape(rawUrl || ""),
        width: widthMatch ? Number.parseInt(widthMatch[1], 10) : null,
        height: null,
      };
    })
    .filter((item) => /^https?:\/\//i.test(item.url));

  if (candidates.length === 0) {
    return null;
  }

  return candidates.sort((left, right) => (right.width || 0) - (left.width || 0))[0];
}

function looksLikeMediaUrl(url, mediaType) {
  if (!/^https?:\/\//i.test(String(url || ""))) {
    return false;
  }

  const lowered = String(url).toLowerCase();

  if (mediaType === "video") {
    return lowered.includes(".mp4") || lowered.includes("/o1/v/") || lowered.includes("/t16/");
  }

  return lowered.includes(".jpg") ||
    lowered.includes(".jpeg") ||
    lowered.includes(".png") ||
    lowered.includes(".webp") ||
    lowered.includes("cdninstagram.com") ||
    lowered.includes("fbcdn.net");
}

function looksLikeAvatarAlt(alt) {
  const lowered = String(alt || "").toLowerCase();

  return lowered.includes("avatar") ||
    lowered.includes("头像") ||
    lowered.includes("profile picture") ||
    lowered.includes("profile pic");
}

function looksLikePrimaryImageAsset(url, width, height, srcset) {
  const maxSide = Math.max(width || 0, height || 0);

  if (maxSide >= 240) {
    return true;
  }

  if (String(srcset || "").includes(" 320w") || String(srcset || "").includes(" 480w") || String(srcset || "").includes(" 720w")) {
    return true;
  }

  return false;
}

function looksLikeVideoCoverImage(url) {
  const lowered = String(url || "").toLowerCase();

  return lowered.includes("video_default_cover_frame") ||
    lowered.includes("default_cover_frame") ||
    lowered.includes("cover_frame");
}

function optionalDimension(value) {
  const parsed = Number.parseInt(String(value || ""), 10);

  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function maxDimension(...values) {
  const normalized = values.filter((value) => Number.isFinite(value) && value > 0);

  return normalized.length > 0 ? Math.max(...normalized) : null;
}
