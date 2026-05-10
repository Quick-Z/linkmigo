import { URL, URLSearchParams } from "node:url";

import { AppError, ErrorCode } from "./errors";
import {
  cleanUrl,
  dedupeAssets,
  dig,
  fetchText,
  fetchTextResponse,
  fetchWithTimeout,
  firstPresentInt,
  hasMetricValues,
  htmlUnescape,
  jsonBetween,
  jsonFromScriptId,
  metaContents,
  optionalInt,
  PAGE_HEADERS,
  responseJson,
} from "./utils";
import { normalizeInstagramUrl, resolveInstagramPost } from "./instagram";

const BILIBILI_HEADERS = {
  ...PAGE_HEADERS,
  "user-agent": "facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)",
};
const DOUYIN_MOBILE_HEADERS = {
  ...PAGE_HEADERS,
  "user-agent":
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
  accept:
    "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
  "accept-language": "zh-CN,zh;q=0.9,en;q=0.8",
};

const TWITTER_BEARER_TOKEN =
  "AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D" +
  "1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA";
const TWITTER_TOKEN_URL = "https://api.x.com/1.1/guest/activate.json";
const TWITTER_GRAPHQL_URL = "https://api.x.com/graphql/4Siu98E55GquhG52zHdY5w/TweetDetail";
const TWITTER_FEATURES = {
  rweb_video_screen_enabled: false,
  payments_enabled: false,
  rweb_xchat_enabled: false,
  profile_label_improvements_pcf_label_in_post_enabled: true,
  rweb_tipjar_consumption_enabled: true,
  verified_phone_label_enabled: false,
  creator_subscriptions_tweet_preview_api_enabled: true,
  responsive_web_graphql_timeline_navigation_enabled: true,
  responsive_web_graphql_skip_user_profile_image_extensions_enabled: false,
  premium_content_api_read_enabled: false,
  communities_web_enable_tweet_community_results_fetch: true,
  c9s_tweet_anatomy_moderator_badge_enabled: true,
  responsive_web_grok_analyze_button_fetch_trends_enabled: false,
  responsive_web_grok_analyze_post_followups_enabled: true,
  responsive_web_jetfuel_frame: true,
  responsive_web_grok_share_attachment_enabled: true,
  articles_preview_enabled: true,
  responsive_web_edit_tweet_api_enabled: true,
  graphql_is_translatable_rweb_tweet_is_translatable_enabled: true,
  view_counts_everywhere_api_enabled: true,
  longform_notetweets_consumption_enabled: true,
  responsive_web_twitter_article_tweet_consumption_enabled: true,
  tweet_awards_web_tipping_enabled: false,
  responsive_web_grok_show_grok_translated_post: false,
  responsive_web_grok_analysis_button_from_backend: true,
  creator_subscriptions_quote_tweet_preview_enabled: false,
  freedom_of_speech_not_reach_fetch_enabled: true,
  standardized_nudges_misinfo: true,
  tweet_with_visibility_results_prefer_gql_limited_actions_policy_enabled: true,
  longform_notetweets_rich_text_read_enabled: true,
  longform_notetweets_inline_media_enabled: true,
  responsive_web_grok_image_annotation_enabled: true,
  responsive_web_grok_imagine_annotation_enabled: true,
  responsive_web_grok_community_note_auto_translation_is_enabled: false,
  responsive_web_enhance_cards_enabled: false,
};
const TWITTER_FIELD_TOGGLES = {
  withArticleRichContentState: true,
  withArticlePlainText: false,
  withGrokAnalyze: false,
  withDisallowedReplyControls: false,
};

let twitterGuestToken = "";

export function normalizeSocialUrl(rawUrl) {
  let value = String(rawUrl ?? "").trim();

  if (!value) {
    throw new AppError(ErrorCode.UNSUPPORTED_URL, "请输入需要解析的公开帖子链接。", 400);
  }

  if (!value.includes("://")) {
    value = `https://${value}`;
  }

  let parsed;

  try {
    parsed = new URL(value);
  } catch {
    throw new AppError(
      ErrorCode.UNSUPPORTED_URL,
      "暂时支持 Instagram、TikTok、抖音、Twitter/X、Bilibili、Facebook 的公开链接。",
      400,
    );
  }

  const host = parsed.hostname.toLowerCase();

  if (isInstagramHost(host)) {
    const normalized = normalizeInstagramUrl(value);

    return {
      ...normalized,
      platform: "instagram",
    };
  }

  if (isTiktokHost(host)) {
    return normalizeTiktokUrl(parsed);
  }

  if (isDouyinHost(host)) {
    return normalizeDouyinUrl(parsed);
  }

  if (isTwitterHost(host)) {
    return normalizeTwitterUrl(parsed);
  }

  if (isBilibiliHost(host)) {
    return normalizeBilibiliUrl(parsed);
  }

  if (isFacebookHost(host)) {
    return normalizeFacebookUrl(parsed);
  }

  throw new AppError(
    ErrorCode.UNSUPPORTED_URL,
    "暂时支持 Instagram、TikTok、抖音、Twitter/X、Bilibili、Facebook 的公开链接。",
    400,
  );
}

export async function resolveSocialPost(normalized, settings) {
  if (normalized.platform === "instagram") {
    return await resolveInstagramPost(normalized, settings);
  }

  if (normalized.platform === "tiktok") {
    return await resolveTiktokPost(normalized, settings);
  }

  if (normalized.platform === "douyin") {
    return await resolveDouyinPost(normalized, settings);
  }

  if (normalized.platform === "twitter") {
    return await resolveTwitterPost(normalized, settings);
  }

  if (normalized.platform === "bilibili") {
    return await resolveBilibiliPost(normalized, settings);
  }

  if (normalized.platform === "facebook") {
    return await resolveFacebookPost(normalized, settings);
  }

  throw new AppError(ErrorCode.UNSUPPORTED_URL, "这个平台暂未接入解析器。", 400);
}

function normalizeTiktokUrl(parsed) {
  const parts = parsed.pathname.split("/").filter(Boolean);
  let postId = "";
  let kind = "video";

  for (let index = 0; index < parts.length; index += 1) {
    if (["video", "photo"].includes(parts[index]) && parts[index + 1]) {
      postId = parts[index + 1];
      kind = parts[index];
      break;
    }
  }

  if (!postId && parts.length >= 2 && parts[0] === "v" && parts[1].endsWith(".html")) {
    postId = parts[1].replace(/\.html$/, "");
  }

  if (postId) {
    return {
      canonical_url: `https://www.tiktok.com/@i/video/${postId}`,
      shortcode: postId,
      kind,
      platform: "tiktok",
    };
  }

  const shortCode = parts[0] ?? "";

  if (["vt.tiktok.com", "vm.tiktok.com", "t.tiktok.com"].includes(parsed.hostname.toLowerCase()) && shortCode) {
    return {
      canonical_url: cleanUrl(parsed),
      shortcode: shortCode,
      kind: "short",
      platform: "tiktok",
    };
  }

  throw new AppError(ErrorCode.UNSUPPORTED_URL, "仅支持 TikTok 视频、图集或短链接。", 400);
}

function normalizeDouyinUrl(parsed) {
  const parts = parsed.pathname.split("/").filter(Boolean);
  const host = parsed.hostname.toLowerCase();
  let postId = "";

  for (let index = 0; index < parts.length; index += 1) {
    if (["video", "note"].includes(parts[index]) && parts[index + 1]) {
      postId = parts[index + 1];
      break;
    }
  }

  if (postId && /^\d{8,32}$/.test(postId)) {
    return {
      canonical_url: `https://www.iesdouyin.com/share/video/${postId}/`,
      shortcode: postId,
      kind: "video",
      platform: "douyin",
    };
  }

  const shortCode = parts[0] ?? "";

  if (host === "v.douyin.com" && shortCode) {
    return {
      canonical_url: cleanUrl(parsed),
      shortcode: shortCode,
      kind: "short",
      platform: "douyin",
    };
  }

  throw new AppError(ErrorCode.UNSUPPORTED_URL, "仅支持抖音视频或 v.douyin.com 短链接。", 400);
}

function normalizeTwitterUrl(parsed) {
  const parts = parsed.pathname.split("/").filter(Boolean);
  let tweetId = "";
  let username = "i";

  if (parsed.pathname === "/i/bookmarks") {
    tweetId = parsed.searchParams.get("post_id") ?? "";
  } else if (parts.length >= 3 && parts[1] === "status") {
    username = parts[0];
    tweetId = parts[2];
  }

  if (!/^\d{5,32}$/.test(tweetId)) {
    throw new AppError(ErrorCode.UNSUPPORTED_URL, "仅支持 Twitter/X 的公开帖子链接。", 400);
  }

  return {
    canonical_url: `https://twitter.com/${username}/status/${tweetId}`,
    shortcode: tweetId,
    kind: "status",
    platform: "twitter",
  };
}

function normalizeBilibiliUrl(parsed) {
  const parts = parsed.pathname.split("/").filter(Boolean);
  const host = parsed.hostname.toLowerCase();

  if (host === "b23.tv" && parts[0]) {
    return {
      canonical_url: cleanUrl(parsed),
      shortcode: parts[0],
      kind: "short",
      platform: "bilibili",
    };
  }

  if (parts.length >= 2 && parts[0] === "video") {
    const videoId = parts[1];
    const partId = parsed.searchParams.get("p");
    const canonical = new URL(`https://www.bilibili.com/video/${videoId}`);

    if (partId) {
      canonical.searchParams.set("p", partId);
    }

    return {
      canonical_url: canonical.toString(),
      shortcode: videoId,
      kind: "video",
      platform: "bilibili",
    };
  }

  throw new AppError(ErrorCode.UNSUPPORTED_URL, "仅支持 Bilibili 视频或 b23.tv 短链接。", 400);
}

function normalizeFacebookUrl(parsed) {
  const parts = parsed.pathname.split("/").filter(Boolean);
  const host = parsed.hostname.toLowerCase();

  if (host === "fb.watch" && parts[0]) {
    return {
      canonical_url: cleanUrl(parsed),
      shortcode: parts[0],
      kind: "short",
      platform: "facebook",
    };
  }

  if (parts.length >= 2 && parts[0] === "reel") {
    return {
      canonical_url: `https://www.facebook.com/reel/${parts[1]}`,
      shortcode: parts[1],
      kind: "reel",
      platform: "facebook",
    };
  }

  if (parts.length >= 3 && parts[0] === "share") {
    return {
      canonical_url: cleanUrl(parsed),
      shortcode: parts.at(-1),
      kind: `share-${parts[1]}`,
      platform: "facebook",
    };
  }

  if (parts.length >= 3 && parts[1] === "videos") {
    return {
      canonical_url: cleanUrl(parsed),
      shortcode: parts.at(-1),
      kind: "video",
      platform: "facebook",
    };
  }

  throw new AppError(ErrorCode.UNSUPPORTED_URL, "仅支持 Facebook Reel、视频或分享短链接。", 400);
}

async function resolveTiktokPost(normalized, settings) {
  let postId = normalized.shortcode;

  if (normalized.kind === "short") {
    const redirected = await resolveRedirect(normalized.canonical_url, settings);

    if (redirected) {
      postId = normalizeSocialUrl(redirected).shortcode;
    }
  }

  if (!postId) {
    throw new AppError(ErrorCode.NO_MEDIA_FOUND, "TikTok 短链接没有解析到帖子 ID。", 404);
  }

  const pageUrl = `https://www.tiktok.com/@i/video/${postId}`;
  const pageResponse = await fetchTextResponse({
    url: pageUrl,
    headers: PAGE_HEADERS,
    label: "TikTok",
    timeoutMs: settings.httpTimeoutMs,
  });
  const text = pageResponse.text;
  const mediaHeaders = tiktokMediaHeaders(pageUrl, cookieHeaderFromSetCookie(pageResponse.headers));
  const data = jsonFromScriptId(text, "__UNIVERSAL_DATA_FOR_REHYDRATION__");
  const detail = dig(data, "__DEFAULT_SCOPE__", "webapp.video-detail", "itemInfo", "itemStruct");

  if (!detail || typeof detail !== "object") {
    throw new AppError(ErrorCode.NO_MEDIA_FOUND, "TikTok 页面中没有发现可展示资源。", 404);
  }

  if (detail.isContentClassified) {
    throw new AppError(ErrorCode.LOGIN_REQUIRED, "这个 TikTok 内容需要登录或年龄验证。", 403);
  }

  const author = dig(detail, "author", "uniqueId") || "unknown";
  const filenameBase = `tiktok_${author}_${postId}`;
  const assets = [];
  const images = dig(detail, "imagePost", "images");

  if (Array.isArray(images) && images.length > 0) {
    images.forEach((imageData, index) => {
      const imageUrl = bestTiktokImageUrl(imageData);

      if (imageUrl) {
        assets.push({
          source_url: imageUrl,
          media_type: "image",
          filename_hint: `${filenameBase}_photo_${index + 1}.jpg`,
          request_headers: mediaHeaders,
        });
      }
    });

    const audioUrl = dig(detail, "music", "playUrl");

    if (typeof audioUrl === "string" && audioUrl.startsWith("http")) {
      assets.push({
        source_url: htmlUnescape(audioUrl),
        media_type: "audio",
        filename_hint: `${filenameBase}_audio.m4a`,
        request_headers: mediaHeaders,
      });
    }
  } else {
    const videoUrls = tiktokVideoUrls(detail);
    const videoUrl = videoUrls[0];

    if (videoUrl) {
      assets.push({
        source_url: videoUrl,
        fallback_urls: videoUrls.slice(1),
        media_type: "video",
        width: optionalInt(dig(detail, "video", "width")),
        height: optionalInt(dig(detail, "video", "height")),
        filename_hint: `${filenameBase}.mp4`,
        request_headers: mediaHeaders,
      });
    }
  }

  return {
    assets: dedupeAssets(assets),
    metrics: metricsFromTiktok(detail),
    creator_handle: author,
  };
}

async function resolveDouyinPost(normalized, settings) {
  let postId = normalized.shortcode;

  if (normalized.kind === "short") {
    const redirected = await resolveRedirect(normalized.canonical_url, settings);

    if (redirected) {
      postId = normalizeSocialUrl(redirected).shortcode;
    }
  }

  if (!/^\d{8,32}$/.test(postId)) {
    throw new AppError(ErrorCode.NO_MEDIA_FOUND, "抖音短链接没有解析到视频 ID。", 404);
  }

  const pageUrl = `https://www.iesdouyin.com/share/video/${postId}/?from=web_code_link`;
  const text = await fetchText({
    url: pageUrl,
    headers: DOUYIN_MOBILE_HEADERS,
    label: "Douyin",
    timeoutMs: settings.httpTimeoutMs,
  });
  const routerData = jsonFromAssignment(text, "window._ROUTER_DATA");
  const detail = firstDouyinItem(routerData);

  if (!detail) {
    throw new AppError(
      ErrorCode.NO_MEDIA_FOUND,
      "抖音分享页中没有发现可展示资源。",
      404,
    );
  }

  const author = detail.author && typeof detail.author === "object" ? detail.author : {};
  const handle = author.unique_id || author.short_id || author.nickname || "unknown";
  const filenameBase = `douyin_${safeFilenamePart(handle)}_${postId}`;
  const mediaHeaders = douyinMediaHeaders(pageUrl);
  const assets = douyinAssetsFromDetail(detail, filenameBase, mediaHeaders);

  return {
    assets: dedupeAssets(assets),
    metrics: metricsFromDouyin(detail),
    creator_handle: handle,
  };
}

async function resolveTwitterPost(normalized, settings) {
  const tweetId = normalized.shortcode;
  let token = await getTwitterGuestToken(settings);
  let data = null;

  if (token) {
    data = await requestTwitterGraphql(tweetId, token, settings);

    if (!data) {
      token = await getTwitterGuestToken(settings, true);
      data = token ? await requestTwitterGraphql(tweetId, token, settings) : null;
    }
  }

  const tweet = data ? extractTwitterTweet(data, tweetId) : null;
  let media = null;
  let metrics = createMetrics("twitter_public_best_effort");

  if (!tweet) {
    const syndication = await requestTwitterSyndication(tweetId, settings);

    media = Array.isArray(syndication?.mediaDetails) ? syndication.mediaDetails : null;
  } else {
    const legacy = tweet.legacy && typeof tweet.legacy === "object" ? tweet.legacy : {};

    media = dig(legacy, "extended_entities", "media");
    metrics = {
      like_count: optionalInt(legacy.favorite_count),
      comment_count: optionalInt(legacy.reply_count),
      view_count: optionalInt(dig(tweet, "views", "count")),
      save_count: null,
      share_count: firstPresentInt(legacy.retweet_count, legacy.quote_count),
      source: "twitter_public_best_effort",
    };
  }

  if (!Array.isArray(media) || media.length === 0) {
    throw new AppError(ErrorCode.NO_MEDIA_FOUND, "Twitter/X 帖子中没有发现可展示媒体。", 404);
  }

  const assets = [];

  media.forEach((item, index) => {
    if (!item || typeof item !== "object") {
      return;
    }

    if (item.type === "photo") {
      const imageUrl = item.media_url_https || item.media_url;

      if (imageUrl) {
        assets.push({
          source_url: `${imageUrl}?name=4096x4096`,
          media_type: "image",
          filename_hint: `twitter_${tweetId}_${index + 1}.jpg`,
        });
      }
    } else if (["video", "animated_gif"].includes(item.type)) {
      const videoUrl = bestTwitterVideoUrl(item);

      if (videoUrl) {
        assets.push({
          source_url: videoUrl,
          media_type: "video",
          filename_hint: `twitter_${tweetId}_${index + 1}.mp4`,
        });
      }
    }
  });

  return {
    assets: dedupeAssets(assets),
    metrics,
    creator_handle: normalized.canonical_url.includes("/status/") ? normalized.canonical_url.split("/")[3]?.replace("@", "") || "" : "",
  };
}

async function resolveBilibiliPost(normalized, settings) {
  let active = normalized;

  if (active.kind === "short") {
    const redirected = await resolveRedirect(active.canonical_url, settings);

    if (redirected) {
      active = normalizeSocialUrl(redirected);
    }
  }

  const referer = active.canonical_url;
  const text = await fetchText({
    url: active.canonical_url,
    headers: BILIBILI_HEADERS,
    label: "Bilibili",
    timeoutMs: settings.httpTimeoutMs,
  });
  const playinfo = jsonBetween(text, "<script>window.__playinfo__=", "</script>");
  const initialState = extractBilibiliInitialState(text);
  let metrics = metricsFromBilibili(initialState);
  let assets = assetsFromBilibiliPlayinfo(playinfo, active.shortcode, referer);

  if (assets.length === 0) {
    const apiData = await requestBilibiliPlayurl(active, settings);

    if (apiData) {
      if (!hasMetricValues(metrics)) {
        metrics = metricsFromBilibili(apiData.view);
      }

      assets = assetsFromBilibiliPlayinfo(apiData.play, active.shortcode, referer);
    }
  }

  if (assets.length === 0) {
    throw new AppError(ErrorCode.NO_MEDIA_FOUND, "Bilibili 页面中没有发现可展示资源。", 404);
  }

  return {
    assets: dedupeAssets(assets),
    metrics,
    creator_handle: "",
  };
}

async function resolveFacebookPost(normalized, settings) {
  let pageUrl = normalized.canonical_url;

  if (normalized.kind === "short") {
    pageUrl = (await resolveRedirect(normalized.canonical_url, settings)) || pageUrl;
  }

  const text = await fetchText({
    url: pageUrl,
    headers: PAGE_HEADERS,
    label: "Facebook",
    timeoutMs: settings.httpTimeoutMs,
  });
  const urls = [];

  for (const key of ["browser_native_hd_url", "browser_native_sd_url"]) {
    const match = new RegExp(`"${key}":(".*?")`).exec(text);

    if (!match) {
      continue;
    }

    try {
      const url = JSON.parse(match[1]);

      if (typeof url === "string" && url.startsWith("http")) {
        urls.push(htmlUnescape(url));
      }
    } catch {
      // Continue to meta fallbacks.
    }
  }

  if (urls.length === 0) {
    for (const video of metaContents(text, ["og:video", "og:video:url", "og:video:secure_url"])) {
      if (video) {
        urls.push(video);
      }
    }
  }

  if (urls.length === 0) {
    throw new AppError(ErrorCode.NO_MEDIA_FOUND, "Facebook 页面中没有发现可展示视频。", 404);
  }

  return {
    assets: [
      {
        source_url: urls[0],
        media_type: "video",
        filename_hint: `facebook_${normalized.shortcode}.mp4`,
        request_headers: { Referer: pageUrl },
      },
    ],
    metrics: {
      like_count: null,
      comment_count: null,
      view_count: firstRegexInt(text, /"play_count":(\d+)/),
      save_count: null,
      share_count: firstJsonCount(text, ["share_count", "shareCount", "shares_count", "sharesCount"]),
      source: "facebook_public_best_effort",
    },
    creator_handle: "",
  };
}

async function resolveRedirect(url, settings) {
  try {
    const response = await fetchWithTimeout(
      url,
      { headers: PAGE_HEADERS, cache: "no-store", redirect: "follow" },
      settings.httpTimeoutMs,
    );

    if (response.url && response.url !== url) {
      return response.url;
    }

    const text = await response.text();
    const match = /<a\s+href="([^"]+)"/i.exec(text);

    return match ? htmlUnescape(match[1]) : "";
  } catch {
    return "";
  }
}

function safeFilenamePart(value) {
  return String(value || "unknown")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^[-._]+|[-._]+$/g, "") || "unknown";
}

function jsonFromAssignment(text, assignmentName) {
  const marker = `${assignmentName} =`;
  const markerIndex = text.indexOf(marker);

  if (markerIndex < 0) {
    return null;
  }

  const startIndex = text.indexOf("{", markerIndex + marker.length);

  if (startIndex < 0) {
    return null;
  }

  const endIndex = balancedJsonEndIndex(text, startIndex);

  if (endIndex < 0) {
    return null;
  }

  try {
    return JSON.parse(text.slice(startIndex, endIndex));
  } catch {
    return null;
  }
}

function balancedJsonEndIndex(text, startIndex) {
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = startIndex; index < text.length; index += 1) {
    const char = text[index];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
      continue;
    }

    if (char === "{") {
      depth += 1;
      continue;
    }

    if (char === "}") {
      depth -= 1;

      if (depth === 0) {
        return index + 1;
      }
    }
  }

  return -1;
}

function firstDouyinItem(routerData) {
  const loaderData = routerData?.loaderData && typeof routerData.loaderData === "object"
    ? routerData.loaderData
    : {};

  for (const value of Object.values(loaderData)) {
    const items = dig(value, "videoInfoRes", "item_list");

    if (Array.isArray(items) && items[0] && typeof items[0] === "object") {
      return items[0];
    }
  }

  return null;
}

async function getTwitterGuestToken(settings, forceReload = false) {
  if (twitterGuestToken && !forceReload) {
    return twitterGuestToken;
  }

  try {
    const response = await fetchWithTimeout(
      TWITTER_TOKEN_URL,
      {
        method: "POST",
        cache: "no-store",
        headers: {
          ...PAGE_HEADERS,
          authorization: `Bearer ${TWITTER_BEARER_TOKEN}`,
          "x-twitter-client-language": "en",
          "x-twitter-active-user": "yes",
        },
      },
      settings.httpTimeoutMs,
    );
    const data = await responseJson(response);
    const token = data && typeof data === "object" ? data.guest_token : "";

    twitterGuestToken = token ? String(token) : "";

    return twitterGuestToken;
  } catch {
    return "";
  }
}

async function requestTwitterGraphql(tweetId, token, settings) {
  try {
    const url = new URL(TWITTER_GRAPHQL_URL);

    url.searchParams.set(
      "variables",
      JSON.stringify({
        focalTweetId: tweetId,
        with_rux_injections: false,
        rankingMode: "Relevance",
        includePromotedContent: true,
        withCommunity: true,
        withQuickPromoteEligibilityTweetFields: true,
        withBirdwatchNotes: true,
        withVoice: true,
      }),
    );
    url.searchParams.set("features", JSON.stringify(TWITTER_FEATURES));
    url.searchParams.set("fieldToggles", JSON.stringify(TWITTER_FIELD_TOGGLES));

    const response = await fetchWithTimeout(
      url,
      {
        cache: "no-store",
        headers: {
          ...PAGE_HEADERS,
          authorization: `Bearer ${TWITTER_BEARER_TOKEN}`,
          "content-type": "application/json",
          "x-guest-token": token,
          "x-twitter-client-language": "en",
          "x-twitter-active-user": "yes",
          cookie: `guest_id=v1%3A${token}`,
        },
      },
      settings.httpTimeoutMs,
    );
    const data = await responseJson(response);

    return data && typeof data === "object" ? data : null;
  } catch {
    return null;
  }
}

async function requestTwitterSyndication(tweetId, settings) {
  try {
    const url = new URL("https://cdn.syndication.twimg.com/tweet-result");

    url.searchParams.set("id", tweetId);
    url.searchParams.set("token", twitterSyndicationToken(tweetId));

    const response = await fetchWithTimeout(
      url,
      { headers: PAGE_HEADERS, cache: "no-store" },
      settings.httpTimeoutMs,
    );
    const data = await responseJson(response);

    return data && typeof data === "object" ? data : {};
  } catch {
    return {};
  }
}

async function requestBilibiliPlayurl(normalized, settings) {
  const videoId = normalized.shortcode;
  const params = videoId.toUpperCase().startsWith("BV")
    ? { bvid: videoId }
    : { aid: videoId.replace(/^av/i, "") };

  try {
    const viewUrl = new URL("https://api.bilibili.com/x/web-interface/view");

    Object.entries(params).forEach(([key, value]) => viewUrl.searchParams.set(key, value));

    const viewResponse = await fetchWithTimeout(
      viewUrl,
      {
        cache: "no-store",
        headers: { ...PAGE_HEADERS, Referer: normalized.canonical_url },
      },
      settings.httpTimeoutMs,
    );
    const view = await responseJson(viewResponse);
    const viewData = view?.data && typeof view.data === "object" ? view.data : null;
    const cid = viewData?.cid;

    if (!cid) {
      return null;
    }

    const playUrl = new URL("https://api.bilibili.com/x/player/playurl");

    Object.entries(params).forEach(([key, value]) => playUrl.searchParams.set(key, value));
    playUrl.searchParams.set("cid", String(cid));
    playUrl.searchParams.set("qn", "80");
    playUrl.searchParams.set("fnval", "16");
    playUrl.searchParams.set("fourk", "1");

    const playResponse = await fetchWithTimeout(
      playUrl,
      {
        cache: "no-store",
        headers: { ...PAGE_HEADERS, Referer: normalized.canonical_url },
      },
      settings.httpTimeoutMs,
    );
    const play = await responseJson(playResponse);

    return play && typeof play === "object" ? { view: viewData, play } : null;
  } catch {
    return null;
  }
}

function assetsFromBilibiliPlayinfo(data, videoId, referer) {
  if (!data || typeof data !== "object") {
    return [];
  }

  const dash = dig(data, "data", "dash") || dig(data, "result", "dash");

  if (!dash || typeof dash !== "object") {
    return [];
  }

  const video = bestBilibiliStream(dash.video);
  const audio = bestBilibiliStream(dash.audio);
  const headers = { Referer: referer, Origin: "https://www.bilibili.com" };
  const assets = [];

  if (video) {
    const height = optionalInt(video.height);

    assets.push({
      source_url: video.url,
      media_type: "video",
      width: optionalInt(video.width),
      height,
      filename_hint: `bilibili_${videoId}_${height || "video"}p_video.mp4`,
      request_headers: headers,
    });
  }

  if (audio) {
    assets.push({
      source_url: audio.url,
      media_type: "audio",
      filename_hint: `bilibili_${videoId}_audio.m4a`,
      request_headers: headers,
    });
  }

  return assets;
}

function bestBilibiliStream(items) {
  if (!Array.isArray(items)) {
    return null;
  }

  const candidates = [];

  for (const item of items) {
    if (!item || typeof item !== "object") {
      continue;
    }

    const url = item.baseUrl || item.base_url || item.url;

    if (typeof url === "string" && url.startsWith("http")) {
      candidates.push({ ...item, url: htmlUnescape(url) });
    }
  }

  if (candidates.length === 0) {
    return null;
  }

  return candidates.reduce((best, candidate) => {
    const bestScore = [best.bandwidth, best.width, best.height].map((value) => optionalInt(value) || 0);
    const nextScore = [candidate.bandwidth, candidate.width, candidate.height].map((value) => optionalInt(value) || 0);

    for (let index = 0; index < bestScore.length; index += 1) {
      if (nextScore[index] !== bestScore[index]) {
        return nextScore[index] > bestScore[index] ? candidate : best;
      }
    }

    return best;
  }, candidates[0]);
}

function tiktokVideoUrls(detail) {
  const bitrateInfo = dig(detail, "video", "bitrateInfo");
  const candidates = [];

  function addUrl(value, score = 0) {
    if (typeof value === "string" && value.startsWith("http")) {
      candidates.push([score, htmlUnescape(value)]);
    }
  }

  if (Array.isArray(bitrateInfo)) {
    for (const item of bitrateInfo) {
      if (!item || typeof item !== "object") {
        continue;
      }

      const urls = dig(item, "PlayAddr", "UrlList");
      const score = optionalInt(item.Bitrate) || 0;

      if (Array.isArray(urls)) {
        urls.forEach((url) => addUrl(url, score));
      }
    }
  }

  for (const key of ["playAddr", "downloadAddr"]) {
    addUrl(dig(detail, "video", key), 0);
  }

  const structuredUrls = dig(detail, "video", "PlayAddrStruct", "UrlList");

  if (Array.isArray(structuredUrls)) {
    structuredUrls.forEach((url) => addUrl(url, 0));
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

function bestTiktokImageUrl(imageData) {
  const urls = dig(imageData, "imageURL", "urlList");

  if (!Array.isArray(urls)) {
    return "";
  }

  const preferred = urls.find((url) => typeof url === "string" && url.includes(".jpeg"));
  const fallback = urls.find((url) => typeof url === "string" && url.startsWith("http"));

  return preferred || fallback ? htmlUnescape(preferred || fallback) : "";
}

function douyinAssetsFromDetail(detail, filenameBase, mediaHeaders) {
  const assets = [];
  const imageItems = Array.isArray(detail.images)
    ? detail.images
    : Array.isArray(detail.image_infos)
      ? detail.image_infos
      : [];

  if (imageItems.length > 0) {
    imageItems.forEach((imageData, index) => {
      const imageUrl = bestDouyinImageUrl(imageData);

      if (imageUrl) {
        assets.push({
          source_url: imageUrl,
          media_type: "image",
          filename_hint: `${filenameBase}_photo_${index + 1}.jpg`,
          request_headers: mediaHeaders,
        });
      }
    });
  } else {
    const videoUrls = douyinVideoUrls(detail);
    const videoUrl = videoUrls[0];

    if (videoUrl) {
      assets.push({
        source_url: videoUrl,
        fallback_urls: videoUrls.slice(1),
        media_type: "video",
        width: optionalInt(dig(detail, "video", "width")),
        height: optionalInt(dig(detail, "video", "height")),
        filename_hint: `${filenameBase}.mp4`,
        request_headers: mediaHeaders,
      });
    }
  }

  const audioUrl = firstUrlFromList(dig(detail, "music", "play_url", "url_list"));

  if (audioUrl) {
    assets.push({
      source_url: audioUrl,
      media_type: "audio",
      filename_hint: `${filenameBase}_audio.m4a`,
      request_headers: mediaHeaders,
    });
  }

  return assets;
}

function douyinVideoUrls(detail) {
  const candidates = [];

  for (const path of [
    ["video", "play_addr", "url_list"],
    ["video", "play_addr_h264", "url_list"],
    ["video", "download_addr", "url_list"],
  ]) {
    const urls = dig(detail, ...path);

    if (Array.isArray(urls)) {
      urls.forEach((url) => addUrlCandidate(candidates, url));
    }
  }

  const singlePlayAddr = dig(detail, "video", "play_addr", "url_key");

  addUrlCandidate(candidates, singlePlayAddr);

  return uniqueUrls(candidates);
}

function bestDouyinImageUrl(imageData) {
  for (const path of [
    ["url_list"],
    ["display_image", "url_list"],
    ["origin_cover", "url_list"],
    ["cover", "url_list"],
    ["image", "url_list"],
  ]) {
    const url = firstUrlFromList(dig(imageData, ...path));

    if (url) {
      return url;
    }
  }

  return "";
}

function firstUrlFromList(urls) {
  if (!Array.isArray(urls)) {
    return "";
  }

  const preferred = urls.find((url) => typeof url === "string" && /^https?:\/\//i.test(url));

  return preferred ? htmlUnescape(preferred) : "";
}

function addUrlCandidate(candidates, value) {
  if (typeof value === "string" && /^https?:\/\//i.test(value)) {
    candidates.push(htmlUnescape(value));
  }
}

function uniqueUrls(urls) {
  const seen = new Set();

  return urls.filter((url) => {
    if (seen.has(url)) {
      return false;
    }

    seen.add(url);
    return true;
  });
}

function bestTwitterVideoUrl(item) {
  const variants = dig(item, "video_info", "variants");

  if (!Array.isArray(variants)) {
    return "";
  }

  const mp4s = variants.filter(
    (variant) =>
      variant &&
      typeof variant === "object" &&
      variant.content_type === "video/mp4" &&
      typeof variant.url === "string",
  );

  if (mp4s.length === 0) {
    return "";
  }

  const best = mp4s.reduce((current, candidate) =>
    (optionalInt(candidate.bitrate) || 0) > (optionalInt(current.bitrate) || 0) ? candidate : current,
  );
  const url = new URL(best.url);
  const query = new URLSearchParams();

  for (const [key, value] of url.searchParams.entries()) {
    if (key !== "tag") {
      query.append(key, value);
    }
  }

  url.search = query.toString();

  return url.toString();
}

function extractTwitterTweet(data, tweetId) {
  const instructions = dig(data, "data", "threaded_conversation_with_injections_v2", "instructions");

  if (!Array.isArray(instructions)) {
    return null;
  }

  for (const instruction of instructions) {
    const entries = Array.isArray(instruction?.entries) ? instruction.entries : [];

    for (const entry of entries) {
      if (!entry || typeof entry !== "object" || entry.entryId !== `tweet-${tweetId}`) {
        continue;
      }

      const result = dig(entry, "content", "itemContent", "tweet_results", "result");

      if (!result || typeof result !== "object") {
        return null;
      }

      if (result.__typename === "TweetWithVisibilityResults") {
        return result.tweet && typeof result.tweet === "object" ? result.tweet : null;
      }

      return result;
    }
  }

  return null;
}

function metricsFromTiktok(detail) {
  const stats = detail?.stats && typeof detail.stats === "object" ? detail.stats : {};

  return {
    like_count: optionalInt(stats.diggCount),
    comment_count: optionalInt(stats.commentCount),
    view_count: optionalInt(stats.playCount),
    save_count: optionalInt(stats.collectCount),
    share_count: optionalInt(stats.shareCount),
    source: "tiktok_public_best_effort",
  };
}

function metricsFromDouyin(detail) {
  const stats = detail?.statistics && typeof detail.statistics === "object" ? detail.statistics : {};

  return {
    like_count: optionalInt(stats.digg_count),
    comment_count: optionalInt(stats.comment_count),
    view_count: optionalInt(stats.play_count),
    save_count: optionalInt(stats.collect_count),
    share_count: optionalInt(stats.share_count),
    source: "douyin_public_best_effort",
  };
}

function metricsFromBilibili(data) {
  const stat = data?.stat && typeof data.stat === "object" ? data.stat : {};

  return {
    like_count: optionalInt(stat.like),
    comment_count: optionalInt(stat.reply),
    view_count: optionalInt(stat.view),
    save_count: optionalInt(stat.favorite),
    share_count: optionalInt(stat.share),
    source: "bilibili_public_best_effort",
  };
}

function extractBilibiliInitialState(text) {
  const match =
    /window\.__INITIAL_STATE__=(.*?);\s*\(function/s.exec(text) ||
    /window\.__INITIAL_STATE__=(.*?);<\/script>/s.exec(text);

  if (!match) {
    return null;
  }

  try {
    return JSON.parse(match[1]);
  } catch {
    return null;
  }
}

function firstRegexInt(text, pattern) {
  const match = pattern.exec(text);

  return match ? optionalInt(match[1]) : null;
}

function firstJsonCount(text, keys) {
  const unescaped = htmlUnescape(text);

  for (const key of keys) {
    const valuePattern = new RegExp(`"${key}"\\s*:\\s*("?\\d+"?)`);
    const objectPattern = new RegExp(`"${key}"\\s*:\\s*\\{[^{}]*"count"\\s*:\\s*("?\\d+"?)`, "s");

    for (const pattern of [valuePattern, objectPattern]) {
      const match = pattern.exec(unescaped);

      if (match) {
        const count = optionalInt(match[1].replace(/^"|"$/g, ""));

        if (count != null) {
          return count;
        }
      }
    }
  }

  return null;
}

function twitterSyndicationToken(tweetId) {
  const value = (Number.parseInt(tweetId, 10) / 1_000_000_000_000_000) * Math.PI;

  return base36Float(value).replaceAll("0", "").replaceAll(".", "");
}

function base36Float(value) {
  const digits = "0123456789abcdefghijklmnopqrstuvwxyz";
  let integer = Math.trunc(value);
  let fraction = value - integer;
  let integerText = "";

  if (integer === 0) {
    integerText = "0";
  } else {
    while (integer > 0) {
      integerText = digits[integer % 36] + integerText;
      integer = Math.trunc(integer / 36);
    }
  }

  if (fraction <= 0) {
    return integerText;
  }

  let fractionText = "";

  for (let index = 0; index < 12; index += 1) {
    fraction *= 36;
    const digit = Math.trunc(fraction);

    fractionText += digits[digit];
    fraction -= digit;

    if (fraction === 0) {
      break;
    }
  }

  return `${integerText}.${fractionText}`;
}

function tiktokMediaHeaders(pageUrl, cookieHeader) {
  return {
    Referer: pageUrl,
    Origin: "https://www.tiktok.com",
    ...(cookieHeader ? { Cookie: cookieHeader } : {}),
  };
}

function douyinMediaHeaders(pageUrl) {
  return {
    Referer: pageUrl,
    Origin: "https://www.iesdouyin.com",
    "user-agent": DOUYIN_MOBILE_HEADERS["user-agent"],
    accept: "image/avif,image/webp,image/apng,image/*,video/*,*/*;q=0.8",
    "accept-language": DOUYIN_MOBILE_HEADERS["accept-language"],
  };
}

function cookieHeaderFromSetCookie(headers) {
  const setCookies =
    typeof headers.getSetCookie === "function"
      ? headers.getSetCookie()
      : splitSetCookieHeader(headers.get("set-cookie") ?? "");

  return setCookies
    .map((cookie) => cookie.split(";", 1)[0]?.trim())
    .filter((cookie) => cookie && cookie.includes("="))
    .join("; ");
}

function splitSetCookieHeader(value) {
  if (!value) {
    return [];
  }

  return value.split(/,(?=\s*[^;,=\s]+=[^;]+)/g).map((cookie) => cookie.trim());
}

function createMetrics(source = "public_best_effort") {
  return {
    like_count: null,
    comment_count: null,
    view_count: null,
    save_count: null,
    share_count: null,
    source,
  };
}

function isInstagramHost(host) {
  return [
    "instagram.com",
    "www.instagram.com",
    "m.instagram.com",
    "ddinstagram.com",
    "d.ddinstagram.com",
    "g.ddinstagram.com",
  ].includes(host);
}

function isTiktokHost(host) {
  return ["tiktok.com", "www.tiktok.com", "m.tiktok.com", "vt.tiktok.com", "vm.tiktok.com", "t.tiktok.com"].includes(host);
}

function isDouyinHost(host) {
  return ["douyin.com", "www.douyin.com", "m.douyin.com", "v.douyin.com", "iesdouyin.com", "www.iesdouyin.com"].includes(host);
}

function isTwitterHost(host) {
  return ["twitter.com", "www.twitter.com", "mobile.twitter.com", "x.com", "www.x.com", "vxtwitter.com", "fixvx.com"].includes(host);
}

function isBilibiliHost(host) {
  return ["bilibili.com", "www.bilibili.com", "m.bilibili.com", "b23.tv"].includes(host);
}

function isFacebookHost(host) {
  return ["facebook.com", "www.facebook.com", "web.facebook.com", "m.facebook.com", "fb.watch"].includes(host);
}
