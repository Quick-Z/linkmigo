import { URL } from "node:url";

import {
  escapeRegExp,
  fetchWithTimeout,
  htmlUnescape,
  metaContents,
  optionalInt,
  PAGE_HEADERS,
} from "./utils";
import {
  cleanDisplayText,
  cleanSingleLineText,
  createPostInfo,
  normalizeTags,
  pickSingleLineText,
  pickText,
} from "./post-info";

export const SUPPORTED_URL_MESSAGE = "暂时支持 Instagram、TikTok、抖音、小红书、快手、AcFun、Twitter/X、Bilibili、Facebook、Pinterest、YouTube、Pornhub 的公开链接。";

const SHARE_URL_PATTERN = /https?:\/\/[A-Za-z0-9\-._~:/?#\[\]@!$&'()*+,;=%]+/i;

const TRAILING_URL_PUNCTUATION_PATTERN = /[)"'.。,;:!?，；：！？、】》」』”’]+$/u;

export async function resolveRedirect(url, settings, headers = PAGE_HEADERS) {
  try {
    const response = await fetchWithTimeout(
      url,
      { headers, cache: "no-store", redirect: "follow" },
      settings.httpTimeoutMs,
    );

    if (response.url && response.url !== url) {
      return response.url;
    }

    const text = await response.text();
    const match = /<a\s+href=(["'])(.*?)\1/i.exec(text);

    if (match) {
      return new URL(htmlUnescape(match[2]), response.url || url).toString();
    }

    return "";
  } catch {
    return "";
  }
}

export function isRedirectStatus(status) {
  return status >= 300 && status < 400;
}

export function withCookieHeader(headers, cookieHeader) {
  return cookieHeader ? { ...headers, cookie: cookieHeader } : headers;
}

export function mergeCookieMapFromSetCookie(cookieMap, headers) {
  const setCookies =
    typeof headers.getSetCookie === "function"
      ? headers.getSetCookie()
      : splitSetCookieHeader(headers.get("set-cookie") ?? "");

  for (const cookie of setCookies) {
    const pair = cookie.split(";", 1)[0]?.trim();
    const name = pair?.split("=", 1)[0]?.trim();

    if (name && pair?.includes("=")) {
      cookieMap.set(name, pair);
    }
  }
}

export function cookieHeaderFromMap(cookieMap) {
  return Array.from(cookieMap.values()).join("; ");
}

export function extractUrlCandidate(rawValue) {
  const match = rawValue.match(SHARE_URL_PATTERN);
  const value = match ? match[0] : rawValue;

  return trimTrailingUrlPunctuation(value);
}

function trimTrailingUrlPunctuation(value) {
  return String(value || "").trim().replace(TRAILING_URL_PUNCTUATION_PATTERN, "");
}

export function safeFilenamePart(value) {
  return String(value || "unknown")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^[-._]+|[-._]+$/g, "") || "unknown";
}

export function jsonFromAssignment(text, assignmentName) {
  const assignmentPattern = new RegExp(`${escapeRegExp(assignmentName)}\\s*=`);
  const assignment = assignmentPattern.exec(text);

  if (!assignment) {
    return null;
  }

  const startIndex = text.indexOf("{", assignment.index + assignment[0].length);

  if (startIndex < 0) {
    return null;
  }

  const endIndex = balancedJsonEndIndex(text, startIndex);

  if (endIndex < 0) {
    return null;
  }

  try {
    return JSON.parse(text.slice(startIndex, endIndex));
  } catch {
    return null;
  }
}

export function balancedJsonEndIndex(text, startIndex) {
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = startIndex; index < text.length; index += 1) {
    const char = text[index];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
      continue;
    }

    if (char === "{") {
      depth += 1;
      continue;
    }

    if (char === "}") {
      depth -= 1;

      if (depth === 0) {
        return index + 1;
      }
    }
  }

  return -1;
}

export function loadsJsonValues(text) {
  const raw = htmlUnescape(String(text || "").trim());

  if (!raw) {
    return [];
  }

  const values = [];

  for (const candidate of [
    raw,
    raw.replace(/^\s*<!--|-->\s*$/g, ""),
  ]) {
    try {
      values.push(JSON.parse(candidate));
    } catch {
      // Try the next variant.
    }
  }

  return values;
}

export function firstUrlFromList(urls) {
  if (!Array.isArray(urls)) {
    return "";
  }

  const preferred = urls.find((url) => typeof url === "string" && /^https?:\/\//i.test(url));

  return preferred ? htmlUnescape(preferred) : "";
}

export function addUrlCandidate(candidates, value) {
  if (typeof value === "string" && /^https?:\/\//i.test(value)) {
    candidates.push(htmlUnescape(value));
  }
}

export function uniqueUrls(urls) {
  const seen = new Set();

  return urls.filter((url) => {
    if (seen.has(url)) {
      return false;
    }

    seen.add(url);
    return true;
  });
}

export function postInfoFromHtmlMeta(text, metrics, creatorHandle) {
  const body = pickText(metaContents(text, ["og:description", "twitter:description", "description"]));
  const title = pickSingleLineText(
    metaContents(text, ["og:title", "twitter:title", "title"]),
    htmlTitleFromText(text),
    titleFromBody(body),
  );
  const author = pickSingleLineText(metaContents(text, ["author", "article:author", "og:video:actor"]), creatorHandle);

  return createPostInfo(
    {
      title,
      author,
      author_handle: creatorHandle,
      body,
      tags: normalizeTags(metaKeywords(text), body),
      metrics,
      source: metrics?.source || "public_best_effort",
    },
    { metrics, creatorHandle, source: metrics?.source || "public_best_effort" },
  );
}

export function titleFromBody(body) {
  const firstLine = cleanSingleLineText(String(body || "").split("\n")[0], { maxLength: 140 });

  return firstLine.length > 112 ? `${firstLine.slice(0, 109).trimEnd()}...` : firstLine;
}

function metaKeywords(text) {
  return metaContents(text, ["keywords", "news_keywords"])
    .flatMap((value) => String(value).split(","))
    .map((value) => value.trim())
    .filter(Boolean);
}

function htmlTitleFromText(text) {
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(text)?.[1];

  return title ? cleanDisplayText(htmlUnescape(title), { maxLength: 240 }) : "";
}

export function firstRegexInt(text, pattern) {
  const match = pattern.exec(text);

  return match ? optionalInt(match[1]) : null;
}

export function firstJsonCount(text, keys) {
  const unescaped = htmlUnescape(text);

  for (const key of keys) {
    const valuePattern = new RegExp(`"${key}"\\s*:\\s*("?\\d+"?)`);
    const objectPattern = new RegExp(`"${key}"\\s*:\\s*\\{[^{}]*"count"\\s*:\\s*("?\\d+"?)`, "s");

    for (const pattern of [valuePattern, objectPattern]) {
      const match = pattern.exec(unescaped);

      if (match) {
        const count = optionalInt(match[1].replace(/^"|"$/g, ""));

        if (count != null) {
          return count;
        }
      }
    }
  }

  return null;
}

export function cookieHeaderFromSetCookie(headers) {
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

export function createMetrics(source = "public_best_effort") {
  return {
    like_count: null,
    comment_count: null,
    view_count: null,
    save_count: null,
    share_count: null,
    source,
  };
}
