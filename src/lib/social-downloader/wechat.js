import crypto from "node:crypto";
import { URL } from "node:url";

import { AppError, ErrorCode } from "./errors";
import {
  dedupeAssets,
  fetchWithTimeout,
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
import { safeFilenamePart, titleFromBody, uniqueUrls } from "./shared";

const WECHAT_HOSTS = new Set(["weixin.qq.com", "www.weixin.qq.com", "channels.weixin.qq.com"]);
const WECHAT_API_URL = "https://channels.weixin.qq.com/finder-preview/api/feed/get_feed_info";
const WECHAT_EXTRACT_API_URL = "https://api.feeprint.com/extract/post";
const WECHAT_CHANNELS_API_URL = "https://changfengbox.top/api/download/channels/parse";
const WECHAT_DEFOU_API_URL = "https://wx.defou.ai/api/fetch_video_profile";
const WECHAT_PAGE_HEADERS = {
  ...PAGE_HEADERS,
  "user-agent":
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
  accept: "application/json, text/plain, */*",
  "accept-language": "zh-CN,zh;q=0.9,en;q=0.8",
  origin: "https://channels.weixin.qq.com",
};

export function normalizeWechatUrl(parsed) {
  const host = parsed.hostname.toLowerCase();
  const parts = parsed.pathname.split("/").filter(Boolean);
  const shortUri = host === "channels.weixin.qq.com"
    ? parsed.searchParams.get("id") || (parts[0] === "sph" ? parts[1] : "")
    : parts[0] === "sph" ? parts[1] : "";

  if (!shortUri || !/^[A-Za-z0-9_-]{4,128}$/.test(shortUri)) {
    throw new AppError(ErrorCode.UNSUPPORTED_URL, "仅支持微信视频号公开分享链接。", 400);
  }

  return {
    canonical_url: `https://weixin.qq.com/sph/${encodeURIComponent(shortUri)}`,
    shortcode: shortUri,
    kind: "share",
    platform: "wechat",
  };
}

export async function resolveWechatPost(normalized, settings) {
  const pageUrl = normalized.canonical_url;
  let officialError = null;
  let feed = {};
  let author = {};

  // The public preview API only ever returns the cover, and it can also be
  // rate-limited on its own. A failure there must not short-circuit the
  // providers below, several of which resolve the video without it.
  try {
    ({ feed, author } = await requestOfficialWechatFeed(normalized, settings));
  } catch (error) {
    officialError = error;
  }

  const resolved = await resolveWechatVideoWithProviders({
    assets: wechatAssetsFromFeed(feed, normalized.shortcode, pageUrl, author.nickname),
    normalized,
    pageUrl,
    settings,
  });

  const assets = resolved.assets;
  const fallbackErrors = resolved.errors;

  if (Object.keys(feed).length === 0 && resolved.feed) {
    feed = resolved.feed;
    author = resolved.author;
  }

  if (assets.length === 0) {
    if (officialError) {
      throw officialError;
    }

    throw new AppError(ErrorCode.NO_MEDIA_FOUND, "微信视频号页面中没有发现可下载媒体。", 404);
  }

  if (!assets.some((asset) => asset.media_type === "video")) {
    const details = fallbackErrors.filter(Boolean).join("；");
    throw new AppError(
      ErrorCode.NO_MEDIA_FOUND,
      `微信视频号只拿到了封面，所有视频解析通道均未成功${details ? `：${details}` : ""}。`,
      404,
    );
  }

  const metrics = {
    like_count: formattedInt(feed.likeCountFmt ?? feed.like_count ?? feed.likeCount),
    comment_count: formattedInt(feed.commentCountFmt ?? feed.comment_count ?? feed.commentCount),
    view_count: formattedInt(feed.playCountFmt ?? feed.viewCountFmt ?? feed.play_count ?? feed.view_count ?? feed.playCount ?? feed.viewCount),
    save_count: formattedInt(feed.favCountFmt ?? feed.fav_count ?? feed.favCount),
    share_count: formattedInt(feed.forwardCountFmt ?? feed.forward_count ?? feed.forwardCount),
    source: "wechat_channels_public",
  };
  const handle = pickSingleLineText(author.nickname, author.username, "");
  const body = pickText(feed.description, feed.desc, feed.title);

  return {
    assets: dedupeAssets(assets),
    metrics,
    creator_handle: handle,
    post_info: createPostInfo(
      {
        title: pickSingleLineText(feed.title, titleFromBody(body), handle),
        author: handle,
        author_handle: handle,
        body,
        tags: normalizeTags([], body),
        metrics,
        source: metrics.source,
      },
      { metrics, creatorHandle: handle, source: metrics.source },
    ),
    original_url: pageUrl,
  };
}

// Tried in order. Each provider is isolated: a crash or a timeout in one must
// never stop the next from running, and only when every provider fails does the
// caller surface an error to the UI.
const WECHAT_VIDEO_PROVIDERS = [
  { label: "defou 解析", run: (context) => resolveWechatWithDefouProvider(context.normalized, context.settings) },
  { label: "长风盒子中转", run: (context) => resolveWechatWithChannelsService(context.pageUrl, context.settings) },
  { label: "feeprint 提取", run: (context) => resolveWechatWithServerExtractor(context.pageUrl, context.settings) },
];

async function resolveWechatVideoWithProviders(context) {
  let assets = context.assets;
  let feed = {};
  let author = {};
  const errors = [];
  const hasVideo = () => assets.some((asset) => asset.media_type === "video");

  for (const provider of WECHAT_VIDEO_PROVIDERS) {
    if (hasVideo()) {
      break;
    }

    let result;

    try {
      result = await provider.run(context);
    } catch (error) {
      errors.push(`${provider.label}：${describeProviderError(error)}`);
      continue;
    }

    if (result?.error) {
      errors.push(`${provider.label}：${result.error}`);
    }

    const found = Array.isArray(result?.assets) ? result.assets : [];

    if (found.length === 0) {
      continue;
    }

    const video = found.find((asset) => asset.media_type === "video");

    // A provider can answer with a well-formed payload whose media URL is
    // already dead (expired signature, blocked region, hotlink protection).
    // Probe it first so the next provider still gets a turn instead of failing
    // later during the download step.
    if (video && !(await isWechatVideoUrlReachable(video, context.settings))) {
      errors.push(`${provider.label}：返回的视频地址无法访问`);
      continue;
    }

    assets = [...found, ...assets];

    if (Object.keys(feed).length === 0 && result.feed && Object.keys(result.feed).length > 0) {
      feed = result.feed;
      author = result.author && typeof result.author === "object" ? result.author : {};
    }
  }

  return { assets, feed, author, errors };
}

async function isWechatVideoUrlReachable(asset, settings) {
  const url = asset?.source_url;

  if (!url) {
    return false;
  }

  const headers = { ...(asset.request_headers || {}) };
  const timeout = Math.min(settings.httpTimeoutMs, 6_000);

  try {
    let response = await fetchWithTimeout(
      url,
      { method: "HEAD", headers, cache: "no-store" },
      timeout,
    );

    // Some CDN edges reject HEAD while serving GET normally.
    if (response.status === 403 || response.status === 405) {
      response = await fetchWithTimeout(
        url,
        { method: "GET", headers: { ...headers, range: "bytes=0-0" }, cache: "no-store" },
        timeout,
      );
    }

    if (response.body?.cancel) {
      await response.body.cancel().catch(() => {});
    }

    return response.ok || response.status === 206;
  } catch {
    return false;
  }
}

function describeProviderError(error) {
  if (error instanceof AppError) {
    return error.message || error.code || "解析失败";
  }

  if (error?.name === "AbortError") {
    return "请求超时";
  }

  if (error instanceof Error) {
    return error.message || error.name;
  }

  return String(error || "未知错误");
}

async function requestOfficialWechatFeed(normalized, settings) {
  const refererUrl = `https://channels.weixin.qq.com/finder-preview/pages/sph?id=${encodeURIComponent(normalized.shortcode)}`;
  let response;

  try {
    response = await fetchWithTimeout(
      WECHAT_API_URL,
      {
        method: "POST",
        headers: {
          ...WECHAT_PAGE_HEADERS,
          referer: refererUrl,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          baseReq: { generalToken: "" },
          shortUri: normalized.shortcode,
        }),
        cache: "no-store",
      },
      settings.httpTimeoutMs,
    );
  } catch (error) {
    if (error?.name === "AbortError") {
      throw new AppError(ErrorCode.UPSTREAM_BLOCKED, "微信视频号页面请求超时。", 504);
    }

    throw new AppError(ErrorCode.UPSTREAM_BLOCKED, "无法访问微信视频号公开页面。", 502);
  }

  if (!response.ok) {
    throw new AppError(
      response.status === 404 ? ErrorCode.NO_MEDIA_FOUND : ErrorCode.UPSTREAM_BLOCKED,
      response.status === 404 ? "没有找到这个微信视频号内容。" : `微信视频号返回异常状态码 ${response.status}。`,
      response.status === 404 ? 404 : 502,
    );
  }

  let payload;

  try {
    payload = await response.json();
  } catch {
    throw new AppError(ErrorCode.UPSTREAM_BLOCKED, "微信视频号返回了无效响应。", 502);
  }

  if (payload?.errCode != null && Number(payload.errCode) !== 0) {
    throw new AppError(
      ErrorCode.NO_MEDIA_FOUND,
      payload.errMsg || payload?.data?.errMsg?.title || "微信视频号内容暂时无法播放。",
      404,
    );
  }

  const data = payload?.data && typeof payload.data === "object" ? payload.data : {};

  return {
    feed: data.feedInfo && typeof data.feedInfo === "object" ? data.feedInfo : {},
    author: data.authorInfo && typeof data.authorInfo === "object" ? data.authorInfo : {},
  };
}

// Third-party resolver that returns the signed finder.video.qq.com URL instead
// of a re-hosted copy, so the media comes straight from Tencent's CDN.
async function resolveWechatWithDefouProvider(normalized, settings) {
  if (process.env.WECHAT_DEFOU_ENABLED === "0") {
    return { assets: [], feed: {}, author: {}, error: null };
  }

  const endpoint = process.env.WECHAT_DEFOU_API_URL?.trim() || WECHAT_DEFOU_API_URL;
  const pageUrl = normalized.canonical_url;
  let response;

  try {
    response = await fetchWithTimeout(
      endpoint,
      {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ url: pageUrl }),
        cache: "no-store",
      },
      Math.min(settings.httpTimeoutMs, 15_000),
    );
  } catch (error) {
    return {
      assets: [],
      feed: {},
      author: {},
      error: error?.name === "AbortError" ? "视频号解析服务请求超时" : "无法访问视频号解析服务",
    };
  }

  if (!response.ok) {
    return { assets: [], feed: {}, author: {}, error: `视频号解析服务返回 ${response.status}` };
  }

  let payload;

  try {
    payload = await response.json();
  } catch {
    return { assets: [], feed: {}, author: {}, error: "视频号解析服务返回了无效响应" };
  }

  const data = payload?.data && typeof payload.data === "object" ? payload.data : {};
  const feed = data.feedInfo && typeof data.feedInfo === "object" ? data.feedInfo : {};
  const author = data.authorInfo && typeof data.authorInfo === "object" ? data.authorInfo : {};
  const assets = wechatAssetsFromFeed(feed, normalized.shortcode, pageUrl, author.nickname);

  return {
    assets,
    feed,
    author,
    error: assets.some((asset) => asset.media_type === "video")
      ? null
      : "视频号解析服务没有返回视频地址",
  };
}

async function resolveWechatWithChannelsService(pageUrl, settings) {
  if (process.env.WECHAT_CHANNELS_API_ENABLED === "0") {
    return { assets: [], error: null };
  }

  const endpoint = process.env.WECHAT_CHANNELS_API_URL?.trim() || WECHAT_CHANNELS_API_URL;
  const secret = process.env.WECHAT_CHANNELS_API_SECRET?.trim() || "changfengbox.top";
  const timestamp = Math.floor(Date.now() / 1000);
  const sign = crypto.createHash("md5").update(`${timestamp}${secret}`).digest("hex");
  let response;

  try {
    response = await fetchWithTimeout(
      endpoint,
      {
        method: "POST",
        headers: {
          ...WECHAT_PAGE_HEADERS,
          "content-type": "application/json",
          "x-timestamp": String(timestamp),
          "x-sign": sign,
        },
        body: JSON.stringify({ url: pageUrl }),
        cache: "no-store",
      },
      settings.httpTimeoutMs,
    );
  } catch (error) {
    return {
      assets: [],
      error: error?.name === "AbortError" ? "微信视频中转服务请求超时" : "无法访问微信视频中转服务",
    };
  }

  if (!response.ok) {
    return { assets: [], error: `微信视频中转服务返回 ${response.status}` };
  }

  let payload;
  try {
    payload = await response.json();
  } catch {
    return { assets: [], error: "微信视频中转服务返回了无效响应" };
  }

  const urls = Array.isArray(payload?.urls) ? payload.urls : [];
  const base = safeFilenamePart(payload?.filename?.replace(/\.[^.]+$/, "")) || "wechat_video";
  const source = urls.find((url) => typeof url === "string" && /^https?:\/\//i.test(url));
  if (!source) {
    return { assets: [], error: "微信视频中转服务没有返回视频地址" };
  }

  return {
    assets: [{
      source_url: htmlUnescape(source),
      media_type: "video",
      width: null,
      height: null,
      filename_hint: `${base}.mp4`,
      request_headers: { "user-agent": WECHAT_PAGE_HEADERS["user-agent"] },
    }],
    error: null,
  };
}

async function resolveWechatWithServerExtractor(pageUrl, settings) {
  const apiKey = process.env.WECHAT_EXTRACT_API_KEY?.trim();
  if (!apiKey) {
    return { assets: [], error: "未配置 WECHAT_EXTRACT_API_KEY" };
  }

  const endpoint = process.env.WECHAT_EXTRACT_API_URL?.trim() || WECHAT_EXTRACT_API_URL;
  let response;
  try {
    response = await fetchWithTimeout(
      endpoint,
      {
        method: "POST",
        headers: {
          ...WECHAT_PAGE_HEADERS,
          "content-type": "application/json",
          "x-api-key": apiKey,
          "g-device-type": "desktop",
          "g-origin": process.env.WECHAT_EXTRACT_ORIGIN?.trim() || "https://www.henghengmao.com",
        },
        body: JSON.stringify({ url: pageUrl }),
        cache: "no-store",
      },
      settings.httpTimeoutMs,
    );
  } catch (error) {
    return {
      assets: [],
      error: error?.name === "AbortError" ? "微信提取 API 请求超时" : "无法访问微信提取 API",
    };
  }

  if (!response.ok) {
    return { assets: [], error: `微信提取 API 返回 ${response.status}` };
  }

  let payload;
  try {
    payload = await response.json();
  } catch {
    return { assets: [], error: "微信提取 API 返回了无效响应" };
  }

  const assets = wechatAssetsFromExtractorPayload(payload, pageUrl);
  return {
    assets,
    error: assets.some((asset) => asset.media_type === "video")
      ? null
      : "微信提取 API 没有返回视频文件",
  };
}

function wechatAssetsFromExtractorPayload(payload, pageUrl) {
  const candidates = [payload, payload?.data, payload?.result, payload?.post].filter(Boolean);
  const medias = candidates.flatMap((value) => Array.isArray(value) ? value : value?.medias || []);
  const base = `wechat_${safeFilenamePart(pageUrl.split("/").pop())}`;
  const headers = {
    referer: pageUrl,
    origin: "https://channels.weixin.qq.com",
    "user-agent": WECHAT_PAGE_HEADERS["user-agent"],
  };

  return medias
    .map((media, index) => {
      const url = media?.resource_url || media?.resourceUrl || media?.video_url || media?.videoUrl;
      if (typeof url !== "string" || !/^https?:\/\//i.test(url)) {
        return null;
      }
      const isVideo = media?.media_type === "video" || media?.mediaType === "video" || /\/stodownload/i.test(url) && /(?:20302|video)/i.test(url);
      return {
        source_url: htmlUnescape(url),
        media_type: isVideo ? "video" : "image",
        filename_hint: `${base}_${isVideo ? "video" : "photo"}_${index + 1}.${isVideo ? "mp4" : "jpg"}`,
        request_headers: headers,
      };
    })
    .filter(Boolean)
    .sort((a, b) => (a.media_type === "video" ? -1 : 1) - (b.media_type === "video" ? -1 : 1));
}

function wechatAssetsFromFeed(feed, shortcode, pageUrl, nickname) {
  const base = `wechat_${safeFilenamePart(nickname)}_${safeFilenamePart(shortcode)}`;
  const previewPageUrl = `https://channels.weixin.qq.com/finder-preview/pages/sph?id=${encodeURIComponent(shortcode)}`;
  const headers = {
    referer: previewPageUrl,
    origin: "https://channels.weixin.qq.com",
    "user-agent": WECHAT_PAGE_HEADERS["user-agent"],
    accept: "image/avif,image/webp,image/apng,image/*,video/*,*/*;q=0.8",
  };
  const assets = [];
  // H.264 first: H.265 files are smaller but far less portable once the user
  // moves them into an editor or an older player.
  const videoUrls = uniqueUrls([
    feed?.h264VideoInfo?.videoUrl,
    feed?.h265VideoInfo?.videoUrl,
    feed?.videoUrl,
    feed?.video_url,
    feed?.videoInfo?.videoUrl,
  ].filter((value) => typeof value === "string").map(htmlUnescape));

  if (videoUrls.length > 0) {
    assets.push({
      source_url: videoUrls[0],
      fallback_urls: videoUrls.slice(1),
      media_type: "video",
      width: optionalInt(feed?.h264VideoInfo?.width || feed?.h265VideoInfo?.width || feed?.width),
      height: optionalInt(feed?.h264VideoInfo?.height || feed?.h265VideoInfo?.height || feed?.height),
      filename_hint: `${base}.mp4`,
      request_headers: headers,
    });
  }

  const pictures = Array.isArray(feed.picInfo) ? feed.picInfo : [];
  pictures.forEach((picture, index) => {
    const url = typeof picture === "string"
      ? picture
      : picture?.url || picture?.picUrl || picture?.pic_url || picture?.imageUrl;

    if (url) {
      assets.push({
        source_url: htmlUnescape(url),
        media_type: "image",
        filename_hint: `${base}_photo_${index + 1}.jpg`,
        request_headers: headers,
      });
    }
  });

  if (assets.length === 0 && typeof feed.coverUrl === "string" && feed.coverUrl) {
    assets.push({
      source_url: htmlUnescape(feed.coverUrl),
      media_type: "image",
      filename_hint: `${base}.jpg`,
      request_headers: headers,
    });
  }

  return assets.filter((asset) => /^https?:\/\//i.test(asset.source_url));
}

function formattedInt(value) {
  if (value == null || value === "") {
    return null;
  }

  const text = String(value).trim();
  const match = /^(\d+(?:\.\d+)?)(亿|万|w|k|千)?$/i.exec(text);

  if (!match) {
    return optionalInt(text);
  }

  const number = Number.parseFloat(match[1]);
  const unit = match[2]?.toLowerCase();
  const multiplier = unit === "亿" ? 100_000_000 : unit === "万" || unit === "w" ? 10_000 : unit === "k" || unit === "千" ? 1_000 : 1;

  return Number.isFinite(number) ? Math.round(number * multiplier) : null;
}

export function isWechatHost(host) {
  const value = String(host || "").toLowerCase();
  return WECHAT_HOSTS.has(value) || value.endsWith(".weixin.qq.com");
}
