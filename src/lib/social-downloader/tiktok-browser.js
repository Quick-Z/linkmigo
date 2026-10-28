import { wait, withHeadlessChrome } from "./browser-cdp";
import { getProxyUrl } from "./utils";

// TikTok stopped server-rendering the item payload into the HTML it hands to
// anonymous clients: the response is only the React shell, so
// `__UNIVERSAL_DATA_FOR_REHYDRATION__` is missing and the old HTML parse ends in
// "no media found". The page still loads the payload once its own JavaScript
// runs (it is injected back into the same script tag), so an anonymous headless
// Chrome is used to render the page and read the item struct from the DOM.

const MIN_BUDGET_MS = 20_000;
const MAX_BUDGET_MS = 120_000;
const SETTLE_POLL_MS = 600;
const DEFAULT_BUDGET_MS = 60_000;

const SCOPE_KEYS = ["webapp.video-detail", "webapp.photo-detail", "webapp.image-detail"];

export function tiktokBrowserPageUrl(postId) {
  return `https://www.tiktok.com/@i/video/${encodeURIComponent(String(postId))}`;
}

/**
 * Render a TikTok post page in headless Chrome and return the `itemStruct`
 * object the page itself received.
 *
 * Returns `{ detail, pageUrl, diagnostics }`. `detail` is `null` when TikTok
 * never handed the payload over, and `diagnostics` then explains why.
 */
export async function resolveTiktokDetailWithBrowser({
  postId = "",
  pageUrl = "",
  timeoutMs = 0,
} = {}) {
  const requested = Number(timeoutMs) || DEFAULT_BUDGET_MS;
  const budgetMs = Math.min(Math.max(requested, MIN_BUDGET_MS), MAX_BUDGET_MS);
  const targetUrl = pageUrl || (postId ? tiktokBrowserPageUrl(postId) : "");

  if (!targetUrl) {
    return { detail: null, pageUrl: "", diagnostics: "缺少 TikTok 帖子链接。" };
  }

  const proxyArgs = getProxyUrl() ? [`--proxy-server=${getProxyUrl()}`] : [];

  return withHeadlessChrome(
    {
      label: "TikTok",
      extraArgs: proxyArgs,
      launchTimeoutMs: Math.min(budgetMs, 30_000),
      missingBrowserMessage:
        "服务器未找到 Chromium 或 Google Chrome，无法使用匿名浏览器解析 TikTok。请安装 Chromium/Chrome，或用 CHROME_PATH 指定可执行文件。",
      userDataDirPrefix: "linkmigo-tiktok-",
    },
    async ({ cdp }) => {
      const deadline = Date.now() + budgetMs;

      await cdp.send("Page.enable");
      await cdp.send("Runtime.enable");
      await cdp.send("Page.navigate", { url: targetUrl });

      let diagnostics = "";

      while (Date.now() < deadline) {
        const state = await evaluateJson(cdp, probeExpression(postId), { timeout: 8_000 }).catch(() => null);

        if (state?.detail) {
          return { detail: state.detail, pageUrl: state.href || targetUrl, diagnostics: "" };
        }

        if (state?.diagnostics) {
          diagnostics = state.diagnostics;
        }

        await wait(SETTLE_POLL_MS);
      }

      return {
        detail: null,
        pageUrl: targetUrl,
        diagnostics: diagnostics || "TikTok 页面在匿名浏览器中没有渲染出视频数据。",
      };
    },
  );
}

function probeExpression(postId) {
  const idLiteral = JSON.stringify(String(postId || ""));
  const scopeKeysLiteral = JSON.stringify(SCOPE_KEYS);

  return `(() => {
    const postId = ${idLiteral};
    const scopeKeys = ${scopeKeysLiteral};
    const out = { href: location.href, detail: null, diagnostics: "" };

    const pickDetail = (payload) => {
      const scope = payload && payload.__DEFAULT_SCOPE__;
      if (!scope || typeof scope !== "object") return null;
      for (const key of scopeKeys) {
        const detail = scope[key] && scope[key].itemInfo && scope[key].itemInfo.itemStruct;
        if (detail && typeof detail === "object") return detail;
      }
      return null;
    };

    const scripts = Array.from(document.querySelectorAll("script"));
    let holder = scripts.find((script) => script.id === "__UNIVERSAL_DATA_FOR_REHYDRATION__")
      || scripts.find((script) => (script.textContent || "").includes("itemStruct"));

    if (holder) {
      const text = holder.textContent || "";
      try {
        out.detail = pickDetail(JSON.parse(text));
      } catch (error) {
        out.diagnostics = "页面数据脚本解析失败：" + String(error && error.message ? error.message : error).slice(0, 120);
      }
    } else {
      out.diagnostics = "页面还没有注入 __UNIVERSAL_DATA_FOR_REHYDRATION__。";
    }

    if (!out.detail) {
      out.detail = pickDetail(window.__UNIVERSAL_DATA_FOR_REHYDRATION__);
    }

    // A deleted or private id redirects to a feed page; never hand back a
    // recommended video that merely happens to be rendered on screen.
    if (out.detail && postId && out.detail.id && String(out.detail.id) !== postId) {
      out.diagnostics = "页面渲染的是另一条视频（id " + out.detail.id + "）。";
      out.detail = null;
    }

    return out;
  })()`;
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
