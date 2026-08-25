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

  await stopBrowser(session);
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
    const page = await openDevToolsPage(port, 20_000);
    if (launchError) throw launchError;
    session.cdp = await openDevToolsSession(page.webSocketDebuggerUrl, 20_000);
    await session.cdp.send("Page.enable");
    await session.cdp.send("Network.enable");
    const qr = await waitForLoginQr(session.cdp, 20_000);
    session.qrDataUrl = qr;
    if (!qr) {
      throw new Error("小红书登录页没有返回二维码，可能触发了安全验证。请稍后重试或配置 SOCIAL_XIAOHONGSHU_COOKIE。");
    }
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
  session.status = "anonymous";
  session.cookie = "";
  session.qrDataUrl = null;
  session.error = null;
  touch(session.id);
}

/**
 * Render an XHS page in a temporary Chromium profile with the supplied
 * authenticated cookie. This is used for pages whose comment list is loaded
 * only after the browser executes the site's JavaScript.
 */
export async function renderXiaohongshuPage(url, cookieHeader, timeoutMs = 20_000) {
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
        expression: `(() => ({
          ready: document.readyState,
          comments: document.querySelectorAll('.parent-comment').length,
          commentRegion: Boolean(document.querySelector('.comments-el')),
        }))()`,
        returnByValue: true,
      }).catch(() => null);
      const value = state?.result?.value || {};
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
    if (Date.now() > current.qrExpiresAt) {
      current.status = "expired";
      await stopBrowser(current);
      return;
    }
    try {
      const loginState = await current.cdp.send("Runtime.evaluate", {
        expression: "Boolean(document.querySelector('.main-container .user .link-wrapper .channel'))",
        returnByValue: true,
      });
      const isLoggedIn = loginState?.result?.value === true;
      const result = await current.cdp.send("Network.getAllCookies");
      const cookies = (result?.cookies || []).filter((cookie) => /(?:^|\.)xiaohongshu\.com$/.test(cookie.domain));
      const cookie = cookies.map((item) => `${item.name}=${item.value}`).join("; ");
      if (isLoggedIn && cookies.some((item) => item.name === "web_session") && cookie) {
        current.cookie = cookie;
        current.status = "authenticated";
        current.qrDataUrl = null;
        await stopBrowser(current, { keepCookie: true });
      }
      touch(sessionId);
    } catch {
      current.status = "error";
      current.error = "扫码登录浏览器会话已断开。";
      await stopBrowser(current);
    }
  }, 1500);
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
          const loggedIn = Boolean(document.querySelector('.main-container .user .link-wrapper .channel'));
          const node = document.querySelector('.login-container .qrcode-img');
          const rect = node ? node.getBoundingClientRect() : null;
          return JSON.stringify({ loggedIn, src: node?.getAttribute('src') || '', rect: rect && { x: rect.x, y: rect.y, width: rect.width, height: rect.height } });
        })()`,
        returnByValue: true,
      });
      const raw = result?.result?.value || "";
      const state = JSON.parse(raw || "{}");
      if (state.loggedIn) return "";
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
    if (!entry) return;
    pending.delete(message.id);
    message.error ? entry.reject(new Error(message.error.message || "Chrome DevTools error")) : entry.resolve(message.result);
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
