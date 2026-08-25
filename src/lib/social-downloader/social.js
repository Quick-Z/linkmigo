import { URL } from "node:url";

import { AppError, ErrorCode } from "./errors";
import { isAcfunHost, normalizeAcfunUrl, resolveAcfunPost } from "./acfun";
import { isBilibiliHost, normalizeBilibiliUrl, resolveBilibiliPost } from "./bilibili";
import { isDouyinHost, normalizeDouyinUrl, resolveDouyinPost } from "./douyin";
import { isFacebookHost, normalizeFacebookUrl, resolveFacebookPost } from "./facebook";
import { isInstagramHost, normalizeInstagramUrl, resolveInstagramPost } from "./instagram";
import { isKuaishouHost, normalizeKuaishouUrl, resolveKuaishouPost } from "./kuaishou";
import { isPinterestHost, normalizePinterestUrl, resolvePinterestPost } from "./pinterest";
import { isPornhubHost, normalizePornhubUrl, resolvePornhubPost } from "./pornhub";
import { isRedditHost, normalizeRedditUrl, resolveRedditPost } from "./reddit";
import { extractUrlCandidate, SUPPORTED_URL_MESSAGE } from "./shared";
import { isThreadsHost, normalizeThreadsUrl, resolveThreadsPost } from "./threads";
import { isTiktokHost, normalizeTiktokUrl, resolveTiktokPost } from "./tiktok";
import { isTwitterHost, normalizeTwitterUrl, resolveTwitterPost } from "./twitter";
import { isV2exHost, normalizeV2exUrl, resolveV2exPost } from "./v2ex";
import { isXiaohongshuHost, normalizeXiaohongshuUrl, resolveXiaohongshuPost } from "./xiaohongshu";
import { isXiaoyuzhouHost, normalizeXiaoyuzhouUrl, resolveXiaoyuzhouPost } from "./xiaoyuzhou";
import { isYoutubeHost, normalizeYoutubeUrl, resolveYoutubePost } from "./youtube";

const PLATFORM_HANDLERS = [
  {
    platform: "instagram",
    isHost: isInstagramHost,
    normalize: (_parsed, value) => ({
      ...normalizeInstagramUrl(value),
      platform: "instagram",
    }),
    resolve: resolveInstagramPost,
  },
  { platform: "threads", isHost: isThreadsHost, normalize: normalizeThreadsUrl, resolve: resolveThreadsPost },
  { platform: "tiktok", isHost: isTiktokHost, normalize: normalizeTiktokUrl, resolve: resolveTiktokPost },
  { platform: "douyin", isHost: isDouyinHost, normalize: normalizeDouyinUrl, resolve: resolveDouyinPost },
  { platform: "xiaohongshu", isHost: isXiaohongshuHost, normalize: normalizeXiaohongshuUrl, resolve: resolveXiaohongshuPost },
  { platform: "kuaishou", isHost: isKuaishouHost, normalize: normalizeKuaishouUrl, resolve: resolveKuaishouPost },
  { platform: "acfun", isHost: isAcfunHost, normalize: normalizeAcfunUrl, resolve: resolveAcfunPost },
  { platform: "twitter", isHost: isTwitterHost, normalize: normalizeTwitterUrl, resolve: resolveTwitterPost },
  { platform: "bilibili", isHost: isBilibiliHost, normalize: normalizeBilibiliUrl, resolve: resolveBilibiliPost },
  { platform: "facebook", isHost: isFacebookHost, normalize: normalizeFacebookUrl, resolve: resolveFacebookPost },
  { platform: "pinterest", isHost: isPinterestHost, normalize: normalizePinterestUrl, resolve: resolvePinterestPost },
  { platform: "reddit", isHost: isRedditHost, normalize: normalizeRedditUrl, resolve: resolveRedditPost },
  { platform: "v2ex", isHost: isV2exHost, normalize: normalizeV2exUrl, resolve: resolveV2exPost },
  { platform: "xiaoyuzhou", isHost: isXiaoyuzhouHost, normalize: normalizeXiaoyuzhouUrl, resolve: resolveXiaoyuzhouPost },
  { platform: "youtube", isHost: isYoutubeHost, normalize: normalizeYoutubeUrl, resolve: resolveYoutubePost },
  { platform: "pornhub", isHost: isPornhubHost, normalize: normalizePornhubUrl, resolve: resolvePornhubPost },
];

export function normalizeSocialUrl(rawUrl) {
  let value = extractUrlCandidate(String(rawUrl ?? "").trim());

  if (!value) {
    throw new AppError(ErrorCode.UNSUPPORTED_URL, "请输入需要解析的公开帖子链接。", 400);
  }

  if (!value.includes("://")) {
    value = `https://${value}`;
  }

  let parsed;

  try {
    parsed = new URL(value);
  } catch {
    throw new AppError(ErrorCode.UNSUPPORTED_URL, SUPPORTED_URL_MESSAGE, 400);
  }

  const host = parsed.hostname.toLowerCase();
  const handler = PLATFORM_HANDLERS.find((item) => item.isHost(host));

  if (!handler) {
    throw new AppError(ErrorCode.UNSUPPORTED_URL, SUPPORTED_URL_MESSAGE, 400);
  }

  return handler.normalize(parsed, value);
}

export async function resolveSocialPost(normalized, settings) {
  if (normalized?.mode === "profile") {
    throw new AppError(ErrorCode.UNSUPPORTED_URL, "这是小红书博主主页链接，请使用主页列表中的帖子进行下载。", 400);
  }

  const handler = PLATFORM_HANDLERS.find((item) => item.platform === normalized.platform);

  if (!handler) {
    throw new AppError(ErrorCode.UNSUPPORTED_URL, "这个平台暂未接入解析器。", 400);
  }

  return await handler.resolve(normalized, settings);
}
