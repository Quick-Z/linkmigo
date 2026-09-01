import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";

export async function renderFacebookPageAnonymously(url, timeoutMs = 25_000) {
  if (!url) return { html: "", pageUrl: "", mediaUrls: [] };

  const chromePath = resolveChromePath();
  if (!chromePath) {
    throw new Error("服务器未找到 Chromium 或 Google Chrome，无法使用匿名浏览器解析 Facebook。");
  }

  const port = await findFreePort();
  const userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), "linkmigo-facebook-anonymous-"));
  let child = null;
  let cdp = null;
  const mediaUrls = new Set();

  try {
    child = spawn(
      chromePath,
      [
        "--headless=new",
        "--disable-gpu",
        "--no-sandbox",
        "--disable-dev-shm-usage",
        "--disable-background-networking",
        "--disable-sync",
        "--disable-extensions",
        "--disable-blink-features=AutomationControlled",
        "--lang=zh-CN",
        "--window-size=1280,900",
        "--remote-allow-origins=*",
        `--remote-debugging-port=${port}`,
        `--user-data-dir=${userDataDir}`,
        "about:blank",
      ],
      { stdio: "ignore", env: process.env },
    );
    child.once("error", () => {});

    const page = await openDevToolsPage(port, 20_000, "about:blank");
    cdp = await openDevToolsSession(page.webSocketDebuggerUrl, 20_000);
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
  } finally {
    try {
      cdp?.close?.();
    } catch {}
    try {
      child?.kill?.();
    } catch {}
    await fs.rm(userDataDir, { recursive: true, force: true }).catch(() => {});
  }
}

function resolveChromePath() {
  const rodRoot = path.join(os.homedir(), ".cache/rod/browser");
  const rodCandidates = (() => {
    try {
      return readdirSync(rodRoot)
        .sort()
        .reverse()
        .map((name) => path.join(rodRoot, name, "Chromium.app/Contents/MacOS/Chromium"));
    } catch {
      return [];
    }
  })();
  const candidates = [
    process.env.CHROME_PATH,
    process.env.GOOGLE_CHROME_PATH,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    ...rodCandidates,
  ];
  return candidates.find((candidate) => candidate && existsSync(candidate)) || "";
}

async function findFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = server.address()?.port;
      server.close(() => (port ? resolve(port) : reject(new Error("无法分配浏览器调试端口。"))));
    });
  });
}

async function openDevToolsPage(port, timeoutMs, initialUrl) {
  const started = Date.now();

  while (Date.now() - started < timeoutMs) {
    try {
      const version = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (version.ok) {
        const created = await fetch(
          `http://127.0.0.1:${port}/json/new?${encodeURIComponent(initialUrl)}`,
          { method: "PUT" },
        );
        const page = await created.json();
        if (page?.webSocketDebuggerUrl) return page;
      }
    } catch {}
    await wait(150);
  }

  throw new Error("等待 Facebook 匿名浏览器启动超时。");
}

async function openDevToolsSession(url, timeoutMs) {
  if (typeof WebSocket !== "function") {
    throw new Error("当前 Node.js 不支持浏览器控制连接。");
  }

  const socket = new WebSocket(url);
  const pending = new Map();
  const listeners = new Map();
  let nextId = 1;

  await new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("连接 Facebook 匿名浏览器超时。")),
      Math.min(timeoutMs, 5000),
    );
    socket.addEventListener("open", () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
    socket.addEventListener("error", () => {
      clearTimeout(timer);
      reject(new Error("无法连接 Facebook 匿名浏览器。"));
    }, { once: true });
  });

  socket.addEventListener("message", (event) => {
    let message;
    try {
      message = JSON.parse(String(event.data || ""));
    } catch {
      return;
    }

    const entry = pending.get(message?.id);
    if (entry) {
      pending.delete(message.id);
      if (message.error) {
        entry.reject(new Error(message.error.message || "Chrome DevTools error"));
      } else {
        entry.resolve(message.result);
      }
      return;
    }

    for (const handler of listeners.get(message?.method) || []) {
      Promise.resolve(handler(message.params || {})).catch(() => {});
    }
  });

  return {
    send(method, params = {}, timeout = 10_000) {
      const id = nextId++;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`浏览器操作超时：${method}`));
        }, timeout);
        pending.set(id, {
          resolve: (value) => {
            clearTimeout(timer);
            resolve(value);
          },
          reject: (error) => {
            clearTimeout(timer);
            reject(error);
          },
        });
        socket.send(JSON.stringify({ id, method, params }));
      });
    },
    on(method, handler) {
      const handlers = listeners.get(method) || [];
      handlers.push(handler);
      listeners.set(method, handlers);
      return () => {
        const current = listeners.get(method) || [];
        const index = current.indexOf(handler);
        if (index >= 0) current.splice(index, 1);
        if (!current.length) listeners.delete(method);
      };
    },
    close() {
      try {
        socket.close();
      } catch {}
    },
  };
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
