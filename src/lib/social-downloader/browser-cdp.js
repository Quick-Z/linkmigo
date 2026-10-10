import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";

// Shared headless-Chrome plumbing over the DevTools Protocol. Facebook and
// Douyin both need a real browser: their public pages hand the media metadata
// to client-side JavaScript, so a plain HTTP fetch only ever sees the shell.

const DEFAULT_WINDOW_SIZE = "1280,900";

export function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function resolveChromePath() {
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

export async function findFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = server.address()?.port;
      server.close(() => (port ? resolve(port) : reject(new Error("无法分配浏览器调试端口。"))));
    });
  });
}

/**
 * Launch a throwaway headless Chrome, run `handler({ cdp, port })`, then always
 * tear the browser down. `handler` owns whatever DevTools domains it needs.
 */
export async function withHeadlessChrome(options, handler) {
  const {
    label = "匿名",
    userAgent = "",
    windowSize = DEFAULT_WINDOW_SIZE,
    extraArgs = [],
    launchTimeoutMs = 20_000,
    missingBrowserMessage = `服务器未找到 Chromium 或 Google Chrome，无法使用匿名浏览器解析 ${label}。`,
    userDataDirPrefix = "linkmigo-browser-",
  } = options || {};

  if (typeof handler !== "function") {
    throw new Error("withHeadlessChrome 需要一个处理函数。");
  }

  const chromePath = resolveChromePath();

  if (!chromePath) {
    throw new Error(missingBrowserMessage);
  }

  const port = await findFreePort();
  const userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), userDataDirPrefix));
  let child = null;
  let cdp = null;

  try {
    const args = [
      "--headless=new",
      "--disable-gpu",
      "--no-sandbox",
      "--disable-dev-shm-usage",
      "--disable-background-networking",
      "--disable-sync",
      "--disable-extensions",
      "--disable-blink-features=AutomationControlled",
      "--lang=zh-CN",
      `--window-size=${windowSize}`,
      "--remote-allow-origins=*",
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${userDataDir}`,
    ];

    if (userAgent) {
      args.push(`--user-agent=${userAgent}`);
    }

    args.push(...extraArgs, "about:blank");

    child = spawn(chromePath, args, { stdio: "ignore", env: process.env });
    child.once("error", () => {});

    const page = await openDevToolsPage(port, launchTimeoutMs, "about:blank", label);
    cdp = await openDevToolsSession(page.webSocketDebuggerUrl, launchTimeoutMs, label);

    return await handler({ cdp, port });
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

export async function openDevToolsPage(port, timeoutMs, initialUrl, label = "匿名") {
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

  throw new Error(`等待 ${label} 匿名浏览器启动超时。`);
}

export async function openDevToolsSession(url, timeoutMs, label = "匿名") {
  if (typeof WebSocket !== "function") {
    throw new Error("当前 Node.js 不支持浏览器控制连接。");
  }

  const socket = new WebSocket(url);
  const pending = new Map();
  const listeners = new Map();
  let nextId = 1;

  await new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`连接 ${label} 匿名浏览器超时。`)),
      Math.min(timeoutMs, 5000),
    );
    socket.addEventListener("open", () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
    socket.addEventListener("error", () => {
      clearTimeout(timer);
      reject(new Error(`无法连接 ${label} 匿名浏览器。`));
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
