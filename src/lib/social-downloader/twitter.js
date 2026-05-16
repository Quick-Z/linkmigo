import { AppError, ErrorCode } from "./errors";
import {
  dedupeAssets,
  dig,
  fetchWithTimeout,
  firstPresentInt,
  htmlUnescape,
  optionalInt,
  PAGE_HEADERS,
  responseJson,
} from "./utils";
import {
  createPostInfo,
  normalizeTags,
  pickSingleLineText,
  pickText,
} from "./post-info";
import { createMetrics, titleFromBody } from "./shared";

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

export function normalizeTwitterUrl(parsed) {
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

export async function resolveTwitterPost(normalized, settings) {
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
  let syndication = null;

  if (!tweet) {
    handleTwitterUnavailable(tweetResult);

    syndication = await requestTwitterSyndication(tweetId, settings);

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
    post_info: postInfoFromTwitter(tweet, syndication, metrics, normalized),
  };
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

function postInfoFromTwitter(tweet, syndication, metrics, normalized) {
  const legacy = tweet?.legacy && typeof tweet.legacy === "object" ? tweet.legacy : {};
  const user = dig(tweet, "core", "user_results", "result", "legacy") || {};
  const canonicalHandle = normalized.canonical_url.includes("/status/")
    ? normalized.canonical_url.split("/")[3]?.replace("@", "") || ""
    : "";
  const body = pickText(
    dig(tweet, "note_tweet", "note_tweet_results", "result", "text"),
    legacy.full_text,
    syndication?.text,
  );

  return createPostInfo(
    {
      title: titleFromBody(body),
      author: pickSingleLineText(user.name, syndication?.user?.name, canonicalHandle),
      author_handle: pickSingleLineText(user.screen_name, syndication?.user?.screen_name, canonicalHandle),
      body,
      tags: normalizeTags(twitterTags(legacy), body),
      metrics,
      source: metrics?.source || "twitter_public_best_effort",
    },
    { metrics, creatorHandle: canonicalHandle, source: metrics?.source || "twitter_public_best_effort" },
  );
}

function twitterTags(legacy) {
  const hashtags = Array.isArray(legacy?.entities?.hashtags) ? legacy.entities.hashtags : [];

  return hashtags.map((item) => item?.text);
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

function twitterMediaHeaders(pageUrl) {
  return {
    Referer: pageUrl,
    Origin: "https://x.com",
  };
}

export function isTwitterHost(host) {
  return ["twitter.com", "www.twitter.com", "mobile.twitter.com", "x.com", "www.x.com", "vxtwitter.com", "fixvx.com"].includes(host);
}
