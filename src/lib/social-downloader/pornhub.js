import { URL } from "node:url";

import { AppError, ErrorCode } from "./errors";
import {
  decodeJsonString,
  dedupeAssets,
  fetchTextResponse,
  fetchWithTimeout,
  firstPresentInt,
  htmlUnescape,
  metaContents,
  optionalInt,
  PAGE_HEADERS,
  responseJson,
  scriptTexts,
} from "./utils";

const PORNHUB_VIEWKEY_RE = /^[A-Za-z0-9_-]{4,96}$/;
const PORNHUB_ACCESS_COOKIE = [
  "age_verified=1",
  "accessAgeDisclaimerPH=1",
  "accessAgeDisclaimerUK=1",
  "accessPH=1",
].join("; ");
const PORNHUB_HEADERS = {
  ...PAGE_HEADERS,
  accept:
    "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
  "accept-language": "en-US,en;q=0.9",
  cookie: PORNHUB_ACCESS_COOKIE,
};

export function normalizePornhubUrl(parsed) {
  const parts = parsed.pathname.split("/").filter(Boolean);
  let viewKey = parsed.searchParams.get("viewkey") ?? "";

  if (!viewKey && ["embed", "embed_player.php"].includes(parts[0])) {
    viewKey = parts[1] ?? parsed.searchParams.get("id") ?? "";
  }

  if (!PORNHUB_VIEWKEY_RE.test(viewKey)) {
    throw new AppError(ErrorCode.UNSUPPORTED_URL, "仅支持 Pornhub 公开视频链接。", 400);
  }

  const canonical = new URL(`${parsed.protocol}//${parsed.hostname}/view_video.php`);

  canonical.searchParams.set("viewkey", viewKey);

  return {
    canonical_url: canonical.toString(),
    shortcode: viewKey,
    kind: "video",
    platform: "pornhub",
  };
}

export async function resolvePornhubPost(normalized, settings) {
  const pageUrl = normalized.canonical_url;
  const pageResponse = await fetchTextResponse({
    url: pageUrl,
    headers: pornhubPageHeaders(pageUrl),
    label: "Pornhub",
    timeoutMs: settings.httpTimeoutMs,
  });
  const text = pageResponse.text;

  if (!text.trim()) {
    throw new AppError(ErrorCode.NO_MEDIA_FOUND, "Pornhub 返回了空页面。", 404);
  }

  if (looksLikePornhubUnavailable(text)) {
    throw new AppError(ErrorCode.NO_MEDIA_FOUND, "这个 Pornhub 视频不可用或已被删除。", 404);
  }

  const cookieHeader = mergeCookieHeaders(
    PORNHUB_ACCESS_COOKIE,
    cookieHeaderFromSetCookie(pageResponse.headers),
  );
  const mediaDefinitions = await expandRemoteMediaDefinitions({
    mediaDefinitions: collectPornhubMediaDefinitions(text),
    pageUrl,
    settings,
    cookieHeader,
  });
  const candidates = pornhubMediaCandidates(mediaDefinitions, pageUrl);

  if (candidates.length === 0) {
    candidates.push(...pornhubUrlCandidatesFromText(text, pageUrl));
  }

  const best = bestPornhubMediaCandidate(candidates);

  if (!best) {
    if (looksLikePornhubLoginRequired(text)) {
      throw new AppError(ErrorCode.LOGIN_REQUIRED, "这个 Pornhub 内容需要登录或年龄验证。", 403);
    }

    throw new AppError(ErrorCode.NO_MEDIA_FOUND, "Pornhub 页面中没有发现可下载的视频资源。", 404);
  }

  const fallbackUrls = pornhubFallbackUrls(candidates, best);
  const qualityLabel = best.quality ? `${best.quality}p` : "video";
  const flashvars = firstPornhubFlashvars(text);

  return {
    assets: dedupeAssets([
      {
        source_url: best.url,
        fallback_urls: fallbackUrls,
        media_type: "video",
        width: best.width,
        height: best.height,
        filename_hint: `pornhub_${normalized.shortcode}_${qualityLabel}.mp4`,
        request_headers: pornhubMediaHeaders(pageUrl, cookieHeader),
        is_hls: best.isHls,
      },
    ]),
    metrics: metricsFromPornhub(text),
    creator_handle: creatorFromPornhub(text, flashvars),
  };
}

async function expandRemoteMediaDefinitions({ mediaDefinitions, pageUrl, settings, cookieHeader }) {
  const expanded = [];

  for (const definition of mediaDefinitions) {
    const url = cleanPornhubUrl(definition?.videoUrl || definition?.video_url || definition?.url, pageUrl);

    if (url && isPornhubMediaDefinitionApiUrl(url)) {
      const remoteDefinitions = await requestPornhubMediaDefinitions({
        url,
        pageUrl,
        settings,
        cookieHeader,
      });

      expanded.push(...remoteDefinitions);
      continue;
    }

    expanded.push(definition);
  }

  return expanded;
}

async function requestPornhubMediaDefinitions({ url, pageUrl, settings, cookieHeader }) {
  try {
    const response = await fetchWithTimeout(
      url,
      {
        cache: "no-store",
        headers: pornhubMediaHeaders(pageUrl, cookieHeader),
      },
      settings.httpTimeoutMs,
    );
    const data = await responseJson(response);

    return collectMediaDefinitionsFromValue(data);
  } catch {
    return [];
  }
}

function collectPornhubMediaDefinitions(text) {
  const definitions = [];

  for (const flashvars of pornhubFlashvars(text)) {
    definitions.push(...collectMediaDefinitionsFromValue(flashvars));
  }

  for (const script of scriptTexts(text)) {
    definitions.push(...collectMediaDefinitionsFromAssignments(script));
  }

  definitions.push(...collectMediaDefinitionsFromAssignments(text));

  return dedupeMediaDefinitions(definitions);
}

function pornhubFlashvars(text) {
  const values = [];
  const pattern = /\bflashvars(?:_[A-Za-z0-9]+)?\s*=/g;
  let match;

  while ((match = pattern.exec(text))) {
    const start = text.indexOf("{", pattern.lastIndex);

    if (start < 0) {
      continue;
    }

    const chunk = balancedJsValue(text, start);
    const parsed = parseJsonLike(chunk);

    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      values.push(parsed);
      pattern.lastIndex = start + chunk.length;
    }
  }

  return values;
}

function firstPornhubFlashvars(text) {
  return pornhubFlashvars(text)[0] ?? {};
}

function collectMediaDefinitionsFromAssignments(text) {
  const definitions = [];
  const pattern = /["']mediaDefinitions["']\s*:\s*/g;
  let match;

  while ((match = pattern.exec(text))) {
    const start = skipWhitespace(text, pattern.lastIndex);
    const chunk = balancedJsValue(text, start);
    const parsed = parseJsonLike(chunk);

    definitions.push(...parseMediaDefinitionsValue(parsed));
    pattern.lastIndex = start + Math.max(chunk.length, 1);
  }

  return definitions;
}

function collectMediaDefinitionsFromValue(value, output = [], seen = new WeakSet(), depth = 0) {
  if (value == null || depth > 8) {
    return output;
  }

  output.push(...parseMediaDefinitionsValue(value));

  if (typeof value !== "object") {
    return output;
  }

  if (seen.has(value)) {
    return output;
  }

  seen.add(value);

  if (Array.isArray(value)) {
    value.forEach((item) => collectMediaDefinitionsFromValue(item, output, seen, depth + 1));
    return output;
  }

  for (const [key, child] of Object.entries(value)) {
    if (key === "mediaDefinitions") {
      output.push(...parseMediaDefinitionsValue(child));
    } else {
      collectMediaDefinitionsFromValue(child, output, seen, depth + 1);
    }
  }

  return output;
}

function parseMediaDefinitionsValue(value) {
  if (!value) {
    return [];
  }

  if (Array.isArray(value)) {
    return value.filter((item) => item && typeof item === "object");
  }

  if (typeof value === "string") {
    const decoded = decodeJsonString(value);

    for (const candidate of [decoded, htmlUnescape(decoded), decodeURIComponentSafe(decoded)]) {
      try {
        const parsed = JSON.parse(candidate);

        if (Array.isArray(parsed)) {
          return parsed.filter((item) => item && typeof item === "object");
        }

        if (parsed && typeof parsed === "object") {
          return collectMediaDefinitionsFromValue(parsed);
        }
      } catch {
        // Try the next representation.
      }
    }
  }

  return [];
}

function pornhubMediaCandidates(definitions, pageUrl) {
  const candidates = [];

  definitions.forEach((definition) => {
    if (!definition || typeof definition !== "object") {
      return;
    }

    const url = cleanPornhubUrl(
      definition.videoUrl || definition.video_url || definition.url || definition.remote,
      pageUrl,
    );

    if (!url || isPornhubMediaDefinitionApiUrl(url)) {
      return;
    }

    const format = String(definition.format || definition.type || "").toLowerCase();
    const quality = pornhubQuality(definition.quality ?? definition.defaultQuality ?? url);

    candidates.push({
      url,
      format,
      isHls: format.includes("hls") || isHlsUrl(url),
      quality,
      width: optionalInt(definition.width),
      height: firstPresentInt(definition.height, quality),
      score: pornhubCandidateScore({
        quality,
        width: optionalInt(definition.width),
        height: optionalInt(definition.height),
        isHls: format.includes("hls") || isHlsUrl(url),
      }),
    });
  });

  return dedupeCandidates(candidates);
}

function pornhubUrlCandidatesFromText(text, pageUrl) {
  const candidates = [];
  const pattern = /https?:\\?\/\\?\/[^\s"'<>]+?\.(?:m3u8|mp4)(?:\?[^\s"'<>]+)?/gi;
  let match;

  while ((match = pattern.exec(text))) {
    const url = cleanPornhubUrl(match[0], pageUrl);

    if (!url) {
      continue;
    }

    const isHls = isHlsUrl(url);
    const quality = pornhubQuality(url);

    candidates.push({
      url,
      format: isHls ? "hls" : "mp4",
      isHls,
      quality,
      width: null,
      height: quality,
      score: pornhubCandidateScore({ quality, isHls }),
    });
  }

  return dedupeCandidates(candidates);
}

function bestPornhubMediaCandidate(candidates) {
  if (!Array.isArray(candidates) || candidates.length === 0) {
    return null;
  }

  return candidates.reduce((best, candidate) =>
    candidate.score > best.score ? candidate : best,
  );
}

function pornhubFallbackUrls(candidates, selected) {
  return candidates
    .filter((candidate) => candidate.url !== selected.url)
    .sort((left, right) => right.score - left.score)
    .map((candidate) => candidate.url);
}

function pornhubCandidateScore({ quality = null, width = null, height = null, isHls = false }) {
  const sizeScore = firstPresentInt(quality, height, width) || 0;
  const formatScore = isHls ? 0 : 100;

  return sizeScore * 1000 + formatScore;
}

function pornhubQuality(value) {
  if (Array.isArray(value)) {
    return value.reduce((best, item) => Math.max(best, pornhubQuality(item) || 0), 0) || null;
  }

  if (value == null || typeof value === "boolean") {
    return null;
  }

  const match = /(?:^|[^\d])(\d{3,4})\s*p?\b/i.exec(String(value));

  return match ? optionalInt(match[1]) : optionalInt(value);
}

function cleanPornhubUrl(value, pageUrl) {
  if (typeof value !== "string" || !value.trim()) {
    return "";
  }

  let cleaned = decodeJsonString(value.trim()).replaceAll("\\/", "/");

  if (/^(?:https?)%3a/i.test(cleaned) || /^%2f%2f/i.test(cleaned)) {
    cleaned = decodeURIComponentSafe(cleaned);
  }

  cleaned = htmlUnescape(cleaned);

  try {
    return new URL(cleaned, pageUrl).toString();
  } catch {
    return "";
  }
}

function isPornhubMediaDefinitionApiUrl(value) {
  try {
    const parsed = new URL(value);

    return parsed.pathname.includes("/video/get_media");
  } catch {
    return false;
  }
}

function isHlsUrl(value) {
  try {
    return new URL(value).pathname.toLowerCase().endsWith(".m3u8");
  } catch {
    return /\.m3u8(?:$|\?)/i.test(String(value));
  }
}

function dedupeMediaDefinitions(definitions) {
  const seen = new Set();
  const output = [];

  for (const definition of definitions) {
    const key = JSON.stringify({
      url: definition?.videoUrl || definition?.video_url || definition?.url || definition?.remote || "",
      quality: definition?.quality || "",
      format: definition?.format || "",
    });

    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    output.push(definition);
  }

  return output;
}

function dedupeCandidates(candidates) {
  const seen = new Set();
  const output = [];

  for (const candidate of candidates) {
    if (!candidate.url || seen.has(candidate.url)) {
      continue;
    }

    seen.add(candidate.url);
    output.push(candidate);
  }

  return output;
}

function metricsFromPornhub(text) {
  return {
    like_count: firstPresentInt(
      firstJsonCount(text, ["upVotes", "upvotes", "likes", "votesUp"]),
      firstRegexCount(text, /\bupVotes\b["']?\s*[:=]\s*["']?([\d,.]+)/i),
    ),
    comment_count: firstPresentInt(
      firstJsonCount(text, ["comments", "comment_count", "commentCount"]),
      firstRegexCount(text, /\bcommentsCount\b["']?\s*[:=]\s*["']?([\d,.]+)/i),
    ),
    view_count: firstPresentInt(
      firstJsonCount(text, ["videoViewCount", "viewCount", "views"]),
      firstRegexCount(text, /\bvideoViewCount\b["']?\s*[:=]\s*["']?([\d,.]+)/i),
    ),
    save_count: null,
    share_count: null,
    source: "pornhub_public_best_effort",
  };
}

function creatorFromPornhub(text, flashvars) {
  const direct = [
    flashvars?.video_uname,
    flashvars?.video_uploader,
    flashvars?.username,
    metaContents(text, ["author", "og:video:actor"])[0],
  ].find((value) => typeof value === "string" && value.trim());

  if (direct) {
    return safeCreatorHandle(direct);
  }

  const match =
    /class=["'][^"']*(?:user|username)[^"']*["'][^>]*>\s*<a[^>]*>([^<]+)/i.exec(text) ||
    /\busername\b["']?\s*[:=]\s*["']([^"']+)/i.exec(text);

  return match ? safeCreatorHandle(htmlUnescape(match[1])) : "";
}

function safeCreatorHandle(value) {
  return String(value || "")
    .replace(/<[^>]+>/g, "")
    .trim()
    .replace(/^@+/, "")
    .replace(/\s+/g, "-")
    .slice(0, 80);
}

function looksLikePornhubLoginRequired(text) {
  return /login required|please log in|private video|premium (?:only|video|required)|requires premium/i.test(text);
}

function looksLikePornhubUnavailable(text) {
  return /video (?:has been )?(?:deleted|removed|unavailable)|this video is no longer available|404 not found/i.test(text);
}

function pornhubPageHeaders(pageUrl) {
  return {
    ...PORNHUB_HEADERS,
    Referer: pornhubOrigin(pageUrl),
  };
}

function pornhubMediaHeaders(pageUrl, cookieHeader = "") {
  return {
    ...PAGE_HEADERS,
    accept: "video/*,application/vnd.apple.mpegurl,application/x-mpegurl,*/*;q=0.8",
    "accept-language": PORNHUB_HEADERS["accept-language"],
    Referer: pageUrl,
    Origin: pornhubOrigin(pageUrl),
    cookie: mergeCookieHeaders(PORNHUB_ACCESS_COOKIE, cookieHeader),
  };
}

function pornhubOrigin(pageUrl) {
  try {
    return new URL(pageUrl).origin;
  } catch {
    return "https://www.pornhub.com";
  }
}

function cookieHeaderFromSetCookie(headers) {
  const setCookies =
    typeof headers.getSetCookie === "function"
      ? headers.getSetCookie()
      : splitSetCookieHeader(headers.get("set-cookie") ?? "");

  return setCookies
    .map((cookie) => cookie.split(";", 1)[0]?.trim())
    .filter((cookie) => cookie && cookie.includes("="))
    .join("; ");
}

function splitSetCookieHeader(value) {
  if (!value) {
    return [];
  }

  return value.split(/,(?=\s*[^;,=\s]+=[^;]+)/g).map((cookie) => cookie.trim());
}

function mergeCookieHeaders(...headers) {
  const values = new Map();

  headers
    .filter(Boolean)
    .flatMap((header) => String(header).split(";"))
    .map((pair) => pair.trim())
    .filter((pair) => pair.includes("="))
    .forEach((pair) => {
      const name = pair.split("=", 1)[0].trim();

      if (name) {
        values.set(name, pair);
      }
    });

  return Array.from(values.values()).join("; ");
}

function firstJsonCount(text, keys) {
  const decoded = htmlUnescape(text);

  for (const key of keys) {
    const pattern = new RegExp(`["']${escapeRegExp(key)}["']\\s*:\\s*["']?([\\d,.]+)`, "i");
    const match = pattern.exec(decoded);
    const count = match ? parseCount(match[1]) : null;

    if (count != null) {
      return count;
    }
  }

  return null;
}

function firstRegexCount(text, pattern) {
  const match = pattern.exec(htmlUnescape(text));

  return match ? parseCount(match[1]) : null;
}

function parseCount(value) {
  if (value == null || value === "" || typeof value === "boolean") {
    return null;
  }

  const normalized = String(value).trim().replaceAll(",", "");
  const match = /^(\d+(?:\.\d+)?)([km])?$/i.exec(normalized);

  if (!match) {
    return optionalInt(normalized);
  }

  const number = Number.parseFloat(match[1]);
  const unit = match[2]?.toLowerCase();
  const multiplier = unit === "m" ? 1_000_000 : unit === "k" ? 1_000 : 1;

  return Number.isFinite(number) ? Math.round(number * multiplier) : null;
}

function parseJsonLike(chunk) {
  if (!chunk) {
    return null;
  }

  const decoded = htmlUnescape(chunk.trim());
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

function balancedJsValue(text, start) {
  const first = text[start];

  if (first === "{" || first === "[") {
    return balancedContainer(text, start, first === "{" ? "}" : "]");
  }

  if (first === '"' || first === "'") {
    return balancedString(text, start, first);
  }

  return "";
}

function balancedContainer(text, start, close) {
  const open = text[start];
  const stack = [close];
  let inString = false;
  let stringQuote = "";
  let escaped = false;

  for (let index = start + 1; index < text.length; index += 1) {
    const char = text[index];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === stringQuote) {
        inString = false;
      }

      continue;
    }

    if (char === '"' || char === "'") {
      inString = true;
      stringQuote = char;
      continue;
    }

    if (char === "{" || char === "[") {
      stack.push(char === "{" ? "}" : "]");
      continue;
    }

    if (char === stack[stack.length - 1]) {
      stack.pop();

      if (stack.length === 0) {
        return text.slice(start, index + 1);
      }
    }
  }

  return open;
}

function balancedString(text, start, quote) {
  let escaped = false;

  for (let index = start + 1; index < text.length; index += 1) {
    const char = text[index];

    if (escaped) {
      escaped = false;
    } else if (char === "\\") {
      escaped = true;
    } else if (char === quote) {
      return text.slice(start, index + 1);
    }
  }

  return "";
}

function skipWhitespace(text, index) {
  let current = index;

  while (current < text.length && /\s/.test(text[current])) {
    current += 1;
  }

  return current;
}

function decodeURIComponentSafe(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
