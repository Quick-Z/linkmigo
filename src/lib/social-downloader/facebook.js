import { AppError, ErrorCode } from "./errors";
import { cleanUrl, fetchText, htmlUnescape, metaContents, PAGE_HEADERS } from "./utils";
import { firstJsonCount, firstRegexInt, postInfoFromHtmlMeta, resolveRedirect } from "./shared";

export function normalizeFacebookUrl(parsed) {
  const parts = parsed.pathname.split("/").filter(Boolean);
  const host = parsed.hostname.toLowerCase();

  if (host === "fb.watch" && parts[0]) {
    return {
      canonical_url: cleanUrl(parsed),
      shortcode: parts[0],
      kind: "short",
      platform: "facebook",
    };
  }

  if (parts.length >= 2 && parts[0] === "reel") {
    return {
      canonical_url: `https://www.facebook.com/reel/${parts[1]}`,
      shortcode: parts[1],
      kind: "reel",
      platform: "facebook",
    };
  }

  if (parts.length >= 3 && parts[0] === "share") {
    return {
      canonical_url: cleanUrl(parsed),
      shortcode: parts.at(-1),
      kind: `share-${parts[1]}`,
      platform: "facebook",
    };
  }

  if (parts.length >= 3 && parts[1] === "videos") {
    return {
      canonical_url: cleanUrl(parsed),
      shortcode: parts.at(-1),
      kind: "video",
      platform: "facebook",
    };
  }

  throw new AppError(ErrorCode.UNSUPPORTED_URL, "仅支持 Facebook Reel、视频或分享短链接。", 400);
}

export async function resolveFacebookPost(normalized, settings) {
  let pageUrl = normalized.canonical_url;

  if (normalized.kind === "short") {
    pageUrl = (await resolveRedirect(normalized.canonical_url, settings)) || pageUrl;
  }

  const text = await fetchText({
    url: pageUrl,
    headers: PAGE_HEADERS,
    label: "Facebook",
    timeoutMs: settings.httpTimeoutMs,
  });
  const urls = [];

  for (const key of ["browser_native_hd_url", "browser_native_sd_url"]) {
    const match = new RegExp(`"${key}":(".*?")`).exec(text);

    if (!match) {
      continue;
    }

    try {
      const url = JSON.parse(match[1]);

      if (typeof url === "string" && url.startsWith("http")) {
        urls.push(htmlUnescape(url));
      }
    } catch {
      // Continue to meta fallbacks.
    }
  }

  if (urls.length === 0) {
    for (const video of metaContents(text, ["og:video", "og:video:url", "og:video:secure_url"])) {
      if (video) {
        urls.push(video);
      }
    }
  }

  if (urls.length === 0) {
    throw new AppError(ErrorCode.NO_MEDIA_FOUND, "Facebook 页面中没有发现可展示视频。", 404);
  }

  const metrics = {
    like_count: null,
    comment_count: null,
    view_count: firstRegexInt(text, /"play_count":(\d+)/),
    save_count: null,
    share_count: firstJsonCount(text, ["share_count", "shareCount", "shares_count", "sharesCount"]),
    source: "facebook_public_best_effort",
  };

  return {
    assets: [
      {
        source_url: urls[0],
        media_type: "video",
        filename_hint: `facebook_${normalized.shortcode}.mp4`,
        request_headers: { Referer: pageUrl },
      },
    ],
    metrics,
    creator_handle: "",
    post_info: postInfoFromHtmlMeta(text, metrics, ""),
  };
}

export function isFacebookHost(host) {
  return ["facebook.com", "www.facebook.com", "web.facebook.com", "m.facebook.com", "fb.watch"].includes(host);
}
