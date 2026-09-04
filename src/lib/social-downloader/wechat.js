import crypto from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import fs from "node:fs/promises";
import { URL } from "node:url";
import { promisify } from "node:util";

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
const WECHAT_MEOWLOAD_CLI_PATH = "/Applications/MeowLoad.app/Contents/MacOS/meowload-cli";
const execFile = promisify(execFileCallback);
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
  const feed = data.feedInfo && typeof data.feedInfo === "object" ? data.feedInfo : {};
  const author = data.authorInfo && typeof data.authorInfo === "object" ? data.authorInfo : {};
  let assets = wechatAssetsFromFeed(feed, normalized.shortcode, pageUrl, author.nickname);
  const fallbackErrors = [];

  if (!assets.some((asset) => asset.media_type === "video")) {
    const extracted = await resolveWechatWithLocalMeowLoad(pageUrl, settings);
    fallbackErrors.push(extracted.error);
    if (extracted.assets.length > 0) {
      assets = [...extracted.assets, ...assets];
    }
  }

  if (!assets.some((asset) => asset.media_type === "video")) {
    const extracted = await resolveWechatWithChannelsService(pageUrl, settings);
    fallbackErrors.push(extracted.error);
    if (extracted.assets.length > 0) {
      assets = [...extracted.assets, ...assets];
    }
  }

  if (!assets.some((asset) => asset.media_type === "video")) {
    const extracted = await resolveWechatWithServerExtractor(pageUrl, settings);
    fallbackErrors.push(extracted.error);
    if (extracted.assets.length > 0) {
      assets = [...extracted.assets, ...assets];
    }
  }

  if (assets.length === 0) {
    throw new AppError(ErrorCode.NO_MEDIA_FOUND, "微信视频号页面中没有发现可下载媒体。", 404);
  }

  if (!assets.some((asset) => asset.media_type === "video")) {
    const details = fallbackErrors.filter(Boolean).join("；");
    throw new AppError(
      ErrorCode.NO_MEDIA_FOUND,
      `微信视频号公开接口只返回了封面，其他视频解析方式也未成功${details ? `：${details}` : ""}。`,
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

async function resolveWechatWithLocalMeowLoad(pageUrl, settings) {
  if (process.env.WECHAT_MEOWLOAD_CLI_ENABLED === "0" || process.platform !== "darwin") {
    return { assets: [], error: null };
  }

  const executable = process.env.WECHAT_MEOWLOAD_CLI_PATH?.trim() || WECHAT_MEOWLOAD_CLI_PATH;

  try {
    await fs.access(executable);
  } catch {
    return { assets: [], error: "本机未安装哼哼猫" };
  }

  try {
    const { stdout } = await execFile(executable, ["info", pageUrl], {
      encoding: "utf8",
      maxBuffer: 4 * 1024 * 1024,
      timeout: Math.min(Math.max(settings.httpTimeoutMs * 3, 30_000), 120_000),
      windowsHide: true,
    });
    const payload = JSON.parse(stdout.trim());
    const assets = wechatAssetsFromExtractorPayload(payload, pageUrl);
    return {
      assets,
      error: assets.some((asset) => asset.media_type === "video")
        ? null
        : "哼哼猫没有返回视频文件",
    };
  } catch (error) {
    const message = pickSingleLineText(error?.stderr, error?.message);
    const reason = /Failed to connect to the MeowLoad desktop app/i.test(message)
      ? "哼哼猫桌面应用未运行"
      : "哼哼猫本机解析失败";
    return { assets: [], error: reason };
  }
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
  const videoUrls = uniqueUrls([
    feed?.h265VideoInfo?.videoUrl,
    feed?.h264VideoInfo?.videoUrl,
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
