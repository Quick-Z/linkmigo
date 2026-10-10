import { wait, withHeadlessChrome } from "./browser-cdp";

export async function renderFacebookPageAnonymously(url, timeoutMs = 25_000) {
  if (!url) return { html: "", pageUrl: "", mediaUrls: [] };

  const mediaUrls = new Set();

  return withHeadlessChrome(
    {
      label: "Facebook",
      launchTimeoutMs: 20_000,
      missingBrowserMessage:
        "服务器未找到 Chromium 或 Google Chrome，无法使用匿名浏览器解析 Facebook。",
      userDataDirPrefix: "linkmigo-facebook-anonymous-",
    },
    async ({ cdp }) => {
      await cdp.send("Page.enable");
      await cdp.send("Network.enable");

      const removeListener = cdp.on("Network.responseReceived", (params) => {
        const responseUrl = String(params?.response?.url || "");
        const mimeType = String(params?.response?.mimeType || "");
        if (
          /^https?:\/\//i.test(responseUrl) &&
          (/^video\//i.test(mimeType) || /\.mp4(?:[?#]|$)/i.test(responseUrl))
        ) {
          mediaUrls.add(responseUrl);
        }
      });

      try {
        await cdp.send("Page.navigate", { url });
        const deadline = Date.now() + Math.max(8_000, Number(timeoutMs) || 25_000);
        let settledAt = 0;

        while (Date.now() < deadline) {
          const result = await cdp.send("Runtime.evaluate", {
            expression: `(() => { const html = document.documentElement?.outerHTML || ''; const close = Array.from(document.querySelectorAll('[role="dialog"] button')).find((button) => /^(?:关闭|close)$/i.test((button.getAttribute('aria-label') || button.innerText || '').trim())); if (close) close.click(); return { ready: document.readyState, hasMedia: /browser_native_(?:hd|sd)_url/.test(html), textLength: document.body?.innerText?.length || 0 }; })()`,
            returnByValue: true,
          }).catch(() => null);
          const state = result?.result?.value || {};

          if (state.ready === "complete" && state.hasMedia) break;
          if (state.ready === "complete" && state.textLength > 100) {
            settledAt ||= Date.now();
            if (Date.now() - settledAt > 5_000) break;
          }
          await wait(300);
        }

        const htmlResult = await cdp.send("Runtime.evaluate", {
          expression: "document.documentElement?.outerHTML || ''",
          returnByValue: true,
        }).catch(() => null);
        const urlResult = await cdp.send("Runtime.evaluate", {
          expression: "location.href",
          returnByValue: true,
        }).catch(() => null);

        return {
          html: String(htmlResult?.result?.value || ""),
          pageUrl: String(urlResult?.result?.value || url),
          mediaUrls: [...mediaUrls],
        };
      } finally {
        removeListener();
      }
    },
  );
}
