import { AppError, ErrorCode } from "./errors";
import { cleanUrl, fetchText, htmlUnescape, metaContents, PAGE_HEADERS } from "./utils";
import { firstJsonCount, firstRegexInt, postInfoFromHtmlMeta, resolveRedirect } from "./shared";
import { renderFacebookPageAnonymously } from "./facebook-browser";

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
  let text = "";
  let renderedMediaUrls = [];

  // Facebook's share links (including `/share/r/<token>/`) are redirect
  // wrappers rather than pages containing the media metadata themselves.
  // Resolve them before fetching the page so we inspect the actual reel/video
  // document.  This also keeps support for the legacy `fb.watch` short links.
  if (normalized.kind === "short" || normalized.kind?.startsWith("share-")) {
    const redirectedUrl = await resolveRedirect(normalized.canonical_url, settings);
    pageUrl = isFacebookContentUrl(redirectedUrl) ? redirectedUrl : normalized.canonical_url;
    applyFacebookReelRedirect(normalized, pageUrl);

    // Facebook often serves the share wrapper with HTTP 200 and performs the
    // real redirect in client-side JavaScript. Let an anonymous browser finish
    // that redirect, then continue with the regular Reel page parser.
    if (isFacebookShareUrl(pageUrl)) {
      try {
        const rendered = await renderFacebookPageAnonymously(pageUrl, settings.httpTimeoutMs);
        if (rendered.pageUrl && !isFacebookShareUrl(rendered.pageUrl)) {
          pageUrl = rendered.pageUrl;
          applyFacebookReelRedirect(normalized, pageUrl);
        }
        if (rendered.html && !isFacebookShareUrl(pageUrl)) {
          text = rendered.html;
          renderedMediaUrls = rendered.mediaUrls;
        }
      } catch {
        // Fall back to fetching the original URL below.
      }
    }
  }

  if (!text) {
    try {
      text = await fetchText({ url: pageUrl, headers: PAGE_HEADERS, label: "Facebook", timeoutMs: settings.httpTimeoutMs });
    } catch (error) {
      // Facebook frequently returns HTTP 400 to non-browser clients while
      // serving the same public Reel to a normal anonymous browser.
      if (error?.code !== ErrorCode.UPSTREAM_BLOCKED) throw error;
      try {
        const rendered = await renderFacebookPageAnonymously(pageUrl, settings.httpTimeoutMs);
        if (rendered.pageUrl && rendered.pageUrl !== pageUrl) {
          pageUrl = rendered.pageUrl;
          applyFacebookReelRedirect(normalized, pageUrl);
        }
        if (rendered.html) {
          text = rendered.html;
          renderedMediaUrls = rendered.mediaUrls;
        }
      } catch {
        // Preserve the original upstream error if browser fallback cannot start.
      }
      if (!text) throw error;
    }
  }
  const urls = [...extractFacebookNativeVideoUrls(text, normalized.shortcode), ...renderedMediaUrls];

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

function isFacebookShareUrl(value) {
  try {
    const parsed = new URL(value);
    return parsed.hostname.toLowerCase().endsWith("facebook.com") && parsed.pathname.split("/").filter(Boolean)[0] === "share";
  } catch {
    return false;
  }
}

function isFacebookContentUrl(value) {
  try {
    const parsed = new URL(value);
    if (!parsed.hostname.toLowerCase().endsWith("facebook.com")) return false;
    const parts = parsed.pathname.split("/").filter(Boolean);
    return parts[0] === "reel" || (parts.length >= 2 && parts[1] === "videos");
  } catch {
    return false;
  }
}

function applyFacebookReelRedirect(normalized, value) {
  try {
    const parsed = new URL(value);
    const parts = parsed.pathname.split("/").filter(Boolean);
    if (!parsed.hostname.toLowerCase().endsWith("facebook.com") || parts[0] !== "reel" || !parts[1]) return;
    normalized.canonical_url = `https://www.facebook.com/reel/${parts[1]}`;
    normalized.shortcode = parts[1];
    normalized.kind = "reel";
  } catch {
    // Keep the original share URL when the browser returns an invalid address.
  }
}

function extractFacebookNativeVideoUrls(text, targetId) {
  const urls = [];
  const targetMarker = targetId ? `"id":"${targetId}"` : "";
  if (targetMarker) {
    let markerIndex = text.indexOf(targetMarker);
    while (markerIndex >= 0) {
      const segment = text.slice(Math.max(0, markerIndex - 30_000), markerIndex + targetMarker.length);
      for (const key of ["browser_native_hd_url", "browser_native_sd_url"]) {
        const matches = [...segment.matchAll(new RegExp(`"${key}":(".*?")`, "g"))];
        pushDecodedUrl(urls, matches.at(-1)?.[1]);
      }
      if (urls.length) break;
      markerIndex = text.indexOf(targetMarker, markerIndex + targetMarker.length);
    }
  }
  if (!urls.length) {
    for (const key of ["browser_native_hd_url", "browser_native_sd_url"]) {
      for (const match of text.matchAll(new RegExp(`"${key}":(".*?")`, "g"))) pushDecodedUrl(urls, match[1]);
    }
  }
  return [...new Set(urls)];
}

function pushDecodedUrl(urls, encoded) {
  if (!encoded) return;
  try {
    const url = JSON.parse(encoded);
    if (typeof url === "string" && url.startsWith("http")) urls.push(htmlUnescape(url));
  } catch {
    // Ignore malformed Facebook payload fragments.
  }
}


export function isFacebookHost(host) {
  return ["facebook.com", "www.facebook.com", "web.facebook.com", "m.facebook.com", "fb.watch"].includes(host);
}
