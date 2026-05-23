import crypto from "node:crypto";
import path from "node:path";
import { URL, URLSearchParams } from "node:url";

import { AppError, ErrorCode } from "./errors";
import {
  cleanUrl,
  dedupeAssets,
  dig,
  fetchText,
  fetchWithTimeout,
  hasMetricValues,
  htmlUnescape,
  jsonBetween,
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
import { resolveRedirect } from "./shared";

const BILIBILI_HEADERS = {
  ...PAGE_HEADERS,
  "user-agent": "facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)",
};

const BILIBILI_WBI_KEY_CACHE_TIMEOUT_MS = 60 * 60 * 1000;

const BILIBILI_WBI_MIXIN_KEY_TABLE = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49,
  33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40,
  61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11,
  36, 20, 34, 44, 52,
];

let cachedBilibiliWbiKey = "";

let cachedBilibiliWbiKeyExpiresAt = 0;

export function normalizeBilibiliUrl(parsed) {
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

export async function resolveBilibiliPost(normalized, settings) {
  let active = normalized;

  if (active.kind === "short") {
    const redirected = await resolveRedirect(active.canonical_url, settings);

    if (redirected) {
      active = normalizeBilibiliUrl(new URL(redirected));
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
    creator_handle: bilibiliCreatorHandle(apiData?.view || initialState),
    post_info: postInfoFromBilibili(apiData?.view || initialState, metrics),
  };
}

export async function resolveBilibiliComments(normalized, options = {}, settings = {}) {
  let active = normalized;

  if (active.kind === "short") {
    const redirected = await resolveRedirect(active.canonical_url, settings);

    if (redirected) {
      active = normalizeBilibiliUrl(new URL(redirected));
    }
  }

  const viewData = await requestBilibiliViewData(active, settings);

  if (!viewData?.aid) {
    throw new AppError(ErrorCode.NO_MEDIA_FOUND, "没有找到这个 Bilibili 视频。", 404);
  }

  const limit = normalizeBilibiliCommentLimit(options.limit);
  const page = normalizeBilibiliCommentPage(options.cursor);
  const payload = await requestBilibiliReplyPage({
    oid: viewData.aid,
    page,
    pageSize: limit,
    referer: active.canonical_url,
    settings,
  });
  const replies = Array.isArray(payload?.replies) ? payload.replies : [];
  const totalCount = optionalInt(payload?.page?.count) ?? optionalInt(viewData?.stat?.reply) ?? replies.length;
  const comments = replies
    .map((reply) => normalizeBilibiliComment(reply))
    .filter((comment) => comment.id);
  const nextCursor = page * limit < totalCount && comments.length > 0 ? String(page + 1) : null;

  return {
    platform: "bilibili",
    shortcode: active.shortcode,
    canonical_url: active.canonical_url,
    comments,
    next_cursor: nextCursor,
    has_more: Boolean(nextCursor),
    total_count: totalCount,
    public_count: Math.min(totalCount, (page - 1) * limit + comments.length),
    is_partial_public_snapshot: totalCount > comments.length,
    source: "bilibili_public_reply_api",
  };
}

async function requestBilibiliPlayurl(normalized, settings) {
  const videoId = normalized.shortcode;
  const params = bilibiliVideoParams(videoId);

  try {
    const viewData = await requestBilibiliViewData(normalized, settings);
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

function bilibiliVideoParams(videoId) {
  return videoId.toUpperCase().startsWith("BV")
    ? { bvid: videoId }
    : { aid: videoId.replace(/^av/i, "") };
}

async function requestBilibiliViewData(normalized, settings) {
  const viewUrl = new URL("https://api.bilibili.com/x/web-interface/view");

  Object.entries(bilibiliVideoParams(normalized.shortcode)).forEach(([key, value]) => viewUrl.searchParams.set(key, value));

  const viewResponse = await fetchWithTimeout(
    viewUrl,
    {
      cache: "no-store",
      headers: { ...PAGE_HEADERS, Referer: normalized.canonical_url },
    },
    settings.httpTimeoutMs,
  );
  const view = await responseJson(viewResponse);

  return view?.data && typeof view.data === "object" ? view.data : null;
}

async function requestBilibiliReplyPage({ oid, page, pageSize, referer, settings }) {
  const url = new URL("https://api.bilibili.com/x/v2/reply");

  url.searchParams.set("type", "1");
  url.searchParams.set("oid", String(oid));
  url.searchParams.set("sort", "2");
  url.searchParams.set("pn", String(page));
  url.searchParams.set("ps", String(pageSize));

  const response = await fetchWithTimeout(
    url,
    {
      cache: "no-store",
      headers: { ...PAGE_HEADERS, Referer: referer },
    },
    settings.httpTimeoutMs,
  );
  const payload = await responseJson(response);

  return payload?.data && typeof payload.data === "object" ? payload.data : null;
}

function normalizeBilibiliCommentLimit(value) {
  const parsed = Number.parseInt(String(value ?? ""), 10);

  if (!Number.isFinite(parsed)) {
    return 12;
  }

  return Math.max(1, Math.min(30, parsed));
}

function normalizeBilibiliCommentPage(value) {
  const parsed = Number.parseInt(String(value ?? ""), 10);

  if (!Number.isFinite(parsed) || parsed < 1) {
    return 1;
  }

  return parsed;
}

function normalizeBilibiliComment(reply) {
  const member = reply?.member && typeof reply.member === "object" ? reply.member : {};
  const replies = Array.isArray(reply?.replies) ? reply.replies : [];

  return {
    id: String(reply?.rpid || reply?.rpid_str || ""),
    text: pickText(reply?.content?.message),
    author_name: pickSingleLineText(member.uname, member.name, member.mid, "Bilibili 用户"),
    author_handle: pickSingleLineText(member.mid),
    avatar_url: bilibiliAvatarUrl(member.avatar),
    created_at: bilibiliTimestamp(reply?.ctime),
    like_count: optionalInt(reply?.like),
    reply_count: optionalInt(reply?.rcount) ?? replies.length,
    ip_loc: pickSingleLineText(reply?.reply_control?.location),
    has_voice: false,
    replies: replies
      .slice(0, 3)
      .map((item) => normalizeBilibiliComment(item))
      .filter((comment) => comment.id),
  };
}

function bilibiliTimestamp(value) {
  const timestamp = optionalInt(value);

  if (timestamp == null) {
    return null;
  }

  const date = new Date(timestamp * 1000);

  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function bilibiliAvatarUrl(value) {
  const url = pickSingleLineText(value);

  if (!url) {
    return "";
  }

  try {
    return new URL(htmlUnescape(url), "https://www.bilibili.com").toString();
  } catch {
    return "";
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

function postInfoFromBilibili(data, metrics) {
  const video = bilibiliVideoData(data);
  const creatorHandle = bilibiliCreatorHandle(data);
  const body = pickText(video?.desc, video?.description, video?.dynamic);

  return createPostInfo(
    {
      title: pickSingleLineText(video?.title, data?.title),
      author: creatorHandle,
      author_handle: creatorHandle,
      body,
      tags: normalizeTags(bilibiliTags(data), body),
      metrics,
      source: metrics?.source || "bilibili_public_best_effort",
    },
    { metrics, creatorHandle, source: metrics?.source || "bilibili_public_best_effort" },
  );
}

function bilibiliVideoData(data) {
  if (!data || typeof data !== "object") {
    return {};
  }

  return data.videoData && typeof data.videoData === "object" ? data.videoData : data;
}

function bilibiliCreatorHandle(data) {
  const video = bilibiliVideoData(data);
  const owner = video?.owner && typeof video.owner === "object" ? video.owner : {};

  return pickSingleLineText(owner.name, data?.upData?.name, data?.owner?.name);
}

function bilibiliTags(data) {
  const video = bilibiliVideoData(data);
  const values = [];

  for (const key of ["tags", "tag", "tagList"]) {
    if (Array.isArray(video?.[key])) {
      values.push(...video[key]);
    }

    if (Array.isArray(data?.[key])) {
      values.push(...data[key]);
    }
  }

  return values;
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

export function isBilibiliHost(host) {
  return ["bilibili.com", "www.bilibili.com", "m.bilibili.com", "b23.tv"].includes(host);
}
