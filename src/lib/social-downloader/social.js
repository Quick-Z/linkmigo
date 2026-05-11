import crypto from "node:crypto";
import path from "node:path";
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
import { normalizeYoutubeUrl, resolveYoutubePost } from "./youtube";

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
const XIAOHONGSHU_HEADERS = {
  ...PAGE_HEADERS,
  accept:
    "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
  "accept-language": "zh-CN,zh;q=0.9,en;q=0.8",
  Referer: "https://www.xiaohongshu.com/",
};
const SHARE_URL_PATTERN = /https?:\/\/[A-Za-z0-9\-._~:/?#\[\]@!$&'()*+,;=%]+/i;
const TRAILING_URL_PUNCTUATION_PATTERN = /[)"'.。,;:!?，；：！？、】》」』”’]+$/u;

const TWITTER_BEARER_TOKEN =
  "AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D" +
  "1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA";
const TWITTER_TOKEN_URL = "https://api.x.com/1.1/guest/activate.json";
const TWITTER_GRAPHQL_URL = "https://api.x.com/graphql/4Siu98E55GquhG52zHdY5w/TweetDetail";
const BILIBILI_WBI_KEY_CACHE_TIMEOUT_MS = 60 * 60 * 1000;
const BILIBILI_WBI_MIXIN_KEY_TABLE = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49,
  33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40,
  61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11,
  36, 20, 34, 44, 52,
];
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

let cachedBilibiliWbiKey = "";
let cachedBilibiliWbiKeyExpiresAt = 0;
const TWITTER_FIELD_TOGGLES = {
  withArticleRichContentState: true,
  withArticlePlainText: false,
  withGrokAnalyze: false,
  withDisallowedReplyControls: false,
};

let twitterGuestToken = "";

export function normalizeSocialUrl(rawUrl) {
  let value = extractUrlCandidate(String(rawUrl ?? "").trim());

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
      "暂时支持 Instagram、TikTok、抖音、小红书、Twitter/X、Bilibili、Facebook、YouTube 的公开链接。",
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

  if (isXiaohongshuHost(host)) {
    return normalizeXiaohongshuUrl(parsed);
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

  if (isYoutubeHost(host)) {
    return normalizeYoutubeUrl(parsed);
  }

  throw new AppError(
    ErrorCode.UNSUPPORTED_URL,
    "暂时支持 Instagram、TikTok、抖音、小红书、Twitter/X、Bilibili、Facebook、YouTube 的公开链接。",
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

  if (normalized.platform === "xiaohongshu") {
    return await resolveXiaohongshuPost(normalized, settings);
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

  if (normalized.platform === "youtube") {
    return await resolveYoutubePost(normalized, settings);
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

function normalizeXiaohongshuUrl(parsed) {
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

function normalizeTwitterUrl(parsed) {
  const parts = parsed.pathname.split("/").filter(Boolean);
  let tweetId = "";
  let username = "i";

  if (parsed.pathname === "/i/bookmarks") {
    tweetId = parsed.searchParams.get("post_id") ?? "";
  } else if (parts.length >= 4 && parts[0] === "i" && parts[1] === "web" && parts[2] === "status") {
    tweetId = parts[3];
  } else if (parts.length >= 3 && parts[0] === "i" && parts[1] === "status") {
    tweetId = parts[2];
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

async function resolveXiaohongshuPost(normalized, settings) {
  let active = normalized;

  if (active.kind === "short") {
    const redirected = await resolveRedirect(active.canonical_url, settings, XIAOHONGSHU_HEADERS);

    if (redirected) {
      active = normalizeSocialUrl(redirected);
    }
  }

  if (active.kind === "short" || !active.shortcode) {
    throw new AppError(ErrorCode.NO_MEDIA_FOUND, "小红书短链接没有解析到笔记 ID。", 404);
  }

  const pageUrl = active.canonical_url;
  const pageResponse = await fetchTextResponse({
    url: pageUrl,
    headers: XIAOHONGSHU_HEADERS,
    label: "Xiaohongshu",
    timeoutMs: settings.httpTimeoutMs,
  });
  const text = pageResponse.text;
  const initialState = extractXiaohongshuInitialState(text);
  const note = findXiaohongshuNote(initialState, active.shortcode);

  if (!note) {
    if (looksLikeXiaohongshuVerification(text)) {
      throw new AppError(
        ErrorCode.UPSTREAM_BLOCKED,
        "小红书触发了安全验证，暂时无法从公开页面解析资源。",
        502,
      );
    }

    const fallbackAssets = xiaohongshuMetaAssets(text, active.shortcode, pageUrl);

    if (fallbackAssets.length > 0) {
      return {
        assets: dedupeAssets(fallbackAssets),
        metrics: createMetrics("xiaohongshu_public_best_effort"),
        creator_handle: "",
      };
    }

    throw new AppError(ErrorCode.NO_MEDIA_FOUND, "小红书页面中没有发现可展示资源。", 404);
  }

  const user = note.user && typeof note.user === "object" ? note.user : {};
  const handle = user.nickname || user.nickName || user.userId || "unknown";
  const filenameBase = `xiaohongshu_${safeFilenamePart(handle)}_${active.shortcode}`;
  const mediaHeaders = xiaohongshuMediaHeaders(pageUrl);
  const assets = xiaohongshuAssetsFromNote(note, filenameBase, mediaHeaders);

  if (assets.length === 0) {
    assets.push(...xiaohongshuMetaAssets(text, active.shortcode, pageUrl));
  }

  if (assets.length === 0) {
    throw new AppError(ErrorCode.NO_MEDIA_FOUND, "小红书页面中没有发现可展示资源。", 404);
  }

  return {
    assets: dedupeAssets(assets),
    metrics: metricsFromXiaohongshu(note),
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

  const tweetResult = data ? extractTwitterTweetResult(data, tweetId) : null;
  const tweet = normalizeTwitterTweet(tweetResult);
  let media = null;
  let metrics = createMetrics("twitter_public_best_effort");

  if (!tweet) {
    handleTwitterUnavailable(tweetResult);

    const syndication = await requestTwitterSyndication(tweetId, settings);

    media = Array.isArray(syndication?.mediaDetails) ? syndication.mediaDetails : null;
  } else {
    const legacy = tweet.legacy && typeof tweet.legacy === "object" ? tweet.legacy : {};

    media = twitterMediaFromTweet(tweet);
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
          request_headers: twitterMediaHeaders(normalized.canonical_url),
        });
      }
    } else if (["video", "animated_gif"].includes(item.type)) {
      const videoUrl = bestTwitterVideoUrl(item);

      if (videoUrl) {
        assets.push({
          source_url: videoUrl,
          media_type: "video",
          filename_hint: `twitter_${tweetId}_${index + 1}.mp4`,
          request_headers: twitterMediaHeaders(normalized.canonical_url),
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
  let assets = [];
  const apiData = await requestBilibiliPlayurl(active, settings);

  if (apiData) {
    if (!hasMetricValues(metrics)) {
      metrics = metricsFromBilibili(apiData.view);
    }

    assets = assetsFromBilibiliPlayinfo(apiData.play, active.shortcode, referer);
  }

  if (assets.length === 0) {
    assets = assetsFromBilibiliPlayinfo(playinfo, active.shortcode, referer);
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

async function resolveRedirect(url, settings, headers = PAGE_HEADERS) {
  try {
    const response = await fetchWithTimeout(
      url,
      { headers, cache: "no-store", redirect: "follow" },
      settings.httpTimeoutMs,
    );

    if (response.url && response.url !== url) {
      return response.url;
    }

    const text = await response.text();
    const match = /<a\s+href=(["'])(.*?)\1/i.exec(text);

    if (match) {
      return new URL(htmlUnescape(match[2]), response.url || url).toString();
    }

    return "";
  } catch {
    return "";
  }
}

function extractUrlCandidate(rawValue) {
  const match = rawValue.match(SHARE_URL_PATTERN);
  const value = match ? match[0] : rawValue;

  return trimTrailingUrlPunctuation(value);
}

function trimTrailingUrlPunctuation(value) {
  return String(value || "").trim().replace(TRAILING_URL_PUNCTUATION_PATTERN, "");
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

    const play = await requestBilibiliMergedPlayinfo({
      params: {
        ...params,
        cid: String(cid),
      },
      referer: normalized.canonical_url,
      settings,
      videoId,
    });

    return play && typeof play === "object" ? { view: viewData, play } : null;
  } catch {
    return null;
  }
}

async function requestBilibiliMergedPlayinfo({ params, referer, settings, videoId }) {
  const baseParams = {
    ...params,
    fnval: "4048",
    fourk: "1",
    platform: "pc",
    try_look: "1",
  };
  const playInfos = [];
  const initialPlay = await requestBilibiliWbiPlayurl({
    params: baseParams,
    referer,
    settings,
    videoId,
  });

  if (initialPlay) {
    playInfos.push(initialPlay);
  }

  const qualityIds = bilibiliAcceptQualities(initialPlay);
  const currentQualities = new Set(bilibiliVideoStreams(initialPlay).map((stream) => optionalInt(stream.id)).filter((value) => value != null));

  for (const qualityId of qualityIds) {
    if (currentQualities.has(qualityId)) {
      continue;
    }

    const playInfo = await requestBilibiliWbiPlayurl({
      params: {
        ...baseParams,
        qn: String(qualityId),
      },
      referer,
      settings,
      videoId,
    });

    if (playInfo) {
      playInfos.push(playInfo);
      for (const stream of bilibiliVideoStreams(playInfo)) {
        const streamQuality = optionalInt(stream.id);

        if (streamQuality != null) {
          currentQualities.add(streamQuality);
        }
      }
    }
  }

  const legacyPlay = await requestBilibiliLegacyPlayurl({
    params: {
      ...params,
      qn: "80",
      fnval: "16",
      fourk: "1",
      platform: "pc",
      try_look: "1",
    },
    referer,
    settings,
  });

  if (legacyPlay) {
    playInfos.push(legacyPlay);
  }

  if (playInfos.length) {
    return mergeBilibiliPlayinfos(playInfos);
  }

  return await requestBilibiliLegacyPlayurl({
    params: {
      ...params,
      qn: "80",
      fnval: "16",
      fourk: "1",
      platform: "pc",
      try_look: "1",
    },
    referer,
    settings,
  });
}

async function requestBilibiliWbiPlayurl({ params, referer, settings, videoId }) {
  const signedParams = await signBilibiliWbiParams(params, videoId, settings, referer);
  const playUrl = new URL("https://api.bilibili.com/x/player/wbi/playurl");

  Object.entries(signedParams).forEach(([key, value]) => playUrl.searchParams.set(key, String(value)));

  const playResponse = await fetchWithTimeout(
    playUrl,
    {
      cache: "no-store",
      headers: { ...PAGE_HEADERS, Referer: referer },
    },
    settings.httpTimeoutMs,
  );
  const play = await responseJson(playResponse);

  return play?.data && typeof play.data === "object" ? play : null;
}

async function requestBilibiliLegacyPlayurl({ params, referer, settings }) {
  const playUrl = new URL("https://api.bilibili.com/x/player/playurl");

  Object.entries(params).forEach(([key, value]) => playUrl.searchParams.set(key, String(value)));

  const playResponse = await fetchWithTimeout(
    playUrl,
    {
      cache: "no-store",
      headers: { ...PAGE_HEADERS, Referer: referer },
    },
    settings.httpTimeoutMs,
  );
  const play = await responseJson(playResponse);

  return play && typeof play === "object" ? play : null;
}

async function signBilibiliWbiParams(params, videoId, settings, referer) {
  const key = await getBilibiliWbiKey(videoId, settings, referer);
  const signedEntries = Object.entries({
    ...params,
    wts: String(Math.round(Date.now() / 1000)),
  })
    .map(([paramKey, value]) => [
      paramKey,
      String(value).replace(/[!'()*]/g, ""),
    ])
    .sort(([left], [right]) => left.localeCompare(right));
  const query = new URLSearchParams(signedEntries).toString();

  return {
    ...Object.fromEntries(signedEntries),
    w_rid: crypto.createHash("md5").update(`${query}${key}`).digest("hex"),
  };
}

async function getBilibiliWbiKey(videoId, settings, referer) {
  if (cachedBilibiliWbiKey && Date.now() < cachedBilibiliWbiKeyExpiresAt) {
    return cachedBilibiliWbiKey;
  }

  const response = await fetchWithTimeout(
    "https://api.bilibili.com/x/web-interface/nav",
    {
      cache: "no-store",
      headers: { ...PAGE_HEADERS, Referer: referer },
    },
    settings.httpTimeoutMs,
  );
  const data = await responseJson(response);
  const imgKey = bilibiliWbiImageKey(dig(data, "data", "wbi_img", "img_url"));
  const subKey = bilibiliWbiImageKey(dig(data, "data", "wbi_img", "sub_url"));
  const lookup = `${imgKey}${subKey}`;

  if (lookup.length < 64) {
    throw new AppError(ErrorCode.UPSTREAM_BLOCKED, "无法获取 Bilibili WBI 签名。", 502);
  }

  cachedBilibiliWbiKey = BILIBILI_WBI_MIXIN_KEY_TABLE
    .map((index) => lookup[index] || "")
    .join("")
    .slice(0, 32);
  cachedBilibiliWbiKeyExpiresAt = Date.now() + BILIBILI_WBI_KEY_CACHE_TIMEOUT_MS;

  return cachedBilibiliWbiKey;
}

function bilibiliWbiImageKey(value) {
  if (typeof value !== "string" || !value) {
    return "";
  }

  try {
    return path.basename(new URL(value).pathname).split(".", 1)[0] || "";
  } catch {
    return path.basename(value).split(".", 1)[0] || "";
  }
}

function bilibiliAcceptQualities(playInfo) {
  const data = bilibiliPlayData(playInfo);
  const qualityIds = new Set();
  const supportFormats = Array.isArray(data?.support_formats) ? data.support_formats : [];

  for (const item of supportFormats) {
    const quality = optionalInt(item?.quality);

    if (quality != null) {
      qualityIds.add(quality);
    }
  }

  const accepted = Array.isArray(data?.accept_quality) ? data.accept_quality : [];

  for (const quality of accepted) {
    const parsed = optionalInt(quality);

    if (parsed != null) {
      qualityIds.add(parsed);
    }
  }

  return [...qualityIds].sort((left, right) => right - left);
}

function mergeBilibiliPlayinfos(playInfos) {
  const merged = structuredClone(bilibiliPlayData(playInfos[0]) || {});
  const dash = {
    ...(merged.dash && typeof merged.dash === "object" ? merged.dash : {}),
  };
  const videos = [];
  const audios = [];
  const supportFormats = [];

  for (const playInfo of playInfos) {
    const data = bilibiliPlayData(playInfo);

    videos.push(...bilibiliVideoStreams(playInfo));
    audios.push(...bilibiliAudioStreams(playInfo));

    if (Array.isArray(data?.support_formats)) {
      supportFormats.push(...data.support_formats);
    }
  }

  dash.video = dedupeBilibiliStreams(videos);
  dash.audio = dedupeBilibiliStreams(audios);
  merged.dash = dash;
  merged.support_formats = dedupeBilibiliSupportFormats(supportFormats);

  return { data: merged };
}

function bilibiliPlayData(playInfo) {
  if (!playInfo || typeof playInfo !== "object") {
    return null;
  }

  return (
    playInfo.data && typeof playInfo.data === "object"
      ? playInfo.data
      : playInfo.result && typeof playInfo.result === "object"
        ? playInfo.result
        : playInfo
  );
}

function bilibiliVideoStreams(playInfo) {
  const videos = bilibiliPlayData(playInfo)?.dash?.video;

  return Array.isArray(videos) ? videos.filter((item) => item && typeof item === "object") : [];
}

function bilibiliAudioStreams(playInfo) {
  const data = bilibiliPlayData(playInfo);
  const dash = data?.dash && typeof data.dash === "object" ? data.dash : {};
  const audios = [];

  if (Array.isArray(dash.audio)) {
    audios.push(...dash.audio);
  }

  if (Array.isArray(dash.dolby?.audio)) {
    audios.push(...dash.dolby.audio);
  }

  if (dash.flac?.audio && typeof dash.flac.audio === "object") {
    audios.push(dash.flac.audio);
  }

  return audios.filter((item) => item && typeof item === "object");
}

function dedupeBilibiliStreams(streams) {
  const seen = new Set();
  const output = [];

  for (const stream of streams) {
    const url = stream?.baseUrl || stream?.base_url || stream?.url;
    const key = `${stream?.id || ""}:${stream?.codecs || ""}:${url || ""}`;

    if (!url || seen.has(key)) {
      continue;
    }

    seen.add(key);
    output.push(stream);
  }

  return output;
}

function dedupeBilibiliSupportFormats(items) {
  const seen = new Set();
  const output = [];

  for (const item of items) {
    const quality = optionalInt(item?.quality);

    if (quality == null || seen.has(quality)) {
      continue;
    }

    seen.add(quality);
    output.push(item);
  }

  return output.sort((left, right) => (optionalInt(right.quality) || 0) - (optionalInt(left.quality) || 0));
}

function assetsFromBilibiliPlayinfo(data, videoId, referer) {
  if (!data || typeof data !== "object") {
    return [];
  }

  const playData = bilibiliPlayData(data);
  const dash = playData?.dash;

  if (!dash || typeof dash !== "object") {
    return [];
  }

  const video = bestBilibiliStream(dash.video);
  const audio = bestBilibiliStream(bilibiliAudioStreams(data));
  const headers = { Referer: referer, Origin: "https://www.bilibili.com" };
  const assets = [];

  if (video && audio) {
    const height = optionalInt(video.height);

    assets.push({
      source_url: video.url,
      fallback_urls: bilibiliStreamFallbackUrls(video),
      audio_source_url: audio.url,
      audio_fallback_urls: bilibiliStreamFallbackUrls(audio),
      media_type: "video",
      width: optionalInt(video.width),
      height,
      filename_hint: `bilibili_${videoId}_${height || "video"}p.mp4`,
      request_headers: headers,
      audio_request_headers: headers,
    });

    return assets;
  }

  if (video) {
    const height = optionalInt(video.height);

    assets.push({
      source_url: video.url,
      fallback_urls: bilibiliStreamFallbackUrls(video),
      media_type: "video",
      width: optionalInt(video.width),
      height,
      filename_hint: `bilibili_${videoId}_${height || "video"}p.mp4`,
      request_headers: headers,
    });
  }

  if (audio) {
    assets.push({
      source_url: audio.url,
      fallback_urls: bilibiliStreamFallbackUrls(audio),
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
    const bestScore = bilibiliStreamScore(best);
    const nextScore = bilibiliStreamScore(candidate);

    for (let index = 0; index < bestScore.length; index += 1) {
      if (nextScore[index] !== bestScore[index]) {
        return nextScore[index] > bestScore[index] ? candidate : best;
      }
    }

    return best;
  }, candidates[0]);
}

function bilibiliStreamScore(stream) {
  return [
    optionalInt(stream.height) || 0,
    optionalInt(stream.width) || 0,
    optionalInt(stream.frameRate || stream.frame_rate) || 0,
    optionalInt(stream.bandwidth) || 0,
  ];
}

function bilibiliStreamFallbackUrls(stream) {
  const values = [
    stream?.backupUrl,
    stream?.backup_url,
    stream?.backupUrls,
    stream?.backup_urls,
  ].flatMap((value) => Array.isArray(value) ? value : [value]);

  return values
    .filter((url) => typeof url === "string" && url.startsWith("http"))
    .map((url) => htmlUnescape(url));
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

function xiaohongshuMetaAssets(text, shortcode, pageUrl) {
  const headers = xiaohongshuMediaHeaders(pageUrl);
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
  return /captcha|verify|安全验证|滑块验证|环境异常|访问频繁/i.test(text);
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

  return htmlUnescape(best.url);
}

function extractTwitterTweetResult(data, tweetId) {
  const instructions = dig(data, "data", "threaded_conversation_with_injections_v2", "instructions");

  if (!Array.isArray(instructions)) {
    return null;
  }

  for (const instruction of instructions) {
    if (instruction?.type && instruction.type !== "TimelineAddEntries") {
      continue;
    }

    const entries = Array.isArray(instruction?.entries) ? instruction.entries : [];

    for (const entry of entries) {
      if (!entry || typeof entry !== "object" || entry.entryId !== `tweet-${tweetId}`) {
        continue;
      }

      const result = dig(entry, "content", "itemContent", "tweet_results", "result");

      if (!result || typeof result !== "object") {
        return null;
      }

      return result;
    }
  }

  return null;
}

function normalizeTwitterTweet(tweetResult) {
  if (!tweetResult || typeof tweetResult !== "object") {
    return null;
  }

  if (tweetResult.__typename === "TweetWithVisibilityResults") {
    return tweetResult.tweet && typeof tweetResult.tweet === "object" ? tweetResult.tweet : null;
  }

  return tweetResult.__typename === "Tweet" ? tweetResult : null;
}

function twitterMediaFromTweet(tweet) {
  const legacy = tweet?.legacy && typeof tweet.legacy === "object" ? tweet.legacy : {};
  const retweetedResult =
    dig(legacy, "retweeted_status_result", "result", "tweet") ||
    dig(legacy, "retweeted_status_result", "result");
  const retweetedLegacy = retweetedResult?.legacy && typeof retweetedResult.legacy === "object"
    ? retweetedResult.legacy
    : retweetedResult && typeof retweetedResult === "object"
      ? retweetedResult
      : null;
  const retweetedMedia = retweetedLegacy ? dig(retweetedLegacy, "extended_entities", "media") : null;
  const media = retweetedMedia || dig(legacy, "extended_entities", "media") || dig(legacy, "entities", "media");

  return Array.isArray(media) ? media : null;
}

function handleTwitterUnavailable(tweetResult) {
  if (!tweetResult || typeof tweetResult !== "object") {
    return;
  }

  if (!["TweetUnavailable", "TweetTombstone"].includes(tweetResult.__typename)) {
    return;
  }

  const reason = dig(tweetResult, "result", "reason") || tweetResult.reason || "";
  const tombstoneText = dig(tweetResult, "tombstone", "text", "text") || "";

  if (reason === "Protected") {
    throw new AppError(ErrorCode.LOGIN_REQUIRED, "这个 Twitter/X 帖子来自受保护账号，需要登录后访问。", 403);
  }

  if (reason === "NsfwLoggedOut" || /^Age-restricted/i.test(tombstoneText)) {
    throw new AppError(ErrorCode.LOGIN_REQUIRED, "这个 Twitter/X 内容需要登录或年龄验证。", 403);
  }

  throw new AppError(ErrorCode.NO_MEDIA_FOUND, "这个 Twitter/X 帖子不可用或已被删除。", 404);
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

  return base36Float(value)
    .replace(".", "")
    .replace(/^0+|0+$/g, "");
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

function xiaohongshuMediaHeaders(pageUrl) {
  return {
    Referer: pageUrl,
    Origin: "https://www.xiaohongshu.com",
    "user-agent": XIAOHONGSHU_HEADERS["user-agent"],
    accept: "image/avif,image/webp,image/apng,image/*,video/*,*/*;q=0.8",
    "accept-language": XIAOHONGSHU_HEADERS["accept-language"],
  };
}

function twitterMediaHeaders(pageUrl) {
  return {
    Referer: pageUrl,
    Origin: "https://x.com",
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

function isXiaohongshuHost(host) {
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

function isTwitterHost(host) {
  return ["twitter.com", "www.twitter.com", "mobile.twitter.com", "x.com", "www.x.com", "vxtwitter.com", "fixvx.com"].includes(host);
}

function isBilibiliHost(host) {
  return ["bilibili.com", "www.bilibili.com", "m.bilibili.com", "b23.tv"].includes(host);
}

function isFacebookHost(host) {
  return ["facebook.com", "www.facebook.com", "web.facebook.com", "m.facebook.com", "fb.watch"].includes(host);
}

function isYoutubeHost(host) {
  return [
    "youtube.com",
    "www.youtube.com",
    "m.youtube.com",
    "music.youtube.com",
    "youtu.be",
    "www.youtu.be",
    "youtube-nocookie.com",
    "www.youtube-nocookie.com",
  ].includes(host);
}
