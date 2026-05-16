import { URL } from "node:url";

import { AppError, ErrorCode } from "./errors";
import {
  cleanUrl,
  dedupeAssets,
  dig,
  fetchTextResponse,
  htmlUnescape,
  jsonFromScriptId,
  optionalInt,
  PAGE_HEADERS,
} from "./utils";
import {
  createPostInfo,
  normalizeTags,
  pickSingleLineText,
  pickText,
} from "./post-info";
import { cookieHeaderFromSetCookie, resolveRedirect, titleFromBody } from "./shared";

export function normalizeTiktokUrl(parsed) {
  const parts = parsed.pathname.split("/").filter(Boolean);
  const host = parsed.hostname.toLowerCase();
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

  const shortCode = tiktokShortCode(host, parts);

  if (shortCode) {
    return {
      canonical_url: cleanUrl(parsed),
      shortcode: shortCode,
      kind: "short",
      platform: "tiktok",
    };
  }

  throw new AppError(ErrorCode.UNSUPPORTED_URL, "仅支持 TikTok 视频、图集或短链接。", 400);
}

function tiktokShortCode(host, parts) {
  if (["vt.tiktok.com", "vm.tiktok.com", "t.tiktok.com"].includes(host)) {
    return parts[0] ?? "";
  }

  if (["tiktok.com", "www.tiktok.com", "m.tiktok.com"].includes(host) && parts[0] === "t") {
    return parts[1] ?? "";
  }

  return "";
}

export async function resolveTiktokPost(normalized, settings) {
  let postId = normalized.shortcode;

  if (normalized.kind === "short") {
    const redirected = await resolveRedirect(normalized.canonical_url, settings);

    if (redirected) {
      postId = normalizeTiktokUrl(new URL(redirected)).shortcode;
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

  const metrics = metricsFromTiktok(detail);

  return {
    assets: dedupeAssets(assets),
    metrics,
    creator_handle: author,
    post_info: postInfoFromTiktok(detail, metrics, author),
  };
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

function postInfoFromTiktok(detail, metrics, creatorHandle) {
  const author = detail?.author && typeof detail.author === "object" ? detail.author : {};
  const body = pickText(detail?.desc, dig(detail, "contents", 0, "desc"));

  return createPostInfo(
    {
      title: pickSingleLineText(dig(detail, "shareMeta", "title"), titleFromBody(body)),
      author: pickSingleLineText(author.nickname, author.uniqueId, creatorHandle),
      author_handle: pickSingleLineText(author.uniqueId, creatorHandle),
      body,
      tags: normalizeTags(tiktokTags(detail), body),
      metrics,
      source: metrics?.source || "tiktok_public_best_effort",
    },
    { metrics, creatorHandle, source: metrics?.source || "tiktok_public_best_effort" },
  );
}

function tiktokTags(detail) {
  const textExtra = Array.isArray(detail?.textExtra) ? detail.textExtra : [];

  return textExtra.map((item) => item?.hashtagName || item?.hashtag_name || item?.name);
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

function tiktokMediaHeaders(pageUrl, cookieHeader) {
  return {
    Referer: pageUrl,
    Origin: "https://www.tiktok.com",
    ...(cookieHeader ? { Cookie: cookieHeader } : {}),
  };
}

export function isTiktokHost(host) {
  return ["tiktok.com", "www.tiktok.com", "m.tiktok.com", "vt.tiktok.com", "vm.tiktok.com", "t.tiktok.com"].includes(host);
}
