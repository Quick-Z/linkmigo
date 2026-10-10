import { wait, withHeadlessChrome } from "./browser-cdp";

// Douyin stopped server-rendering the video payload into the share page's
// `window._ROUTER_DATA` (only the page shell is left), and the detail API is
// gated behind the Argus risk-control signature (`__ac_nonce` / `__ac_signature`
// / `uifid` / `a_bogus`). Those values are produced by Douyin's own JavaScript,
// so an anonymous headless Chrome is used to warm up a real session and then
// ask the same origin for the aweme detail JSON.

const DOUYIN_WEB_ORIGIN = "https://www.douyin.com";
const DOUYIN_DETAIL_PATH = "/aweme/v1/web/aweme/detail/";

const MIN_BROWSER_BUDGET_MS = 30_000;
const MAX_BROWSER_BUDGET_MS = 120_000;
const SETTLE_POLL_MS = 400;
const DETAIL_FETCH_ATTEMPTS = 6;
const DETAIL_RETRY_DELAY_MS = 1_500;
const CONTENT_TYPES = new Set(["video", "note", "slides"]);

export function douyinContentPageUrl(awemeId, contentType = "video") {
  const type = CONTENT_TYPES.has(contentType) ? contentType : "video";

  return `${DOUYIN_WEB_ORIGIN}/${type}/${encodeURIComponent(String(awemeId))}`;
}

/**
 * Render a Douyin作品 page in headless Chrome and return the aweme detail
 * object that the page itself fetches.
 *
 * Returns `{ detail, mediaUrls, pageUrl, matchedRequestedAweme, diagnostics }`.
 * `detail` is `null` when Douyin refused to hand over the payload, and
 * `matchedRequestedAweme` says whether the final page really was the requested
 * work — a deleted id redirects to the discover feed, where blindly scraping
 * `<video>` would return someone else's video.
 */
export async function resolveDouyinDetailWithBrowser({
  awemeId = "",
  contentType = "video",
  pageUrl = "",
  timeoutMs = 0,
} = {}) {
  const budgetMs = Math.min(
    Math.max(Number(timeoutMs) || 0, MIN_BROWSER_BUDGET_MS),
    MAX_BROWSER_BUDGET_MS,
  );

  return withHeadlessChrome(
    {
      label: "抖音",
      // Deliberately no `--user-agent` override. Douyin's Argus SDK compares the
      // UA against the real `navigator.platform`; forcing a macOS UA inside the
      // Linux container makes the fingerprint inconsistent, so the SDK never
      // issues the final `UIFID` cookie and every detail request comes back
      // "Blocked by ArgusSecurityPlugin Uifid Not Found". The browser's own UA
      // is platform-correct everywhere (verified on macOS and in the image).
      launchTimeoutMs: Math.min(budgetMs, 30_000),
      missingBrowserMessage:
        "服务器未找到 Chromium 或 Google Chrome，无法使用匿名浏览器解析抖音。请安装 Chromium/Chrome，或用 CHROME_PATH 指定可执行文件。",
      userDataDirPrefix: "linkmigo-douyin-",
    },
    async ({ cdp }) => {
      const deadline = Date.now() + budgetMs;
      const mediaUrls = new Set();
      const failure = (diagnostics, extra = {}) => ({
        detail: null,
        mediaUrls: [...mediaUrls],
        pageUrl: "",
        matchedRequestedAweme: false,
        diagnostics,
        ...extra,
      });

      await cdp.send("Page.enable");
      await cdp.send("Network.enable");
      await cdp.send("Runtime.enable");

      cdp.on("Network.responseReceived", ({ response }) => {
        const url = String(response?.url || "");
        const mimeType = String(response?.mimeType || "");

        if (
          /^https?:\/\//i.test(url) &&
          /douyinvod\.com|aweme\.snssdk\.com/i.test(url) &&
          (/^video\//i.test(mimeType) || /mime_type=video_mp4/i.test(url) || /\.mp4(?:[?#]|$)/i.test(url))
        ) {
          mediaUrls.add(url);
        }
      });

      const initialUrl = awemeId
        ? douyinContentPageUrl(awemeId, contentType)
        : pageUrl;

      if (!initialUrl) {
        return failure("缺少抖音作品链接。");
      }

      await cdp.send("Page.navigate", { url: initialUrl });

      let settled = await settleDouyinPage(cdp, deadline);

      // A short link can land on `www.iesdouyin.com`. The detail request has to
      // be same-origin with douyin.com, so hop over once the id is known.
      if (settled.awemeId && !isDouyinWebOrigin(settled.href)) {
        await cdp.send("Page.navigate", {
          url: douyinContentPageUrl(settled.awemeId, contentType),
        });
        settled = await settleDouyinPage(cdp, deadline);
      }

      const targetId = settled.awemeId || String(awemeId || "");

      if (!targetId) {
        return failure("抖音页面没有跳转到作品详情页，可能链接已失效或需要验证。", {
          pageUrl: settled.href,
        });
      }

      let diagnostics = "";
      let answeredUnavailable = false;

      for (let attempt = 1; attempt <= DETAIL_FETCH_ATTEMPTS; attempt += 1) {
        if (Date.now() >= deadline) break;

        const result = await evaluateDouyinDetail(cdp, targetId, deadline).catch(() => null);

        if (result?.detail) {
          return {
            detail: result.detail,
            mediaUrls: [...mediaUrls],
            pageUrl: String(result.href || settled.href),
            matchedRequestedAweme: await pageStillShowsAweme(cdp, targetId, settled),
            diagnostics: "",
          };
        }

        // A parsed payload without `aweme_detail` is a definitive "not
        // available" answer (deleted / private / region-locked), so the page's
        // own playback must not be used as a substitute.
        if (result?.answered) {
          answeredUnavailable = true;
        }

        diagnostics = describeDouyinDetailFailure(result, diagnostics);

        if (attempt < DETAIL_FETCH_ATTEMPTS) {
          await wait(DETAIL_RETRY_DELAY_MS);
        }
      }

      // Deleted ids are redirected to the discover feed, but only after the
      // page has already settled — so re-check where the page ended up rather
      // than trusting the snapshot taken before the API calls.
      const matchedRequestedAweme =
        !answeredUnavailable && (await pageStillShowsAweme(cdp, targetId, settled));

      return {
        detail: null,
        mediaUrls: [...mediaUrls],
        pageUrl: settled.href,
        matchedRequestedAweme,
        diagnostics,
      };
    },
  );
}

async function pageStillShowsAweme(cdp, targetId, settled) {
  const state = await evaluateJson(cdp, "({ href: location.href })", { timeout: 5_000 }).catch(() => null);
  const href = String(state?.href || settled?.href || "");

  return douyinAwemeIdFromUrl(href) === String(targetId);
}

async function settleDouyinPage(cdp, deadline) {
  const cookieDeadline = Math.min(deadline, Date.now() + 25_000);
  let state = {};

  while (Date.now() < cookieDeadline) {
    const evaluated = await evaluateJson(cdp, pageStateExpression(), { timeout: 5_000 }).catch(() => null);
    state = evaluated || state;

    // The Argus SDK writes these cookies asynchronously after the document
    // loads; waiting for them avoids the "Blocked by ArgusSecurityPlugin" reply.
    if (state.ready === "complete" && state.cookieReady) {
      break;
    }

    await wait(SETTLE_POLL_MS);
  }

  const href = String(state.href || "");
  const awemeId = douyinAwemeIdFromUrl(href);

  if (awemeId && state.ready !== "complete") {
    await wait(500);
  }

  return { href, awemeId };
}

function pageStateExpression() {
  return `(() => ({
    href: location.href,
    ready: document.readyState,
    cookieReady: /(?:^|;\\s*)(?:s_v_web_id|__ac_signature|UIFID_TEMP|ttwid)=/.test(document.cookie)
  }))()`;
}

function evaluateDouyinDetail(cdp, awemeId, deadline) {
  const timeout = Math.max(5_000, Math.min(25_000, deadline - Date.now()));

  return evaluateJson(cdp, awemeDetailExpression(awemeId), { awaitPromise: true, timeout });
}

function awemeDetailExpression(awemeId) {
  const idLiteral = JSON.stringify(String(awemeId));

  return `(async () => {
    const awemeId = ${idLiteral};
    const query = new URLSearchParams({
      aweme_id: awemeId,
      device_platform: "webapp",
      aid: "6383",
      channel: "channel_pc_web",
      request_source: "600",
      origin_type: "video_page",
      pc_client_type: "1",
      version_code: "190500",
      version_name: "19.5.0",
      cookie_enabled: String(document.cookie.length > 0),
      screen_width: String(window.screen?.width || 1280),
      screen_height: String(window.screen?.height || 900),
      browser_language: navigator.language || "zh-CN",
      browser_platform: navigator.platform || "MacIntel",
      browser_name: "Chrome",
      browser_version: "141.0.0.0",
      browser_online: String(navigator.onLine !== false),
      engine_name: "Blink",
      engine_version: "141.0.0.0",
      os_name: "Mac OS",
      os_version: "10.15.7",
      platform: "PC",
      downlink: "10",
      effective_type: "4g",
      round_trip_time: "100"
    });
    const out = { href: location.href, httpStatus: 0, statusCode: null, statusMessage: "", detail: null, answered: false, diagnostics: "" };
    try {
      const response = await fetch(${JSON.stringify(DOUYIN_DETAIL_PATH)} + "?" + query.toString(), {
        credentials: "include",
        headers: { accept: "application/json, text/plain, */*" }
      });
      out.httpStatus = response.status;
      const text = await response.text();
      let payload = null;
      try { payload = JSON.parse(text); } catch {}
      if (!payload) {
        out.diagnostics = text ? text.slice(0, 200) : "空响应";
        return out;
      }
      // The endpoint answered with a real payload; if it carries no detail the
      // work is genuinely unavailable rather than a transient failure.
      out.answered = true;
      out.statusCode = payload.status_code === undefined ? null : payload.status_code;
      out.statusMessage = String(payload.status_msg || "");
      const detail = payload.aweme_detail
        || (Array.isArray(payload.aweme_details) ? payload.aweme_details[0] : null);
      if (detail) {
        out.detail = detail;
      } else {
        out.diagnostics = (out.statusMessage || text).slice(0, 200);
      }
    } catch (error) {
      out.diagnostics = String(error && error.message ? error.message : error).slice(0, 200);
    }
    return out;
  })()`;
}

function describeDouyinDetailFailure(result, previous) {
  if (!result) return previous || "抖音详情接口没有返回数据。";

  const parts = [];

  if (result.httpStatus) parts.push(`HTTP ${result.httpStatus}`);
  if (result.statusCode != null) parts.push(`status_code=${result.statusCode}`);
  if (result.statusMessage) parts.push(result.statusMessage);
  if (result.diagnostics) parts.push(result.diagnostics);

  return parts.join(" ") || previous || "抖音详情接口没有返回数据。";
}

async function evaluateJson(cdp, expression, { awaitPromise = false, timeout = 10_000 } = {}) {
  let result;

  try {
    result = await cdp.send(
      "Runtime.evaluate",
      { expression, returnByValue: true, awaitPromise },
      timeout,
    );
  } catch {
    return null;
  }

  if (result?.exceptionDetails) {
    return null;
  }

  const value = result?.result?.value;

  return value && typeof value === "object" ? value : null;
}

export function douyinAwemeIdFromUrl(value) {
  const match = /\/(?:video|note|slides)\/(\d{8,32})/.exec(String(value || ""));

  return match ? match[1] : "";
}

function isDouyinWebOrigin(value) {
  try {
    return new URL(String(value)).hostname.toLowerCase() === "www.douyin.com";
  } catch {
    return false;
  }
}
