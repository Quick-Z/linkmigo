import { URL } from "node:url";

import { AppError, ErrorCode } from "./errors";
import {
  dedupeAssets,
  fetchTextResponse,
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
import { addUrlCandidate, jsonFromAssignment, safeFilenamePart, titleFromBody, uniqueUrls } from "./shared";

const ACFUN_MOBILE_HEADERS = {
  ...PAGE_HEADERS,
  "user-agent":
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Mobile/15E148 Safari/604.1",
  accept:
    "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
  "accept-language": "zh-CN,zh;q=0.9,en;q=0.8",
  Referer: "https://m.acfun.cn/",
};

export function normalizeAcfunUrl(parsed) {
  const parts = parsed.pathname.split("/").filter(Boolean);
  let videoId = "";

  if (parts[0] === "v" && parts[1]) {
    videoId = acfunVideoIdFromValue(parts[1]);
  }

  if (!videoId) {
    videoId = acfunVideoIdFromValue(parsed.searchParams.get("ac"));
  }

  if (!videoId) {
    throw new AppError(ErrorCode.UNSUPPORTED_URL, "仅支持 AcFun 视频链接。", 400);
  }

  const canonical = new URL(`https://www.acfun.cn/v/ac${videoId}`);
  const vid = parsed.searchParams.get("vid");

  if (vid && /^\d{3,32}$/.test(vid)) {
    canonical.searchParams.set("vid", vid);
  }

  return {
    canonical_url: canonical.toString(),
    shortcode: videoId,
    kind: "video",
    platform: "acfun",
  };
}

function acfunVideoIdFromValue(value) {
  const text = String(value || "").trim();
  const match = /^(?:ac)?(\d{3,32})$/i.exec(text);

  return match ? match[1] : "";
}

export async function resolveAcfunPost(normalized, settings) {
  const pageUrl = acfunMobilePageUrl(normalized);
  const pageResponse = await fetchTextResponse({
    url: pageUrl,
    headers: ACFUN_MOBILE_HEADERS,
    label: "AcFun",
    timeoutMs: settings.httpTimeoutMs,
  });
  const text = pageResponse.text;
  const videoInfo = extractAcfunAssignment(text, "videoInfo");
  const playInfo = extractAcfunAssignment(text, "playInfo");

  if (!playInfo) {
    throw new AppError(ErrorCode.NO_MEDIA_FOUND, "AcFun 页面中没有发现可下载视频。", 404);
  }

  const handle = acfunCreatorHandle(videoInfo, text);
  const filenameBase = `acfun_${safeFilenamePart(handle)}_${normalized.shortcode}`;
  const assets = acfunAssetsFromPlayInfo(playInfo, filenameBase, pageUrl);

  if (assets.length === 0) {
    throw new AppError(ErrorCode.NO_MEDIA_FOUND, "AcFun 页面中没有发现可下载视频。", 404);
  }

  const metrics = metricsFromAcfun(videoInfo);

  return {
    assets: dedupeAssets(assets),
    metrics,
    creator_handle: handle === "unknown" ? "" : handle,
    post_info: postInfoFromAcfun(videoInfo, metrics, handle === "unknown" ? "" : handle),
  };
}

function extractAcfunAssignment(text, name) {
  return (
    jsonFromAssignment(text, `var ${name}`) ||
    jsonFromAssignment(text, `window.${name}`) ||
    jsonFromAssignment(text, name)
  );
}

function acfunMobilePageUrl(normalized) {
  const mobileUrl = new URL("https://m.acfun.cn/v/");

  mobileUrl.searchParams.set("ac", normalized.shortcode);

  try {
    const canonical = new URL(normalized.canonical_url);
    const vid = canonical.searchParams.get("vid");

    if (vid) {
      mobileUrl.searchParams.set("vid", vid);
    }
  } catch {
    // The normalizer already validates canonical URLs.
  }

  return mobileUrl.toString();
}

function acfunAssetsFromPlayInfo(playInfo, filenameBase, pageUrl) {
  const streams = Array.isArray(playInfo?.streams)
    ? playInfo.streams.filter((stream) => stream && typeof stream === "object")
    : [];

  if (streams.length === 0) {
    return [];
  }

  const best = streams.reduce((current, candidate) =>
    acfunStreamScore(candidate) > acfunStreamScore(current) ? candidate : current,
  );
  const urls = acfunStreamUrls(best);

  if (urls.length === 0) {
    return [];
  }

  const quality = safeFilenamePart(best.qualityType || best.qualityLabel || `${best.height || "video"}p`);

  return [
    {
      source_url: urls[0],
      fallback_urls: urls.slice(1),
      media_type: "video",
      width: optionalInt(best.width),
      height: optionalInt(best.height),
      filename_hint: `${filenameBase}_${quality}.mp4`,
      request_headers: acfunMediaHeaders(pageUrl),
    },
  ];
}

function acfunStreamUrls(stream) {
  const values = [
    stream?.playUrls,
    stream?.cdnUrls,
    stream?.url,
    stream?.playUrl,
  ].flatMap((value) => Array.isArray(value) ? value : [value]);
  const urls = [];

  for (const value of values) {
    if (typeof value === "string") {
      addUrlCandidate(urls, value);
    } else if (value && typeof value === "object") {
      addUrlCandidate(urls, value.url);
    }
  }

  return uniqueUrls(urls);
}

function acfunStreamScore(stream) {
  const width = optionalInt(stream?.width) || 0;
  const height = optionalInt(stream?.height) || acfunQualityHeight(stream) || 0;
  const size = optionalInt(stream?.size) || 0;

  return width * height + height * 10_000 + size / 1024;
}

function acfunQualityHeight(stream) {
  const label = String(stream?.qualityType || stream?.qualityLabel || "");
  const match = /(\d{3,4})p/i.exec(label);

  return match ? optionalInt(match[1]) : null;
}

function postInfoFromAcfun(videoInfo, metrics, creatorHandle) {
  const body = pickText(videoInfo?.description, videoInfo?.desc, videoInfo?.intro);

  return createPostInfo(
    {
      title: pickSingleLineText(videoInfo?.title, videoInfo?.caption, titleFromBody(body)),
      author: creatorHandle,
      author_handle: creatorHandle,
      body,
      tags: normalizeTags(acfunTags(videoInfo), body),
      metrics,
      source: metrics?.source || "acfun_public_best_effort",
    },
    { metrics, creatorHandle, source: metrics?.source || "acfun_public_best_effort" },
  );
}

function acfunTags(videoInfo) {
  const values = [];

  for (const key of ["tagList", "tags", "tagNames"]) {
    if (Array.isArray(videoInfo?.[key])) {
      values.push(...videoInfo[key]);
    }
  }

  return values;
}

function metricsFromAcfun(videoInfo) {
  return {
    like_count: parseAcfunCount(videoInfo?.likeCount ?? videoInfo?.likeCountShow),
    comment_count: parseAcfunCount(videoInfo?.commentCount ?? videoInfo?.commentCountShow),
    view_count: parseAcfunCount(videoInfo?.playNum ?? videoInfo?.viewCount ?? videoInfo?.viewCountShow),
    save_count: parseAcfunCount(videoInfo?.stowCount ?? videoInfo?.collectionCount ?? videoInfo?.favoriteCount),
    share_count: parseAcfunCount(videoInfo?.shareCount ?? videoInfo?.shareCountShow),
    source: "acfun_public_best_effort",
  };
}

function parseAcfunCount(value) {
  if (value == null || value === "" || typeof value === "boolean") {
    return null;
  }

  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.trunc(value);
  }

  const text = String(value).trim().replaceAll(",", "");

  if (!text || ["播放", "评论", "收藏", "分享", "点赞", "香蕉"].includes(text)) {
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

function acfunCreatorHandle(videoInfo, text) {
  const candidates = [
    videoInfo?.user,
    videoInfo?.owner,
    videoInfo?.up,
    videoInfo?.author,
  ];

  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== "object") {
      continue;
    }

    for (const key of ["name", "userName", "nickname", "upName", "authorName"]) {
      if (candidate[key]) {
        return String(candidate[key]);
      }
    }
  }

  for (const key of ["userName", "upName", "ownerName", "authorName"]) {
    if (videoInfo?.[key]) {
      return String(videoInfo[key]);
    }
  }

  const match = /class=["'][^"']*\bup-name\b[^"']*["'][^>]*>(.*?)<\/a>/is.exec(text);

  if (match) {
    const handle = htmlUnescape(match[1].replace(/<[^>]*>/g, "")).trim();

    if (handle) {
      return handle;
    }
  }

  return "unknown";
}

function acfunMediaHeaders(pageUrl) {
  return {
    Referer: pageUrl,
    Origin: "https://m.acfun.cn",
    "user-agent": ACFUN_MOBILE_HEADERS["user-agent"],
    accept: "image/avif,image/webp,image/apng,image/*,video/*,*/*;q=0.8",
    "accept-language": ACFUN_MOBILE_HEADERS["accept-language"],
  };
}

export function isAcfunHost(host) {
  return ["acfun.cn", "www.acfun.cn", "m.acfun.cn"].includes(host) || host.endsWith(".acfun.cn");
}
