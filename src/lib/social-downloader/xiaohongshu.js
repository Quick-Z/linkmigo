import { URL } from "node:url";

import { AppError, ErrorCode } from "./errors";
import {
  cleanUrl,
  dedupeAssets,
  dig,
  fetchTextResponse,
  firstPresentInt,
  htmlUnescape,
  metaContents,
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
  balancedJsonEndIndex,
  createMetrics,
  postInfoFromHtmlMeta,
  resolveRedirect,
  safeFilenamePart,
  titleFromBody,
} from "./shared";

const XIAOHONGSHU_HEADERS = {
  ...PAGE_HEADERS,
  accept:
    "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
  "accept-language": "zh-CN,zh;q=0.9,en;q=0.8",
  Referer: "https://www.xiaohongshu.com/",
};

export function normalizeXiaohongshuUrl(parsed) {
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

export async function resolveXiaohongshuPost(normalized, settings) {
  let active = normalized;

  if (active.kind === "short") {
    const redirected = await resolveRedirect(active.canonical_url, settings, XIAOHONGSHU_HEADERS);

    if (redirected) {
      active = normalizeXiaohongshuUrl(new URL(redirected));
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
      const metrics = createMetrics("xiaohongshu_public_best_effort");

      return {
        assets: dedupeAssets(fallbackAssets),
        metrics,
        creator_handle: "",
        post_info: postInfoFromHtmlMeta(text, metrics, ""),
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

  const metrics = metricsFromXiaohongshu(note);

  return {
    assets: dedupeAssets(assets),
    metrics,
    creator_handle: handle,
    post_info: postInfoFromXiaohongshu(note, metrics, handle),
  };
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

function postInfoFromXiaohongshu(note, metrics, creatorHandle) {
  const user = note?.user && typeof note.user === "object" ? note.user : {};
  const body = pickText(note?.desc, note?.description, note?.content);

  return createPostInfo(
    {
      title: pickSingleLineText(note?.title, titleFromBody(body)),
      author: pickSingleLineText(user.nickname, user.nickName, creatorHandle),
      author_handle: pickSingleLineText(user.userId, user.user_id, creatorHandle),
      body,
      tags: normalizeTags(xiaohongshuTags(note), body),
      metrics,
      source: metrics?.source || "xiaohongshu_public_best_effort",
    },
    { metrics, creatorHandle, source: metrics?.source || "xiaohongshu_public_best_effort" },
  );
}

function xiaohongshuTags(note) {
  const values = [];

  for (const key of ["tagList", "hashTagList", "hashTags", "topicList"]) {
    if (Array.isArray(note?.[key])) {
      values.push(...note[key]);
    }
  }

  return values;
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

function xiaohongshuMediaHeaders(pageUrl) {
  return {
    Referer: pageUrl,
    Origin: "https://www.xiaohongshu.com",
    "user-agent": XIAOHONGSHU_HEADERS["user-agent"],
    accept: "image/avif,image/webp,image/apng,image/*,video/*,*/*;q=0.8",
    "accept-language": XIAOHONGSHU_HEADERS["accept-language"],
  };
}

export function isXiaohongshuHost(host) {
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
