import crypto from "node:crypto";
import { execFileSync } from "node:child_process";

import {
  fetch as undiciFetch,
  ProxyAgent,
} from "undici";

import { AppError, ErrorCode } from "./errors";

export const PAGE_HEADERS = {
  "user-agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
  accept:
    "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
  "accept-language": "en-US,en;q=0.9",
};

const SYSTEM_PROXY_CACHE_MS = 30_000;
const PROXY_DISABLE_VALUES = new Set(["0", "false", "no", "off", "none", "direct", "disable", "disabled"]);

let cachedSystemProxyCheckedAt = 0;
let cachedSystemProxyUrl = "";

export function optionalInt(value) {
  if (value == null || value === "" || typeof value === "boolean") {
    return null;
  }

  const number = Number.parseInt(String(value), 10);

  return Number.isFinite(number) ? number : null;
}

export function firstPresentInt(...values) {
  for (const value of values) {
    const parsed = optionalInt(value);

    if (parsed != null) {
      return parsed;
    }
  }

  return null;
}

export function hasMetricValues(metrics) {
  return [
    metrics?.like_count,
    metrics?.comment_count,
    metrics?.view_count,
    metrics?.save_count,
    metrics?.share_count,
  ].some((value) => value != null);
}

export function dig(data, ...path) {
  let current = data;

  for (const key of path) {
    if (!current || typeof current !== "object" || Array.isArray(current)) {
      return null;
    }

    current = current[key];
  }

  return current;
}

export function dedupeAssets(assets) {
  const seen = new Set();
  const deduped = [];

  for (const asset of assets) {
    const key = `${asset.media_type}:${asset.source_url}`;

    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    deduped.push(asset);
  }

  return deduped;
}

export function cleanUrl(parsed) {
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString();
}

export function htmlUnescape(value) {
  return String(value)
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) =>
      String.fromCodePoint(Number.parseInt(hex, 16)),
    )
    .replace(/&#(\d+);/g, (_, number) =>
      String.fromCodePoint(Number.parseInt(number, 10)),
    );
}

export function decodeJsonString(value) {
  try {
    return htmlUnescape(JSON.parse(`"${value}"`)).replace(/\\\//g, "/");
  } catch {
    return htmlUnescape(value).replace(/\\\//g, "/");
  }
}

export function stripJsonPrefix(text) {
  const value = text.trim();

  return value.startsWith("for (;;);") ? value.slice("for (;;);".length).trim() : value;
}

export async function responseJson(response) {
  if (response.status >= 400) {
    return null;
  }

  const text = stripJsonPrefix(await response.text());

  if (!text) {
    return null;
  }

  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export async function fetchWithTimeout(url, init = {}, timeoutMs = 20_000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const dispatcher = init.dispatcher ?? getProxyDispatcher();

  try {
    return await undiciFetch(url, {
      redirect: "follow",
      ...init,
      ...(dispatcher ? { dispatcher } : {}),
      signal: init.signal ?? controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
}

export async function fetchText(options) {
  const { text } = await fetchTextResponse(options);

  return text;
}

export async function fetchTextResponse({
  url,
  headers,
  label,
  timeoutMs,
}) {
  let response;

  try {
    response = await fetchWithTimeout(url, { headers, cache: "no-store" }, timeoutMs);
  } catch (error) {
    if (error?.name === "AbortError") {
      throw new AppError(ErrorCode.UPSTREAM_BLOCKED, `${label} 页面请求超时。`, 504);
    }

    throw new AppError(
      ErrorCode.UPSTREAM_BLOCKED,
      `无法访问 ${label} 页面（${getFetchFailureDetail(error)}）。`,
      502,
      {
        proxy: getProxyUrl() ? "enabled" : "disabled",
        hint: "请确认服务器网络或系统代理可访问该平台；也可以在 .env.local 配置 SOCIAL_PROXY_URL，例如 http://127.0.0.1:7890。",
      },
    );
  }

  if ([401, 403].includes(response.status)) {
    throw new AppError(
      ErrorCode.LOGIN_REQUIRED,
      `${label} 页面需要登录或拒绝了公开访问。`,
      403,
      responseErrorDetails(response),
    );
  }

  if (response.status === 404) {
    throw new AppError(
      ErrorCode.NO_MEDIA_FOUND,
      `没有找到这个 ${label} 内容。`,
      404,
      responseErrorDetails(response),
    );
  }

  if (response.status === 429) {
    throw new AppError(
      ErrorCode.UPSTREAM_BLOCKED,
      `${label} 对当前请求进行了限流。`,
      429,
      responseErrorDetails(response),
    );
  }

  if (response.status >= 400) {
    throw new AppError(
      ErrorCode.UPSTREAM_BLOCKED,
      `${label} 返回异常状态码 ${response.status}。`,
      502,
      responseErrorDetails(response),
    );
  }

  let text;

  try {
    text = await response.text();
  } catch (error) {
    throw new AppError(
      ErrorCode.UPSTREAM_BLOCKED,
      `${label} 页面响应读取失败（${getFetchFailureDetail(error)}）。`,
      502,
    );
  }

  return {
    headers: response.headers,
    response,
    text,
  };
}

function responseErrorDetails(response) {
  return {
    status: response.status,
    final_url: response.url || "",
    location: response.headers.get("location") || "",
  };
}

let cachedProxyAgent = null;
let cachedProxyUrl = "";

function getProxyDispatcher() {
  const proxyUrl = getProxyUrl();

  if (!proxyUrl) {
    return undefined;
  }

  if (cachedProxyAgent && cachedProxyUrl === proxyUrl) {
    return cachedProxyAgent;
  }

  cachedProxyUrl = proxyUrl;
  cachedProxyAgent = new ProxyAgent(proxyUrl);

  return cachedProxyAgent;
}

export function getProxyUrl() {
  const configuredProxyUrl = getConfiguredProxyUrl();

  if (configuredProxyUrl != null) {
    return configuredProxyUrl;
  }

  return getSystemProxyUrl();
}

export function isSocksProxyUrl(proxyUrl) {
  return /^socks(?:5)?:\/\//i.test(String(proxyUrl || "").trim());
}

function getConfiguredProxyUrl() {
  for (const name of [
    "SOCIAL_PROXY_URL",
    "IG_PROXY_URL",
    "HTTPS_PROXY",
    "https_proxy",
    "HTTP_PROXY",
    "http_proxy",
    "ALL_PROXY",
    "all_proxy",
  ]) {
    const value = process.env[name]?.trim();

    if (!value) {
      continue;
    }

    return isProxyDisabledValue(value) ? "" : normalizeProxyUrl(value, "http");
  }

  return null;
}

function getSystemProxyUrl() {
  if (!shouldUseSystemProxy()) {
    cachedSystemProxyCheckedAt = 0;
    cachedSystemProxyUrl = "";
    return "";
  }

  const now = Date.now();

  if (now - cachedSystemProxyCheckedAt < SYSTEM_PROXY_CACHE_MS) {
    return cachedSystemProxyUrl;
  }

  cachedSystemProxyCheckedAt = now;
  cachedSystemProxyUrl = detectSystemProxyUrl();

  return cachedSystemProxyUrl;
}

function shouldUseSystemProxy() {
  const value =
    process.env.SOCIAL_AUTO_SYSTEM_PROXY?.trim() ||
    process.env.IG_AUTO_SYSTEM_PROXY?.trim();

  return value ? !isProxyDisabledValue(value) : true;
}

function detectSystemProxyUrl() {
  if (process.platform === "darwin") {
    return detectMacosProxyUrl();
  }

  if (process.platform === "win32") {
    return detectWindowsProxyUrl();
  }

  if (process.platform === "linux") {
    return detectLinuxProxyUrl();
  }

  return "";
}

function detectMacosProxyUrl() {
  const output = runProxyCommand("scutil", ["--proxy"]);

  if (!output) {
    return "";
  }

  const settings = keyValueLines(output);

  return (
    proxyUrlFromSystemSettings(settings, "HTTPS", "http") ||
    proxyUrlFromSystemSettings(settings, "HTTP", "http") ||
    proxyUrlFromSystemSettings(settings, "SOCKS", "socks5")
  );
}

function proxyUrlFromSystemSettings(settings, prefix, protocol) {
  if (!isSystemProxyEnabled(settings[`${prefix}Enable`])) {
    return "";
  }

  return proxyUrlFromHostPort(settings[`${prefix}Proxy`], settings[`${prefix}Port`], protocol);
}

function detectWindowsProxyUrl() {
  const registryKey = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings";
  const enabledOutput = runProxyCommand("reg", ["query", registryKey, "/v", "ProxyEnable"]);
  const proxyEnabled = /ProxyEnable\s+REG_DWORD\s+0x1\b/i.test(enabledOutput);

  if (!proxyEnabled) {
    return "";
  }

  const serverOutput = runProxyCommand("reg", ["query", registryKey, "/v", "ProxyServer"]);
  const proxyServer = windowsRegistryValue(serverOutput, "ProxyServer");

  return proxyUrlFromWindowsProxyServer(proxyServer);
}

function proxyUrlFromWindowsProxyServer(proxyServer) {
  const value = proxyServer.trim();

  if (!value) {
    return "";
  }

  if (!value.includes("=")) {
    return normalizeProxyUrl(value, "http");
  }

  const proxies = {};

  for (const entry of value.split(";")) {
    const [rawKey, ...rawValue] = entry.split("=");
    const key = rawKey?.trim().toLowerCase();
    const proxy = rawValue.join("=").trim();

    if (key && proxy) {
      proxies[key] = proxy;
    }
  }

  return (
    normalizeProxyUrl(proxies.https, "http") ||
    normalizeProxyUrl(proxies.http, "http") ||
    normalizeProxyUrl(proxies.socks, "socks5")
  );
}

function detectLinuxProxyUrl() {
  const mode = unquoteGsettings(runProxyCommand("gsettings", ["get", "org.gnome.system.proxy", "mode"]));

  if (mode !== "manual") {
    return "";
  }

  return (
    linuxGsettingsProxyUrl("https", "http") ||
    linuxGsettingsProxyUrl("http", "http") ||
    linuxGsettingsProxyUrl("socks", "socks5")
  );
}

function linuxGsettingsProxyUrl(schemaSuffix, protocol) {
  const schema = `org.gnome.system.proxy.${schemaSuffix}`;
  const host = unquoteGsettings(runProxyCommand("gsettings", ["get", schema, "host"]));
  const port = unquoteGsettings(runProxyCommand("gsettings", ["get", schema, "port"]));

  return proxyUrlFromHostPort(host, port, protocol);
}

function runProxyCommand(command, args) {
  try {
    return execFileSync(command, args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 1000,
    });
  } catch {
    return "";
  }
}

function keyValueLines(output) {
  const values = {};

  for (const line of output.split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z0-9]+)\s*:\s*(.*?)\s*$/);

    if (match) {
      values[match[1]] = match[2];
    }
  }

  return values;
}

function windowsRegistryValue(output, name) {
  const escapedName = escapeRegExp(name);
  const pattern = new RegExp(`\\b${escapedName}\\b\\s+REG_\\w+\\s+(.+)`, "i");

  for (const line of output.split(/\r?\n/)) {
    const match = pattern.exec(line);

    if (match) {
      return match[1].trim();
    }
  }

  return "";
}

function proxyUrlFromHostPort(host, port, protocol) {
  const hostname = String(host || "").trim();
  const portNumber = Number.parseInt(String(port || "").trim(), 10);

  if (!hostname || !Number.isFinite(portNumber) || portNumber <= 0) {
    return "";
  }

  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(hostname)) {
    return normalizeProxyUrl(hostname, protocol);
  }

  const formattedHost = hostname.includes(":") && !hostname.startsWith("[")
    ? `[${hostname}]`
    : hostname;

  return `${protocol}://${formattedHost}:${portNumber}`;
}

function normalizeProxyUrl(value, fallbackProtocol) {
  const proxyUrl = String(value || "").trim().replace(/^["']|["']$/g, "");

  if (!proxyUrl || isProxyDisabledValue(proxyUrl)) {
    return "";
  }

  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(proxyUrl)) {
    return proxyUrl;
  }

  return `${fallbackProtocol}://${proxyUrl}`;
}

function isSystemProxyEnabled(value) {
  return String(value || "").trim() === "1";
}

function isProxyDisabledValue(value) {
  return PROXY_DISABLE_VALUES.has(String(value || "").trim().toLowerCase());
}

function unquoteGsettings(value) {
  const trimmed = String(value || "").trim();

  if ((trimmed.startsWith("'") && trimmed.endsWith("'")) || (trimmed.startsWith("\"") && trimmed.endsWith("\""))) {
    return trimmed.slice(1, -1);
  }

  return trimmed;
}

function getFetchFailureDetail(error) {
  const cause = error?.cause;
  const code = cause && typeof cause === "object" && "code" in cause ? String(cause.code) : "";

  if (code === "ENOTFOUND") {
    return "DNS 解析失败";
  }

  if (code === "ETIMEDOUT") {
    return "连接超时";
  }

  if (code === "ECONNREFUSED") {
    return "连接被拒绝";
  }

  if (code === "ECONNRESET") {
    return "连接被重置";
  }

  return error instanceof Error ? error.message : "网络连接失败";
}

export function jsonFromScriptId(text, scriptId) {
  const pattern = new RegExp(
    `<script[^>]*id=["']${escapeRegExp(scriptId)}["'][^>]*>([\\s\\S]*?)<\\/script>`,
    "i",
  );
  const match = pattern.exec(text);

  if (!match) {
    return null;
  }

  try {
    return JSON.parse(htmlUnescape(match[1].trim()));
  } catch {
    return null;
  }
}

export function jsonBetween(text, prefix, suffix) {
  if (!text.includes(prefix)) {
    return null;
  }

  const chunk = text.split(prefix, 2)[1].split(suffix, 1)[0];

  try {
    return JSON.parse(chunk);
  } catch {
    return null;
  }
}

export function metaContents(text, names) {
  const wanted = new Set(names);
  const values = [];
  const tagPattern = /<meta\b[^>]*>/gi;
  let match;

  while ((match = tagPattern.exec(text))) {
    const tag = match[0];
    const key = getAttribute(tag, "property") || getAttribute(tag, "name");
    const content = getAttribute(tag, "content");

    if (key && content && wanted.has(key)) {
      values.push(htmlUnescape(content));
    }
  }

  return values;
}

export function getAttribute(tag, name) {
  const pattern = new RegExp(
    `${escapeRegExp(name)}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`,
    "i",
  );
  const match = pattern.exec(tag);

  return match ? htmlUnescape(match[1] ?? match[2] ?? match[3] ?? "") : "";
}

export function scriptTexts(text, options = {}) {
  const { type } = options;
  const scripts = [];
  const pattern = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
  let match;

  while ((match = pattern.exec(text))) {
    if (type && getAttribute(match[1], "type") !== type) {
      continue;
    }

    scripts.push(match[2].trim());
  }

  return scripts;
}

export function extractEmbeddedJsonObjects(text, markers) {
  if (!markers.some((marker) => text.includes(marker))) {
    return [];
  }

  const values = [];

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];

    if (char !== "{" && char !== "[") {
      continue;
    }

    const chunk = extractBalancedJson(text, index);

    if (!chunk) {
      continue;
    }

    try {
      values.push(JSON.parse(chunk));
      index += chunk.length - 1;
    } catch {
      // Keep scanning. Public pages often contain JS object-ish blobs.
    }
  }

  return values;
}

export function randomAlpha(length) {
  const alphabet = "abcdefghijklmnopqrstuvwxyz";
  const bytes = crypto.randomBytes(length * 2);
  let value = "";

  for (const byte of bytes) {
    value += alphabet[byte % alphabet.length];

    if (value.length >= length) {
      return value;
    }
  }

  return value.padEnd(length, "a");
}

export function randomToken(length) {
  return crypto.randomBytes(Math.ceil(length * 0.75)).toString("base64url").slice(0, length);
}

export function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function extractBalancedJson(text, start) {
  const open = text[start];
  const close = open === "{" ? "}" : "]";
  const stack = [close];
  let inString = false;
  let escaped = false;

  for (let index = start + 1; index < text.length; index += 1) {
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

    if (char === "{" || char === "[") {
      stack.push(char === "{" ? "}" : "]");
      continue;
    }

    if (char === stack[stack.length - 1]) {
      stack.pop();

      if (stack.length === 0) {
        return text.slice(start, index + 1);
      }
    }
  }

  return "";
}
