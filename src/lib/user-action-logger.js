import fs from "node:fs/promises";
import path from "node:path";

export const ERROR_LOG_IDENTIFIER = "LINKMIGO_ERROR_EVENT";
export const USER_ACTION_IDENTIFIER = "LINKMIGO_USER_ACTION";

const LOG_ROOT = path.join(process.cwd(), "logs");
const MAX_STRING_LENGTH = 1200;

export async function writeUserActionLog(event, request) {
  try {
    const now = new Date();
    const level = event?.level === "error" ? "error" : "info";
    const entry = {
      timestamp: formatChinaTimestamp(now),
      marker: level === "error" ? ERROR_LOG_IDENTIFIER : USER_ACTION_IDENTIFIER,
      level,
      action: cleanString(event?.action || "unknown_action"),
      source: cleanString(event?.source || "server"),
      status: cleanString(event?.status || (level === "error" ? "error" : "ok")),
      details: sanitize(event?.details ?? {}),
      request: request ? requestContext(request) : undefined,
    };

    await fs.mkdir(LOG_ROOT, { recursive: true });
    await fs.appendFile(logPath(now), `${JSON.stringify(entry)}\n`, "utf8");
  } catch {
    // Logging must never block the user flow.
  }
}

function logPath(date) {
  return path.join(LOG_ROOT, `user-actions-${chinaDateKey(date)}.log`);
}

function requestContext(request) {
  const ipContext = request ? requestIpContext(request) : {};

  return sanitize({
    method: request.method,
    url: request.url,
    user_agent: request.headers.get("user-agent"),
    ip: ipContext.ip,
    public_ip: ipContext.publicIp,
    private_ip: ipContext.privateIp,
    remote_ip: ipContext.remoteIp,
    forwarded_for: ipContext.forwardedFor,
    referer: request.headers.get("referer"),
  });
}

function requestIpContext(request) {
  const forwardedFor = request.headers.get("x-forwarded-for")?.trim() || "";
  const remoteIp = normalizeIp(request.ip || request.socket?.remoteAddress);
  const candidates = [
    ...splitForwardedAddresses(forwardedFor),
    ...parseForwardedHeader(request.headers.get("forwarded")),
    firstHeaderValue(request.headers.get("cf-connecting-ip")),
    firstHeaderValue(request.headers.get("true-client-ip")),
    firstHeaderValue(request.headers.get("x-real-ip")),
    remoteIp,
  ].map(normalizeIp).filter(Boolean);
  const uniqueCandidates = [...new Set(candidates)];
  const privateIp = uniqueCandidates.find(isPrivateIp) || null;
  const publicIp = uniqueCandidates.find((value) => !isPrivateIp(value) && !isLoopbackIp(value)) || null;

  return {
    ip: uniqueCandidates[0] || null,
    publicIp,
    privateIp,
    remoteIp: remoteIp || null,
    forwardedFor: forwardedFor || null,
  };
}

function firstHeaderValue(value) {
  return typeof value === "string" ? value.split(",")[0].trim() : "";
}

function splitForwardedAddresses(value) {
  return typeof value === "string"
    ? value.split(",").map((item) => item.trim()).filter(Boolean)
    : [];
}

function parseForwardedHeader(value) {
  if (typeof value !== "string") {
    return [];
  }

  return value
    .split(",")
    .flatMap((entry) => entry.match(/(?:^|;)\s*for=(?:"([^"]+)"|([^;]+))/i)?.slice(1) || [])
    .map((item) => item?.trim())
    .filter(Boolean);
}

function normalizeIp(value) {
  const normalized = String(value || "").trim().replace(/^"|"$/g, "");

  if (!normalized || normalized === "unknown" || normalized.startsWith("_")) {
    return "";
  }

  if (normalized.startsWith("[")) {
    return normalized.slice(1, normalized.indexOf("]"));
  }

  return /^\d{1,3}(?:\.\d{1,3}){3}:\d+$/.test(normalized)
    ? normalized.slice(0, normalized.lastIndexOf(":"))
    : normalized;
}

function isPrivateIp(value) {
  const normalized = String(value).replace(/^\[|\]$/g, "").toLowerCase();

  return normalized === "localhost"
    || normalized === "::1"
    || normalized === "0:0:0:0:0:0:0:1"
    || /^127\./.test(normalized)
    || /^10\./.test(normalized)
    || /^192\.168\./.test(normalized)
    || /^172\.(1[6-9]|2\d|3[0-1])\./.test(normalized)
    || /^::ffff:(?:10\.|127\.|169\.254\.|192\.168\.|172\.(?:1[6-9]|2\d|3[0-1])\.)/.test(normalized)
    || /^169\.254\./.test(normalized)
    || /^fc[0-9a-f]{2}:/.test(normalized)
    || /^fd[0-9a-f]{2}:/.test(normalized)
    || /^fe80:/.test(normalized);
}

function isLoopbackIp(value) {
  const normalized = String(value).replace(/^\[|\]$/g, "").toLowerCase();
  return normalized === "::1" || normalized === "0:0:0:0:0:0:0:1" || /^127\./.test(normalized);
}

function formatChinaTimestamp(date) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date).reduce((result, part) => {
    result[part.type] = part.value;
    return result;
  }, {});
  const milliseconds = String(date.getUTCMilliseconds()).padStart(3, "0");

  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}.${milliseconds}+08:00`;
}

function chinaDateKey(date) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

function sanitize(value) {
  if (value == null) {
    return value;
  }

  if (value instanceof Error) {
    return {
      name: value.name,
      message: cleanString(value.message),
      stack: cleanString(value.stack),
    };
  }

  if (Array.isArray(value)) {
    return value.slice(0, 50).map((item) => sanitize(item));
  }

  if (typeof value === "object") {
    const output = {};

    for (const [key, item] of Object.entries(value).slice(0, 80)) {
      output[cleanString(key)] = sanitize(item);
    }

    return output;
  }

  if (typeof value === "string") {
    return cleanString(value);
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return value;
  }

  return cleanString(String(value));
}

function cleanString(value) {
  const text = String(value);

  return text.length > MAX_STRING_LENGTH ? `${text.slice(0, MAX_STRING_LENGTH)}...` : text;
}
