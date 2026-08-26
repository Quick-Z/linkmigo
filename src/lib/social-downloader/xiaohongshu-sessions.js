import crypto from "node:crypto";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";

const sessionsKey = "__linkmigoXiaohongshuSessions";
const sessionTtlMs = 2 * 60 * 60 * 1000;

function store() {
  globalThis[sessionsKey] ||= new Map();
  return globalThis[sessionsKey];
}

export function getXiaohongshuSessionId(request) {
  const value = request?.cookies?.get("linkmigo_xhs_session")?.value || "";
  return /^[a-f0-9]{48}$/.test(value) ? value : "";
}

export function ensureXiaohongshuSession(request) {
  const existing = getXiaohongshuSessionId(request);
  if (existing && store().has(existing)) {
    touch(existing);
    return existing;
  }

  const id = crypto.randomBytes(24).toString("hex");
  store().set(id, { id, status: "anonymous", cookie: "", createdAt: Date.now(), updatedAt: Date.now() });
  return id;
}

export function xiaohongshuSessionCookie(sessionId) {
  const session = store().get(String(sessionId || ""));
  if (!session || session.updatedAt + sessionTtlMs < Date.now()) {
    store().delete(String(sessionId || ""));
    return "";
  }
  touch(session.id);
  return session.cookie || "";
}

export function xiaohongshuSessionSnapshot(sessionId) {
  const session = store().get(String(sessionId || ""));
  if (!session) return { status: "anonymous" };
  touch(session.id);
  return {
    status: session.status,
    qr_data_url: session.qrDataUrl || null,
    expires_at: session.qrExpiresAt ? new Date(session.qrExpiresAt).toISOString() : null,
    error: session.error || null,
  };
}

export async function startXiaohongshuQrLogin(sessionId) {
  const session = store().get(String(sessionId || ""));
  if (!session) throw new Error("小红书登录会话不存在。");
  if (session.status === "pending" && session.qrDataUrl) return xiaohongshuSessionSnapshot(session.id);

  if (session.expiryTimer) clearTimeout(session.expiryTimer);
  session.expiryTimer = null;
  await stopBrowser(session);
  // A new QR flow must not inherit a previous cookie or authenticated state.
  // XHS can issue a web_session cookie on the anonymous login page, so the
  // cookie alone is never sufficient evidence that the QR code was scanned.
  session.cookie = "";
  session.qrDataUrl = null;
  session.loginBaselineWebSession = "";
  session.loginConfirmationCount = 0;
  session.status = "anonymous";
  session.error = null;
  const chromePath = resolveChromePath();
  if (!chromePath) {
    session.status = "error";
    session.error = "服务器未找到 Chromium/Google Chrome，无法生成扫码登录二维码。";
    return xiaohongshuSessionSnapshot(session.id);
  }

  const port = await findFreePort();
  const userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), "linkmigo-xhs-login-"));
  const headless = process.env.LINKMIGO_XHS_HEADLESS === "1"
    ? true
    : process.env.LINKMIGO_XHS_HEADLESS === "0"
      ? false
      : process.platform !== "darwin";
  const configuredXvfb = process.env.LINKMIGO_XHS_XVFB === "1";
  const xvfbPath = resolveXvfbPath();
  if (configuredXvfb && !xvfbPath) {
    session.status = "error";
    session.error = "Docker 镜像缺少 xvfb-run。请重新构建包含 xvfb 和 xauth 的镜像，或暂时设置 LINKMIGO_XHS_XVFB=0。";
    return xiaohongshuSessionSnapshot(session.id);
  }
  const useXvfb = configuredXvfb && Boolean(xvfbPath);
  const launchCommand = useXvfb ? xvfbPath : chromePath;
  const launchArgs = useXvfb
    ? ["-a", "--server-args=-screen 0 1280x1000x24", chromePath]
    : [];
  const effectiveHeadless = useXvfb ? false : headless;
  const child = spawn(launchCommand, [...launchArgs, ...[
    ...(effectiveHeadless ? ["--headless=new"] : []), "--disable-gpu", "--no-sandbox", "--disable-dev-shm-usage",
    "--disable-background-networking", "--disable-sync", "--disable-extensions",
    "--disable-blink-features=AutomationControlled", "--lang=zh-CN",
    "--window-size=1280,1000", "--remote-allow-origins=*", `--remote-debugging-port=${port}`,
    `--user-data-dir=${userDataDir}`, "about:blank",
  ]], { stdio: "ignore" });
  session.browser = { child, port, userDataDir };
  let launchError = null;
  child.once("error", (error) => {
    launchError = error;
  });
  session.status = "pending";
  session.error = null;
  session.qrExpiresAt = Date.now() + 5 * 60 * 1000;
  touch(session.id);

  try {
    const page = await openDevToolsPage(port, 20_000, "about:blank");
    if (launchError) throw launchError;
    session.cdp = await openDevToolsSession(page.webSocketDebuggerUrl, 20_000);
    await session.cdp.send("Page.enable");
    await session.cdp.send("Network.enable");
    await session.cdp.send("Network.clearBrowserCookies");
    await session.cdp.send("Network.clearBrowserCache").catch(() => {});
    await session.cdp.send("Page.navigate", { url: "https://www.xiaohongshu.com/explore" });
    const qr = await waitForLoginQr(session.cdp, 20_000);
    session.qrDataUrl = qr;
    if (!qr) {
      throw new Error("小红书登录页没有返回二维码，可能触发了安全验证。请稍后重试或配置 SOCIAL_XIAOHONGSHU_COOKIE。");
    }
    const initialCookies = await session.cdp.send("Network.getAllCookies").catch(() => ({ cookies: [] }));
    session.loginBaselineWebSession = (initialCookies?.cookies || [])
      .find((item) => item.name === "web_session")?.value || "";
    session.loginConfirmationCount = 0;
    monitorLogin(session.id);
  } catch (error) {
    session.status = "error";
    session.error = error?.message || "无法启动小红书扫码登录。";
    await stopBrowser(session);
  }
  return xiaohongshuSessionSnapshot(session.id);
}

export async function logoutXiaohongshuSession(sessionId) {
  const session = store().get(String(sessionId || ""));
  if (!session) return;
  await stopBrowser(session);
  if (session.expiryTimer) clearTimeout(session.expiryTimer);
  session.expiryTimer = null;
  session.status = "anonymous";
  session.cookie = "";
  session.qrDataUrl = null;
  session.loginBaselineWebSession = "";
  session.loginConfirmationCount = 0;
  session.error = null;
  touch(session.id);
}

/**
 * Run a search in the browser that completed QR login and return the rendered
 * page plus the captured search response. Reusing this browser is important:
 * XHS binds search requests to the logged-in browser/device context, so
 * copying only cookies into a fresh Chromium profile is often not sufficient.
 */
export async function searchXiaohongshuInSession(sessionId, keyword, timeoutMs = 25_000, options = {}) {
  const session = store().get(String(sessionId || ""));
  if (!session || session.status !== "authenticated" || !session.cdp) return { html: "", payload: null };

  const query = String(keyword || "").trim();
  if (!query) return { html: "", payload: null };
  const requestedPage = Math.min(Math.max(Number.parseInt(options.page, 10) || 1, 1), 100);
  const isLoadMore = requestedPage > 1;

  // Serialize page operations for a session. A second request must wait for
  // the first one; otherwise it can receive the previous keyword's payload.
  if (session.searchPromise) {
    await session.searchPromise.catch(() => {});
    if (session.status !== "authenticated" || !session.cdp) return { html: "", payload: null };
  }
  const cachedPage = session.searchState?.keyword === query
    ? session.searchState.pages?.[requestedPage]
    : null;
  if (isLoadMore && cachedPage) return cachedPage;
  if (isLoadMore && session.searchState?.keyword !== query) {
    return { html: "", cards: [], payload: null };
  }
  let removeNetworkListener = () => {};
  let removeLoadingListener = () => {};
  session.searchPromise = (async () => {
    const cdp = session.cdp;
    const searchPayloads = [];
    const responseIds = new Set();
    const capturePromises = new Map();
    const captureResponseBody = async (requestId) => {
      if (!requestId) return;
      if (!capturePromises.has(requestId)) {
        capturePromises.set(requestId, (async () => {
          for (let attempt = 0; attempt < 4; attempt += 1) {
            try {
              const bodyResult = await cdp.send("Network.getResponseBody", { requestId }, 5_000);
              let text = String(bodyResult?.body || "");
              if (bodyResult?.base64Encoded) text = Buffer.from(text, "base64").toString("utf8");
              const payload = JSON.parse(text);
              const items = Array.isArray(payload?.data?.items) ? payload.data.items : Array.isArray(payload?.items) ? payload.items : [];
              // Keep successful empty responses as well. They distinguish a
              // real zero-result query from a request that was never captured.
              if (items.length || payload?.success === true || payload?.code === 0) {
                searchPayloads.push(payload);
              }
              return;
            } catch {
              if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, 200));
            }
          }
        })());
      }
      return capturePromises.get(requestId);
    };
    removeNetworkListener = cdp.on?.("Network.responseReceived", (params) => {
      const responseUrl = String(params?.response?.url || "");
      if (/\/api\/sns\/web\/(?:v1|v2)\/search\/notes(?:\?|$)/.test(responseUrl)) {
        responseIds.add(String(params.requestId || ""));
      }
    });
    removeLoadingListener = cdp.on?.("Network.loadingFinished", (params) => {
      const requestId = String(params?.requestId || "");
      if (responseIds.has(requestId)) captureResponseBody(requestId);
    });
    const searchUrl = new URL("https://www.xiaohongshu.com/search_result");
    searchUrl.searchParams.set("keyword", query);
    searchUrl.searchParams.set("source", "web_search_result_notes");

    await cdp.send("Page.enable");
    await cdp.send("Network.enable");
    let baselineCardHrefs = [];
    if (isLoadMore) {
      const baseline = await cdp.send("Runtime.evaluate", {
        expression: `Array.from(document.querySelectorAll('[href*="/explore/"], [href*="/discovery/item/"]')).map((node) => (node.closest('a') || node).getAttribute('href') || '').filter(Boolean)`,
        returnByValue: true,
      }).catch(() => null);
      baselineCardHrefs = Array.isArray(baseline?.result?.value) ? baseline.result.value : [];
    } else {
      await cdp.send("Page.navigate", { url: searchUrl.toString() });
    }

    const deadline = Date.now() + Math.max(3_000, timeoutMs);
    let interactionAttempted = false;
    let lastCardCount = 0;
    while (Date.now() < deadline) {
      if (isLoadMore) {
        await cdp.send("Runtime.evaluate", {
          expression: `(() => {
            const scrollingElement = document.scrollingElement || document.documentElement;
            scrollingElement.scrollTop = scrollingElement.scrollHeight;
            window.scrollTo(0, scrollingElement.scrollHeight);
            for (const element of document.querySelectorAll('main, section, div')) {
              const style = getComputedStyle(element);
              if (!/(?:auto|scroll)/.test(style.overflowY) || element.scrollHeight <= element.clientHeight + 80) continue;
              element.scrollTop = element.scrollHeight;
              element.dispatchEvent(new Event('scroll', { bubbles: true }));
            }
            window.dispatchEvent(new Event('scroll'));
            return true;
          })()`,
          returnByValue: true,
        }).catch(() => {});
        await cdp.send("Input.dispatchMouseEvent", {
          type: "mouseWheel",
          x: 640,
          y: 850,
          deltaX: 0,
          deltaY: 1800,
        }).catch(() => {});
      }

      const state = await cdp.send("Runtime.evaluate", {
        expression: `(() => {
          const links = Array.from(document.querySelectorAll('[href*="/explore/"], [href*="/discovery/item/"]'));
          const cards = links.filter((node) => (node.closest('a') || node).querySelector('img, source, video'));
          const input = document.querySelector('input[type="search"], input[placeholder*="搜索"], .input-box input');
      return { ready: document.readyState, cards: cards.length, href: location.href, hasInput: Boolean(input), queryInUrl: decodeURIComponent(location.href).includes(${JSON.stringify(query)}) };
        })()`,
        returnByValue: true,
      }).catch(() => null);
      const value = state?.result?.value || {};
      lastCardCount = Math.max(lastCardCount, Number(value.cards) || 0);

      if (isLoadMore) {
        const hasSearchItems = searchPayloads.some((payload) => {
          return (Array.isArray(payload?.data?.items) && payload.data.items.length > 0)
            || (Array.isArray(payload?.items) && payload.items.length > 0);
        });
        if (hasSearchItems) break;
        await new Promise((resolve) => setTimeout(resolve, 350));
        continue;
      }

      // Some XHS builds ignore the keyword query string until the search box
      // receives an input/Enter event. Trigger the same UI path once when the
      // initial navigation has settled without producing cards.
      if (!interactionAttempted && value.ready === "complete" && value.hasInput) {
        interactionAttempted = true;
        const encoded = JSON.stringify(query);
        await cdp.send("Runtime.evaluate", {
          expression: `(() => {
            const input = document.querySelector('input[type="search"], input[placeholder*="搜索"], .input-box input');
            if (!input) return false;
            const value = ${encoded};
            const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
            setter ? setter.call(input, value) : (input.value = value);
            input.dispatchEvent(new Event('input', { bubbles: true }));
            input.dispatchEvent(new Event('change', { bubbles: true }));
            input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true }));
            input.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', bubbles: true }));
            const button = document.querySelector('.input-box .input-button, .input-box .search-icon, button[type="submit"]');
            button?.click();
            return true;
          })()`,
          returnByValue: true,
        }).catch(() => {});
      }

      if (value.cards > 0 && (value.queryInUrl || value.ready === "loading")) {
        // Scroll a little to force the virtualized result list to mount more
        // cards, matching the behavior of the desktop helper application.
        await cdp.send("Runtime.evaluate", {
          expression: "window.scrollTo(0, Math.min(document.body.scrollHeight, window.innerHeight * 2));",
        }).catch(() => {});
        if (lastCardCount >= 3 || Date.now() + 1_000 >= deadline) break;
      }
      const hasSearchItems = searchPayloads.some((payload) => {
        return (Array.isArray(payload?.data?.items) && payload.data.items.length > 0)
          || (Array.isArray(payload?.items) && payload.items.length > 0);
      });
      if (hasSearchItems || (interactionAttempted && searchPayloads.length > 0)) break;
      await new Promise((resolve) => setTimeout(resolve, 300));
    }

    // Give the responseReceived handler a moment to fetch the JSON body after
    // the result cards have mounted.
    if (searchPayloads.length === 0) {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }

    const html = await cdp.send("Runtime.evaluate", {
      expression: "document.documentElement?.outerHTML || ''",
      returnByValue: true,
    });
    const cards = await cdp.send("Runtime.evaluate", {
      expression: `(() => {
        const seen = new Set();
        return Array.from(document.querySelectorAll('[href*="/explore/"], [href*="/discovery/item/"]'))
          .map((node) => {
            const link = node.closest('a') || node;
            const href = link.getAttribute('href') || '';
            const media = link.querySelector('img, source, video');
            const src = media?.currentSrc || media?.getAttribute('src') || media?.getAttribute('data-src') || media?.getAttribute('data-original') || media?.getAttribute('poster') || '';
            const key = href + '|' + src;
            if (!href || !src || seen.has(key)) return null;
            seen.add(key);
            return { href, src, text: (link.innerText || '').trim() };
          })
          .filter(Boolean)
          .slice(0, 100);
      })()` ,
      returnByValue: true,
    }).catch(() => null);
    await Promise.all([...responseIds].map((requestId) => captureResponseBody(requestId)));
    removeNetworkListener?.();
    removeLoadingListener?.();
    touch(session.id);
    const baselineSet = new Set(baselineCardHrefs);
    const renderedCards = Array.isArray(cards?.result?.value) ? cards.result.value : [];
    const result = {
      html: String(html?.result?.value || ""),
      cards: isLoadMore
        ? renderedCards.filter((card) => !baselineSet.has(String(card?.href || "")))
        : renderedCards,
      payload: searchPayloads.at(-1) || null,
    };
    if (!isLoadMore) {
      session.searchState = { keyword: query, pages: {} };
    } else {
      session.searchState ||= { keyword: query, pages: {} };
      session.searchState.pages ||= {};
      session.searchState.pages[requestedPage] = {
        html: "",
        cards: result.cards,
        payload: result.payload,
      };
    }
    return result;
  })().finally(() => {
    removeNetworkListener?.();
    removeLoadingListener?.();
    session.searchPromise = null;
  });

  return session.searchPromise;
}

/**
 * Render an XHS page in a temporary Chromium profile with the supplied
 * authenticated cookie. This is used for pages whose comment list is loaded
 * only after the browser executes the site's JavaScript.
 */
export async function renderXiaohongshuPage(url, cookieHeader, timeoutMs = 20_000, options = {}) {
  const chromePath = resolveChromePath();
  if (!chromePath || !url) return "";

  const port = await findFreePort();
  const userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), "linkmigo-xhs-render-"));
  const child = spawn(chromePath, [
    "--headless=new",
    "--disable-gpu",
    "--no-sandbox",
    "--disable-dev-shm-usage",
    "--disable-background-networking",
    "--disable-component-update",
    "--disable-default-apps",
    "--disable-extensions",
    "--disable-sync",
    "--disable-features=AutofillServerCommunication,MediaRouter,OptimizationGuideModelDownloading",
    "--metrics-recording-only",
    "--mute-audio",
    "--no-first-run",
    "--no-default-browser-check",
    `--user-data-dir=${userDataDir}`,
    `--remote-debugging-port=${port}`,
    "about:blank",
  ], { stdio: "ignore" });

  let cdp = null;
  try {
    const page = await openDevToolsPage(port, timeoutMs, "https://www.xiaohongshu.com/explore");
    cdp = await openDevToolsSession(page.webSocketDebuggerUrl, timeoutMs);
    await cdp.send("Network.enable");
    await cdp.send("Page.enable");

    for (const { name, value } of parseCookieHeader(cookieHeader)) {
      await cdp.send("Network.setCookie", {
        name,
        value,
        domain: ".xiaohongshu.com",
        path: "/",
        secure: true,
      }).catch(() => {});
    }

    await cdp.send("Page.navigate", { url });
    const deadline = Date.now() + Math.max(1_000, timeoutMs);
    let commentRegionSeenAt = 0;
    while (Date.now() < deadline) {
      const state = await cdp.send("Runtime.evaluate", {
        expression: options.waitFor === "search"
          ? `(() => ({
              ready: document.readyState,
              cards: Array.from(document.querySelectorAll('a[href*="/explore/"]')).filter((node) => node.querySelector('img')).length,
            }))()`
          : `(() => ({
              ready: document.readyState,
              comments: document.querySelectorAll('.parent-comment').length,
              commentRegion: Boolean(document.querySelector('.comments-el')),
            }))()`,
        returnByValue: true,
      }).catch(() => null);
      const value = state?.result?.value || {};
      if (options.waitFor === "search" && value.cards > 0) {
        break;
      }
      if (options.waitFor === "search") {
        await new Promise((resolve) => setTimeout(resolve, 250));
        continue;
      }
      if (value.comments > 0) {
        break;
      }
      if (value.ready === "complete" && value.commentRegion) {
        if (!commentRegionSeenAt) {
          commentRegionSeenAt = Date.now();
          await cdp.send("Runtime.evaluate", {
            expression: `(() => {
              const el = document.querySelector('.comments-el, .comments-container, .note-scroller');
              if (!el) return;
              el.scrollIntoView({ block: 'center' });
              el.scrollTop = Math.min(240, el.scrollHeight);
              el.dispatchEvent(new Event('scroll', { bubbles: true }));
            })()`,
          }).catch(() => {});
        }
        if (Date.now() - commentRegionSeenAt > 3_000) break;
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }

    const html = await cdp.send("Runtime.evaluate", {
      expression: "document.documentElement?.outerHTML || ''",
      returnByValue: true,
    });
    return String(html?.result?.value || "");
  } catch {
    return "";
  } finally {
    try { cdp?.close?.(); } catch {}
    try { child.kill?.(); } catch {}
    await fs.rm(userDataDir, { recursive: true, force: true }).catch(() => {});
  }
}

function parseCookieHeader(value) {
  return String(value || "")
    .split(";")
    .map((part) => part.trim())
    .map((part) => {
      const index = part.indexOf("=");
      return index > 0 ? { name: part.slice(0, index).trim(), value: part.slice(index + 1).trim() } : null;
    })
    .filter((cookie) => cookie?.name && cookie.value);
}

function monitorLogin(sessionId) {
  const session = store().get(sessionId);
  if (!session || session.monitor) return;
  session.monitor = setInterval(async () => {
    const current = store().get(sessionId);
    if (!current || current.status !== "pending") return;
    if (current.monitorRunning) return;
    current.monitorRunning = true;
    if (Date.now() > current.qrExpiresAt) {
      current.status = "expired";
      await stopBrowser(current);
      current.monitorRunning = false;
      return;
    }
    try {
      const loginState = await current.cdp.send("Runtime.evaluate", {
        expression: `(() => {
          const qr = document.querySelector('.login-container .qrcode-img');
          const qrRect = qr?.getBoundingClientRect?.();
          return JSON.stringify({
            qrVisible: Boolean(qr && qrRect?.width > 0 && qrRect?.height > 0),
            href: location.href,
          });
        })()`,
        returnByValue: true,
      });
      let pageState = {};
      try { pageState = JSON.parse(loginState?.result?.value || "{}"); } catch {}
      const result = await current.cdp.send("Network.getAllCookies");
      const cookies = (result?.cookies || []).filter((cookie) => /(?:^|\.)xiaohongshu\.com$/.test(cookie.domain));
      const cookie = cookies.map((item) => `${item.name}=${item.value}`).join("; ");
      const hasSessionCookie = cookies.some((item) => item.name === "web_session" && String(item.value || "").length > 10);
      const currentWebSession = cookies.find((item) => item.name === "web_session")?.value || "";
      const cookieChanged = Boolean(currentWebSession && currentWebSession !== current.loginBaselineWebSession);
      const isLoginPage = /\/login(?:[/?#]|$)/i.test(pageState.href || "");
      const hasFreshLoginEvidence = cookieChanged && pageState.qrVisible === false && !isLoginPage;
      current.loginConfirmationCount = hasFreshLoginEvidence
        ? (current.loginConfirmationCount || 0) + 1
        : 0;
      const isLoggedIn = current.loginConfirmationCount >= 2;
      if (isLoggedIn && hasSessionCookie && cookie) {
        current.cookie = cookie;
        current.status = "authenticated";
        current.qrDataUrl = null;
        // Keep the authenticated Chromium/CDP context alive. XHS search uses
        // browser-generated state/signatures and can fail when only cookies
        // are copied into a new profile.
        if (current.monitor) clearInterval(current.monitor);
        current.monitor = null;
        current.loginBaselineWebSession = "";
        current.loginConfirmationCount = 0;
        scheduleSessionExpiry(current);
      }
      touch(sessionId);
    } catch {
      current.status = "error";
      current.error = "扫码登录浏览器会话已断开。";
      await stopBrowser(current);
    } finally {
      current.monitorRunning = false;
    }
  }, 1500);
}

function scheduleSessionExpiry(session) {
  if (session.expiryTimer) clearTimeout(session.expiryTimer);
  session.expiryTimer = setTimeout(async () => {
    const current = store().get(session.id);
    if (!current) return;
    if (current.updatedAt + sessionTtlMs > Date.now()) {
      scheduleSessionExpiry(current);
      return;
    }
    await stopBrowser(current);
    store().delete(current.id);
  }, sessionTtlMs + 1_000);
  session.expiryTimer.unref?.();
}

async function stopBrowser(session, options = {}) {
  if (session.monitor) clearInterval(session.monitor);
  session.monitor = null;
  try { session.cdp?.close?.(); } catch {}
  session.cdp = null;
  try { session.browser?.child?.kill?.(); } catch {}
  const dir = session.browser?.userDataDir;
  session.browser = null;
  if (dir) await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
}

function touch(id) {
  const session = store().get(id);
  if (session) session.updatedAt = Date.now();
}

async function findFreePort() {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = server.address()?.port;
      server.close(() => port ? resolve(port) : reject(new Error("无法分配浏览器调试端口。")));
    });
  });
}

async function openDevToolsPage(port, timeoutMs, initialUrl = "https://www.xiaohongshu.com/explore") {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const version = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (version.ok) {
        const created = await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(initialUrl)}`, { method: "PUT" });
        const page = await created.json();
        if (page?.webSocketDebuggerUrl) return page;
      }
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error("等待浏览器调试端口超时。");
}

async function waitForLoginQr(cdp, timeoutMs) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const result = await cdp.send("Runtime.evaluate", {
        expression: `(() => {
          const node = document.querySelector('.login-container .qrcode-img');
          const rect = node ? node.getBoundingClientRect() : null;
          return JSON.stringify({ src: node?.getAttribute('src') || '', rect: rect && { x: rect.x, y: rect.y, width: rect.width, height: rect.height } });
        })()`,
        returnByValue: true,
      });
      const raw = result?.result?.value || "";
      const state = JSON.parse(raw || "{}");
      if (state.src) {
        if (/^data:image\//i.test(state.src)) return state.src;
        try {
          const response = await fetch(state.src);
          if (response.ok) {
            const type = response.headers.get("content-type") || "image/png";
            const bytes = Buffer.from(await response.arrayBuffer()).toString("base64");
            return `data:${type};base64,${bytes}`;
          }
        } catch {}
        if (state.rect?.width > 0 && state.rect?.height > 0) {
          const shot = await cdp.send("Page.captureScreenshot", {
            format: "png",
            clip: { ...state.rect, scale: 1 },
          }).catch(() => null);
          if (shot?.data) return `data:image/png;base64,${shot.data}`;
        }
      }
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return "";
}

async function openDevToolsSession(url, timeoutMs) {
  if (typeof WebSocket !== "function") throw new Error("当前 Node.js 不支持浏览器控制连接。");
  const socket = new WebSocket(url);
  const pending = new Map();
  const listeners = new Map();
  let nextId = 1;
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("连接浏览器控制通道超时。")), Math.min(timeoutMs, 5000));
    socket.addEventListener("open", () => { clearTimeout(timer); resolve(); }, { once: true });
    socket.addEventListener("error", () => { clearTimeout(timer); reject(new Error("无法连接浏览器控制通道。")); }, { once: true });
  });
  socket.addEventListener("message", (event) => {
    let message;
    try { message = JSON.parse(String(event.data || "")); } catch { return; }
    const entry = pending.get(message?.id);
    if (entry) {
      pending.delete(message.id);
      message.error ? entry.reject(new Error(message.error.message || "Chrome DevTools error")) : entry.resolve(message.result);
      return;
    }
    const handlers = listeners.get(message?.method) || [];
    for (const handler of handlers) {
      Promise.resolve(handler(message.params || {})).catch(() => {});
    }
  });
  return {
    send(method, params = {}, timeout = 10_000) {
      const id = nextId++;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { pending.delete(id); reject(new Error(`浏览器操作超时：${method}`)); }, timeout);
        pending.set(id, { resolve: (value) => { clearTimeout(timer); resolve(value); }, reject: (error) => { clearTimeout(timer); reject(error); } });
        socket.send(JSON.stringify({ id, method, params }));
      });
    },
    on(method, handler) {
      if (!method || typeof handler !== "function") return () => {};
      const handlers = listeners.get(method) || [];
      handlers.push(handler);
      listeners.set(method, handlers);
      return () => {
        const current = listeners.get(method) || [];
        const index = current.indexOf(handler);
        if (index >= 0) current.splice(index, 1);
        if (current.length === 0) listeners.delete(method);
      };
    },
    close() { try { socket.close(); } catch {} },
  };
}

function resolveChromePath() {
  const home = os.homedir();
  const rodRoot = path.join(home, ".cache/rod/browser");
  const rodCandidates = (() => {
    try {
      return readdirSync(rodRoot).sort().reverse().map((name) => path.join(rodRoot, name, "Chromium.app/Contents/MacOS/Chromium"));
    } catch {
      return [];
    }
  })();
  const candidates = [process.env.CHROME_PATH, process.env.GOOGLE_CHROME_PATH, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/Applications/Chromium.app/Contents/MacOS/Chromium", "/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium", "/usr/bin/chromium-browser", ...rodCandidates];
  return candidates.find((candidate) => candidate && existsSync(candidate)) || "";
}

function resolveXvfbPath() {
  const candidates = [process.env.XVFB_RUN_PATH, "/usr/bin/xvfb-run", "/bin/xvfb-run"];
  return candidates.find((candidate) => candidate && existsSync(candidate)) || "";
}
