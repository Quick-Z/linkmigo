import { URL } from "node:url";

import { AppError, ErrorCode } from "./errors";
import {
  cleanUrl,
  dedupeAssets,
  dig,
  fetchText,
  htmlUnescape,
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
  addUrlCandidate,
  firstUrlFromList,
  jsonFromAssignment,
  resolveRedirect,
  safeFilenamePart,
  titleFromBody,
  uniqueUrls,
} from "./shared";

const DOUYIN_MOBILE_HEADERS = {
  ...PAGE_HEADERS,
  "user-agent":
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
  accept:
    "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
  "accept-language": "zh-CN,zh;q=0.9,en;q=0.8",
};

export function normalizeDouyinUrl(parsed) {
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

export async function resolveDouyinPost(normalized, settings) {
  let postId = normalized.shortcode;

  if (normalized.kind === "short") {
    const redirected = await resolveRedirect(normalized.canonical_url, settings);

    if (redirected) {
      postId = normalizeDouyinUrl(new URL(redirected)).shortcode;
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
  const metrics = metricsFromDouyin(detail);

  return {
    assets: dedupeAssets(assets),
    metrics,
    creator_handle: handle,
    post_info: postInfoFromDouyin(detail, metrics, handle),
  };
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

function postInfoFromDouyin(detail, metrics, creatorHandle) {
  const author = detail?.author && typeof detail.author === "object" ? detail.author : {};
  const body = pickText(detail?.desc, detail?.description);

  return createPostInfo(
    {
      title: pickSingleLineText(detail?.title, titleFromBody(body)),
      author: pickSingleLineText(author.nickname, author.name, creatorHandle),
      author_handle: pickSingleLineText(author.unique_id, author.short_id, creatorHandle),
      body,
      tags: normalizeTags(douyinTags(detail), body),
      metrics,
      source: metrics?.source || "douyin_public_best_effort",
    },
    { metrics, creatorHandle, source: metrics?.source || "douyin_public_best_effort" },
  );
}

function douyinTags(detail) {
  const textExtra = Array.isArray(detail?.text_extra) ? detail.text_extra : [];

  return textExtra.map((item) => item?.hashtag_name || item?.hashtagName || item?.name);
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

function douyinMediaHeaders(pageUrl) {
  return {
    Referer: pageUrl,
    Origin: "https://www.iesdouyin.com",
    "user-agent": DOUYIN_MOBILE_HEADERS["user-agent"],
    accept: "image/avif,image/webp,image/apng,image/*,video/*,*/*;q=0.8",
    "accept-language": DOUYIN_MOBILE_HEADERS["accept-language"],
  };
}

export function isDouyinHost(host) {
  return ["douyin.com", "www.douyin.com", "m.douyin.com", "v.douyin.com", "iesdouyin.com", "www.iesdouyin.com"].includes(host);
}
