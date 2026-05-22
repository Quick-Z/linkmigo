import { URL } from "node:url";

import { AppError, ErrorCode } from "./errors";
import {
  dedupeAssets,
  fetchTextResponse,
  jsonFromScriptId,
  metaContents,
  PAGE_HEADERS,
  scriptTexts,
} from "./utils";
import {
  createPostInfo,
  normalizeTags,
  pickSingleLineText,
  pickText,
} from "./post-info";
import {
  addUrlCandidate,
  loadsJsonValues,
  titleFromBody,
  uniqueUrls,
} from "./shared";

const XIAOYUZHOU_HEADERS = {
  ...PAGE_HEADERS,
  "accept-language": "zh-CN,zh;q=0.9,en;q=0.8",
  Referer: "https://www.xiaoyuzhoufm.com/",
};

export function isXiaoyuzhouHost(host) {
  return host === "xiaoyuzhoufm.com" || host.endsWith(".xiaoyuzhoufm.com");
}

export function normalizeXiaoyuzhouUrl(parsed) {
  const parts = parsed.pathname.split("/").filter(Boolean);
  const episodeIndex = parts.findIndex((part) => part.toLowerCase() === "episode");
  const episodeId = episodeIndex >= 0 ? parts[episodeIndex + 1] : "";

  if (!/^[a-z0-9]{8,64}$/i.test(episodeId)) {
    throw new AppError(ErrorCode.UNSUPPORTED_URL, "仅支持小宇宙单集链接。", 400);
  }

  return {
    canonical_url: `https://www.xiaoyuzhoufm.com/episode/${episodeId}`,
    shortcode: episodeId,
    kind: "episode",
    platform: "xiaoyuzhou",
  };
}

export async function resolveXiaoyuzhouPost(normalized, settings) {
  const pageResponse = await fetchTextResponse({
    url: normalized.canonical_url,
    headers: XIAOYUZHOU_HEADERS,
    label: "小宇宙",
    timeoutMs: settings.httpTimeoutMs,
  });
  const pageUrl = pageResponse.response?.url || normalized.canonical_url;
  const text = pageResponse.text;
  const schemas = xiaoyuzhouJsonLd(text);
  const podcastEpisode = findXiaoyuzhouPodcastEpisode(schemas);
  const nextData = jsonFromScriptId(text, "__NEXT_DATA__");
  const episodeData = findXiaoyuzhouEpisodeData(nextData, normalized.shortcode);
  const audioUrls = xiaoyuzhouAudioUrls(text, podcastEpisode, episodeData);

  if (audioUrls.length === 0) {
    throw new AppError(ErrorCode.NO_MEDIA_FOUND, "小宇宙页面中没有发现可下载音频。", 404);
  }

  const metrics = metricsFromXiaoyuzhou(episodeData);
  const creatorHandle = xiaoyuzhouCreatorHandle(podcastEpisode, episodeData, text);
  const episodeTitle = xiaoyuzhouEpisodeTitle(podcastEpisode, episodeData, text);
  const filenameBase = xiaoyuzhouFilenameBase(episodeTitle, creatorHandle, normalized.shortcode);
  const extension = xiaoyuzhouAudioExtension(audioUrls[0]);
  const assets = [
    {
      source_url: audioUrls[0],
      fallback_urls: audioUrls.slice(1),
      media_type: "audio",
      filename_hint: `${filenameBase}${extension}`,
      request_headers: xiaoyuzhouMediaHeaders(pageUrl),
    },
  ];

  return {
    assets: dedupeAssets(assets),
    metrics,
    creator_handle: creatorHandle,
    post_info: postInfoFromXiaoyuzhou(podcastEpisode, episodeData, text, metrics, creatorHandle),
  };
}

export async function resolveXiaoyuzhouComments(normalized, options = {}, settings = {}) {
  const pageResponse = await fetchTextResponse({
    url: normalized.canonical_url,
    headers: XIAOYUZHOU_HEADERS,
    label: "小宇宙",
    timeoutMs: settings.httpTimeoutMs ?? 20_000,
  });
  const nextData = jsonFromScriptId(pageResponse.text, "__NEXT_DATA__");
  const episodeData = findXiaoyuzhouEpisodeData(nextData, normalized.shortcode);
  const publicComments = xiaoyuzhouPageComments(nextData, normalized.shortcode);
  const limit = normalizeCommentLimit(options.limit);
  const offset = normalizeCommentCursor(options.cursor);
  const endOffset = offset + limit;
  const comments = publicComments
    .slice(offset, endOffset)
    .map((comment) => normalizeXiaoyuzhouComment(comment))
    .filter((comment) => comment.id);
  const totalCount = firstPresentEpisodeNumber(episodeData, ["commentCount", "commentsCount", "comment_count"]) ?? publicComments.length;
  const nextCursor = endOffset < publicComments.length ? String(endOffset) : null;

  return {
    platform: "xiaoyuzhou",
    shortcode: normalized.shortcode,
    canonical_url: normalized.canonical_url,
    comments,
    next_cursor: nextCursor,
    has_more: Boolean(nextCursor),
    total_count: totalCount,
    public_count: publicComments.length,
    is_partial_public_snapshot: totalCount > publicComments.length,
    source: "xiaoyuzhou_episode_public_page",
  };
}

function xiaoyuzhouJsonLd(text) {
  return scriptTexts(text, { type: "application/ld+json" })
    .flatMap((script) => loadsJsonValues(script));
}

function findXiaoyuzhouPodcastEpisode(values) {
  for (const value of values) {
    const found = findJsonObject(value, (candidate) => {
      const type = jsonType(candidate);

      return type.includes("podcastepisode") || Boolean(candidate?.associatedMedia?.contentUrl);
    });

    if (found) {
      return found;
    }
  }

  return null;
}

function findXiaoyuzhouEpisodeData(value, episodeId) {
  return findJsonObject(value, (candidate) => {
    const id = String(candidate?.id || candidate?.eid || candidate?.episodeId || candidate?.episode_id || "");

    return id === episodeId && Boolean(candidate?.title || candidate?.name || candidate?.media || candidate?.enclosure || candidate?.podcast);
  });
}

function findJsonObject(value, predicate, seen = new WeakSet(), depth = 0) {
  if (!value || typeof value !== "object" || depth > 14 || seen.has(value)) {
    return null;
  }

  seen.add(value);

  if (!Array.isArray(value) && predicate(value)) {
    return value;
  }

  const children = Array.isArray(value) ? value : Object.values(value);

  for (const child of children) {
    const found = findJsonObject(child, predicate, seen, depth + 1);

    if (found) {
      return found;
    }
  }

  return null;
}

function findJsonArray(value, predicate, seen = new WeakSet(), depth = 0) {
  if (!value || typeof value !== "object" || depth > 14 || seen.has(value)) {
    return null;
  }

  seen.add(value);

  if (Array.isArray(value) && predicate(value)) {
    return value;
  }

  const children = Array.isArray(value) ? value : Object.values(value);

  for (const child of children) {
    const found = findJsonArray(child, predicate, seen, depth + 1);

    if (found) {
      return found;
    }
  }

  return null;
}

function xiaoyuzhouPageComments(nextData, episodeId) {
  const directComments = nextData?.props?.pageProps?.comments;

  if (Array.isArray(directComments)) {
    return directComments.filter((comment) => isXiaoyuzhouEpisodeComment(comment, episodeId));
  }

  const found = findJsonArray(nextData, (items) =>
    items.some((item) => isXiaoyuzhouEpisodeComment(item, episodeId)),
  );

  return Array.isArray(found)
    ? found.filter((comment) => isXiaoyuzhouEpisodeComment(comment, episodeId))
    : [];
}

function isXiaoyuzhouEpisodeComment(comment, episodeId) {
  return Boolean(
    comment &&
      typeof comment === "object" &&
      comment.type === "COMMENT" &&
      String(comment.owner?.id || "") === episodeId &&
      (comment.text || comment.voice || comment.author),
  );
}

function normalizeCommentLimit(value) {
  const parsed = Number.parseInt(String(value ?? ""), 10);

  if (!Number.isFinite(parsed)) {
    return 12;
  }

  return Math.max(1, Math.min(30, parsed));
}

function normalizeCommentCursor(value) {
  const parsed = Number.parseInt(String(value ?? ""), 10);

  if (!Number.isFinite(parsed) || parsed < 0) {
    return 0;
  }

  return parsed;
}

function normalizeXiaoyuzhouComment(comment) {
  const replies = Array.isArray(comment?.replies) ? comment.replies : [];
  const author = comment?.author ?? {};

  return {
    id: String(comment?.id || ""),
    text: pickText(comment?.text),
    author_name: pickSingleLineText(
      author.nickname,
      author.jikeUserInfo?.nickname,
      author.wechatUserInfo?.nickName,
      author.uid,
      "小宇宙用户",
    ),
    author_handle: String(author.uid || "").trim(),
    avatar_url: pickSingleLineText(
      author.avatar?.picture?.thumbnailUrl,
      author.avatar?.picture?.smallPicUrl,
      author.avatar?.picture?.middlePicUrl,
      author.avatar?.picture?.picUrl,
    ),
    created_at: comment?.createdAt || null,
    like_count: firstPresentEpisodeNumber(comment, ["likeCount", "likedCount"]),
    reply_count: firstPresentEpisodeNumber(comment, ["replyCount", "threadReplyCount"]) ?? replies.length,
    ip_loc: pickSingleLineText(comment?.ipLoc, author.ipLoc),
    has_voice: Boolean(comment?.voice?.url),
    replies: replies
      .slice(0, 3)
      .map((reply) => normalizeXiaoyuzhouComment(reply))
      .filter((reply) => reply.id),
  };
}

function xiaoyuzhouAudioUrls(text, podcastEpisode, episodeData) {
  const urls = [];

  for (const value of metaContents(text, ["og:audio", "og:audio:url", "twitter:player:stream"])) {
    addUrlCandidate(urls, value);
  }

  addPodcastMediaUrls(urls, podcastEpisode);
  addEpisodeDataMediaUrls(urls, episodeData);

  return uniqueUrls(urls);
}

function addPodcastMediaUrls(urls, episode) {
  if (!episode || typeof episode !== "object") {
    return;
  }

  addUrlCandidate(urls, episode.contentUrl);
  addUrlCandidate(urls, episode.audio);
  addUrlCandidate(urls, episode.audio?.contentUrl);

  const mediaItems = Array.isArray(episode.associatedMedia)
    ? episode.associatedMedia
    : [episode.associatedMedia];

  for (const media of mediaItems) {
    if (typeof media === "string") {
      addUrlCandidate(urls, media);
    } else if (media && typeof media === "object") {
      addUrlCandidate(urls, media.contentUrl);
      addUrlCandidate(urls, media.url);
    }
  }
}

function addEpisodeDataMediaUrls(urls, episodeData) {
  if (!episodeData || typeof episodeData !== "object") {
    return;
  }

  for (const value of [
    episodeData.audioUrl,
    episodeData.audio_url,
    episodeData.mediaUrl,
    episodeData.media_url,
    episodeData.url,
    episodeData.media?.url,
    episodeData.media?.sourceUrl,
    episodeData.media?.source_url,
    episodeData.enclosure?.url,
    episodeData.enclosure?.audioUrl,
    episodeData.enclosure?.audio_url,
  ]) {
    addUrlCandidate(urls, value);
  }
}

function xiaoyuzhouAudioExtension(url) {
  try {
    const pathname = new URL(url).pathname.toLowerCase();
    const match = /\.(m4a|mp3|aac|mp4)(?:$|[?#])/i.exec(pathname);

    return match ? `.${match[1].toLowerCase()}` : ".m4a";
  } catch {
    return ".m4a";
  }
}

function xiaoyuzhouMediaHeaders(pageUrl) {
  return {
    Referer: pageUrl,
    accept: "audio/*,*/*;q=0.8",
  };
}

function metricsFromXiaoyuzhou(episodeData) {
  return {
    like_count: firstPresentEpisodeNumber(episodeData, ["likeCount", "likedCount", "clapCount"]),
    comment_count: firstPresentEpisodeNumber(episodeData, ["commentCount", "commentsCount", "comment_count"]),
    view_count: firstPresentEpisodeNumber(episodeData, ["playCount", "play_count", "listenCount", "listen_count"]),
    save_count: null,
    share_count: null,
    source: "xiaoyuzhou_public_best_effort",
  };
}

function firstPresentEpisodeNumber(source, keys) {
  if (!source || typeof source !== "object") {
    return null;
  }

  for (const key of keys) {
    const value = source[key];
    const number = Number.parseInt(String(value ?? ""), 10);

    if (Number.isFinite(number) && number >= 0) {
      return number;
    }
  }

  return null;
}

function xiaoyuzhouCreatorHandle(podcastEpisode, episodeData, text) {
  return pickSingleLineText(
    podcastEpisode?.partOfSeries?.name,
    podcastEpisode?.publisher?.name,
    episodeData?.podcast?.title,
    episodeData?.podcast?.name,
    episodeData?.podcastTitle,
    episodeData?.podcast_title,
    metaContents(text, ["og:site_name"]),
  );
}

function xiaoyuzhouEpisodeTitle(podcastEpisode, episodeData, text) {
  const body = pickText(
    podcastEpisode?.description,
    episodeData?.description,
    episodeData?.shownotes,
    episodeData?.shownotesText,
    metaContents(text, ["og:description", "description"]),
  );

  return pickSingleLineText(
    podcastEpisode?.name,
    episodeData?.title,
    episodeData?.name,
    metaContents(text, ["og:title", "twitter:title"]),
    titleFromBody(body),
  );
}

function xiaoyuzhouFilenameBase(title, creatorHandle, episodeId) {
  const cleanTitle = pickSingleLineText(title, episodeId);
  const cleanCreator = pickSingleLineText(creatorHandle, "小宇宙");

  if (cleanTitle && cleanCreator) {
    return `${cleanTitle}@${cleanCreator}`;
  }

  return cleanTitle || `xiaoyuzhou_${episodeId}`;
}

function postInfoFromXiaoyuzhou(podcastEpisode, episodeData, text, metrics, creatorHandle) {
  const body = pickText(
    podcastEpisode?.description,
    episodeData?.description,
    episodeData?.shownotes,
    episodeData?.shownotesText,
    metaContents(text, ["og:description", "description"]),
  );
  const title = pickSingleLineText(
    xiaoyuzhouEpisodeTitle(podcastEpisode, episodeData, text),
    titleFromBody(body),
  );

  return createPostInfo(
    {
      title,
      author: creatorHandle,
      author_handle: creatorHandle,
      body,
      tags: normalizeTags([], body),
      metrics,
      source: "xiaoyuzhou_public_best_effort",
    },
    { metrics, creatorHandle, source: "xiaoyuzhou_public_best_effort" },
  );
}

function jsonType(value) {
  const raw = value?.["@type"];
  const values = Array.isArray(raw) ? raw : [raw];

  return values
    .filter(Boolean)
    .map((item) => String(item).toLowerCase())
    .join(" ");
}
