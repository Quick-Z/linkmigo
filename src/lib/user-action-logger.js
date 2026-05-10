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
      timestamp: now.toISOString(),
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
  return path.join(LOG_ROOT, `user-actions-${date.toISOString().slice(0, 10)}.log`);
}

function requestContext(request) {
  return sanitize({
    method: request.method,
    url: request.url,
    user_agent: request.headers.get("user-agent"),
    ip: request.headers.get("x-forwarded-for") || request.headers.get("x-real-ip"),
    referer: request.headers.get("referer"),
  });
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
