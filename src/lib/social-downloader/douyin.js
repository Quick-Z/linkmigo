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
  firstUrlFromList,
  jsonFromAssignment,
  resolveRedirect,
  safeFilenamePart,
  titleFromBody,
} from "./shared";
import { douyinAwemeIdFromUrl, resolveDouyinDetailWithBrowser } from "./douyin-browser";

const DOUYIN_MOBILE_HEADERS = {
  ...PAGE_HEADERS,
  "user-agent":
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
  accept:
    "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
  "accept-language": "zh-CN,zh;q=0.9,en;q=0.8",
};

// Media CDN requests made on behalf of the browser-rendered (`www.douyin.com`)
// page; keep the UA consistent with the one the headless browser reports.
const DOUYIN_DESKTOP_HEADERS = {
  ...PAGE_HEADERS,
  "user-agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36",
  "accept-language": "zh-CN,zh;q=0.9,en;q=0.8",
};

export function normalizeDouyinUrl(parsed) {
  const parts = parsed.pathname.split("/").filter(Boolean);
  const host = parsed.hostname.toLowerCase();
  let postId = "";
  let contentType = "video";

  for (let index = 0; index < parts.length; index += 1) {
    if (["video", "note", "slides"].includes(parts[index]) && parts[index + 1]) {
      postId = parts[index + 1];
      contentType = parts[index];
      break;
    }
  }

  if (postId && /^\d{8,32}$/.test(postId)) {
    return {
      canonical_url: `https://www.iesdouyin.com/share/${contentType}/${postId}/`,
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
  const resolved = await loadDouyinDetail(normalized, settings);
  const detail = resolved.detail;
  const postId = resolved.postId;
  const author = detail.author && typeof detail.author === "object" ? detail.author : {};
  const handle = author.unique_id || author.short_id || author.nickname || "unknown";
  const filenameBase = `douyin_${safeFilenamePart(handle)}_${postId}`;
  const mediaHeaders = douyinMediaHeaders(resolved.mediaReferer);
  const assets = douyinAssetsFromDetail(detail, filenameBase, mediaHeaders);
  const metrics = metricsFromDouyin(detail, resolved.source);

  return {
    assets: dedupeAssets(assets),
    metrics,
    creator_handle: handle,
    post_info: postInfoFromDouyin(detail, metrics, handle),
  };
}

// Douyin used to server-render the whole video payload into the share page's
// `window._ROUTER_DATA`. That stopped working (the share page is now a shell),
// so the headless-browser path is the one that actually returns the detail.
// The cheap HTTP path is still tried first because it costs ~1s when Douyin
// re-enables SSR, and it also covers the short-link redirect.
async function loadDouyinDetail(normalized, settings) {
  let postId = isDouyinPostId(normalized.shortcode) ? normalized.shortcode : "";
  let inputUrl = normalized.canonical_url;
  let contentType = douyinContentTypeFromUrl(inputUrl);

  if (normalized.kind === "short") {
    const redirected = await resolveRedirect(normalized.canonical_url, settings);
    if (redirected) {
      inputUrl = redirected;
      postId = douyinAwemeIdFromUrl(redirected) || postId;
      contentType = douyinContentTypeFromUrl(redirected) || contentType;
    }
  }

  if (postId) {
    const shareDetail = await fetchDouyinShareDetail(postId, contentType, settings);

    if (shareDetail) {
      return {
        detail: shareDetail,
        postId,
        source: "douyin_public_best_effort",
        mediaReferer: `https://www.iesdouyin.com/share/${contentType}/${postId}/`,
      };
    }
  }

  const rendered = await resolveDouyinDetailWithBrowser({
    awemeId: postId,
    contentType,
    pageUrl: inputUrl,
    timeoutMs: settings.douyinBrowserTimeoutMs,
  });
  const renderedId =
    douyinAwemeIdFromUrl(rendered.pageUrl) ||
    postId ||
    String(rendered.detail?.aweme_id || "");
  // Only trust media sniffed off the page when it really is the requested
  // work: Douyin redirects deleted ids to the discover feed, where the page
  // plays an unrelated video.
  const capturedDetail = rendered.matchedRequestedAweme
    ? douyinDetailFromCapturedMedia(rendered.mediaUrls, renderedId)
    : null;
  const detail = rendered.detail || capturedDetail;

  if (!detail) {
    throw new AppError(
      ErrorCode.NO_MEDIA_FOUND,
      rendered.matchedRequestedAweme
        ? "抖音页面没有返回可下载的视频信息，可能视频已删除或需要验证。"
        : "这个抖音作品不存在、已删除，或链接已失效。",
      404,
      {
        page_url: rendered.pageUrl || "",
        detail: rendered.diagnostics || "",
      },
    );
  }

  if (!isDouyinPostId(renderedId)) {
    throw new AppError(ErrorCode.NO_MEDIA_FOUND, "抖音短链接没有解析到视频 ID。", 404);
  }

  return {
    detail,
    postId: renderedId,
    source: "douyin_browser",
    mediaReferer: "https://www.douyin.com/",
  };
}

async function fetchDouyinShareDetail(postId, contentType, settings) {
  try {
    const text = await fetchText({
      url: `https://www.iesdouyin.com/share/${contentType}/${postId}/?from=web_code_link`,
      headers: DOUYIN_MOBILE_HEADERS,
      label: "Douyin",
      // Douyin currently answers with a shell page, so keep this probe short
      // instead of letting it eat the browser budget.
      timeoutMs: Math.min(settings.httpTimeoutMs, 8_000),
    });

    return firstDouyinItem(jsonFromAssignment(text, "window._ROUTER_DATA"));
  } catch {
    // The share page is usually a shell now; fall through to the browser path.
    return null;
  }
}

function douyinContentTypeFromUrl(value) {
  const match = /\/(video|note|slides)\/\d{8,32}/.exec(String(value || ""));

  return match ? match[1] : "video";
}

function douyinDetailFromCapturedMedia(mediaUrls, postId) {
  const url = (Array.isArray(mediaUrls) ? mediaUrls : []).find(
    (candidate) => typeof candidate === "string" && /^https?:\/\//i.test(candidate),
  );

  if (!url) {
    return null;
  }

  return {
    aweme_id: postId || "",
    video: { play_addr: { url_list: [url] } },
  };
}

function isDouyinPostId(value) {
  return /^\d{8,32}$/.test(String(value || ""));
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

// Douyin serves 图文 images through a CDN template that ends in `.webp`
// (e.g. `...~tplv-dy-aweme-images:q75.webp`), so don't label the download `.jpg`.
function douyinImageExtension(url) {
  let pathname = "";

  try {
    pathname = new URL(String(url)).pathname;
  } catch {
    pathname = String(url || "").split("?")[0];
  }

  const match = /\.(jpe?g|png|webp|heic|avif|gif)$/i.exec(pathname);

  return match ? `.${match[1].toLowerCase()}` : ".jpg";
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
          filename_hint: `${filenameBase}_photo_${index + 1}${douyinImageExtension(imageUrl)}`,
          request_headers: mediaHeaders,
        });
      }
    });
  } else {
    const videoCandidates = douyinVideoCandidates(detail);
    const best = videoCandidates[0];

    if (best) {
      assets.push({
        source_url: best.url,
        fallback_urls: videoCandidates.slice(1).map((candidate) => candidate.url),
        media_type: "video",
        width: best.width ?? optionalInt(dig(detail, "video", "width")),
        height: best.height ?? optionalInt(dig(detail, "video", "height")),
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

// Douyin's detail payload carries a quality ladder in `video.bit_rate`, and
// `play_addr.url_list[0]` is not always the top rung (it can be a 540p stream
// while `video.width/height` still describes the 1080p master). Sort the ladder
// by bitrate and fall back to the plain play/download addresses.
function douyinVideoCandidates(detail) {
  const candidates = [];
  const seen = new Set();

  for (const rendition of douyinBitRateRenditions(detail)) {
    addDouyinVideoCandidate(candidates, seen, rendition.play_addr, rendition.bit_rate);
  }

  for (const path of [
    ["video", "play_addr"],
    ["video", "play_addr_h264"],
    ["video", "download_addr"],
  ]) {
    addDouyinVideoCandidate(candidates, seen, dig(detail, ...path));
  }

  return candidates;
}

function douyinBitRateRenditions(detail) {
  const renditions = dig(detail, "video", "bit_rate");

  if (!Array.isArray(renditions)) {
    return [];
  }

  return renditions
    .filter((rendition) => rendition && typeof rendition === "object")
    .slice()
    .sort((a, b) => (optionalInt(b.bit_rate) ?? 0) - (optionalInt(a.bit_rate) ?? 0));
}

function addDouyinVideoCandidate(candidates, seen, address, bitRate = null) {
  const urls = Array.isArray(address?.url_list) ? address.url_list : [];

  for (const url of urls) {
    if (typeof url !== "string" || !/^https?:\/\//i.test(url)) {
      continue;
    }

    const value = htmlUnescape(url);

    // Image posts carry a placeholder `video.play_addr` that actually points at
    // the background music, so never let an audio URL become the "video" asset.
    if (isDouyinAudioUrl(value)) {
      continue;
    }

    if (seen.has(value)) {
      continue;
    }

    seen.add(value);
    candidates.push({
      url: value,
      width: optionalInt(address?.width),
      height: optionalInt(address?.height),
      bit_rate: optionalInt(bitRate),
    });
  }
}

function isDouyinAudioUrl(value) {
  return /\.mp3(?:[?#]|$)/i.test(value) || /ies-music/i.test(value);
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

function metricsFromDouyin(detail, source = "douyin_public_best_effort") {
  const stats = detail?.statistics && typeof detail.statistics === "object" ? detail.statistics : {};

  return {
    like_count: optionalInt(stats.digg_count),
    comment_count: optionalInt(stats.comment_count),
    view_count: optionalInt(stats.play_count),
    save_count: optionalInt(stats.collect_count),
    share_count: optionalInt(stats.share_count),
    source,
  };
}

function douyinMediaHeaders(referer) {
  const origin = douyinOriginFromUrl(referer);

  return {
    Referer: referer,
    Origin: origin,
    "user-agent": DOUYIN_DESKTOP_HEADERS["user-agent"],
    accept: "image/avif,image/webp,image/apng,image/*,video/*,*/*;q=0.8",
    "accept-language": "zh-CN,zh;q=0.9,en;q=0.8",
  };
}

function douyinOriginFromUrl(value) {
  try {
    return new URL(String(value)).origin;
  } catch {
    return "https://www.douyin.com";
  }
}

export function isDouyinHost(host) {
  return ["douyin.com", "www.douyin.com", "m.douyin.com", "v.douyin.com", "iesdouyin.com", "www.iesdouyin.com"].includes(host);
}
