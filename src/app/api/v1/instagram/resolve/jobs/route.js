import { NextResponse } from "next/server";

import { AppError, ErrorCode, errorPayload, getErrorDetail } from "@/lib/social-downloader/errors";
import { startResolveJob } from "@/lib/social-downloader/jobs";
import { writeUserActionLog } from "@/lib/user-action-logger";
import { ensureXiaohongshuSession } from "@/lib/social-downloader/xiaohongshu-sessions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request) {
  let body;

  try {
    body = await request.json();
  } catch (error) {
    await writeUserActionLog(
      {
        action: "resolve_job_invalid_json",
        level: "error",
        status: "error",
        details: {
          error_code: ErrorCode.INVALID_JSON,
          error_message: getErrorDetail(error),
        },
      },
      request,
    );

    return NextResponse.json(
      {
        error: {
          code: ErrorCode.INVALID_JSON,
          message: "请求体必须是 JSON",
          details: getErrorDetail(error),
        },
      },
      { status: 400 },
    );
  }

  const url = typeof body?.url === "string" ? body.url.trim() : "";
  let callbackUrl = "";

  if (!url || url.length > 2048) {
    await writeUserActionLog(
      {
        action: "resolve_job_rejected",
        level: "error",
        status: "error",
        details: {
          error_code: ErrorCode.UNSUPPORTED_URL,
          url,
          reason: "empty_or_too_long_url",
        },
      },
      request,
    );

    return NextResponse.json(
      errorPayload(
        new AppError(
          ErrorCode.UNSUPPORTED_URL,
          "请输入 1-2048 个字符以内的公开帖子链接。",
          400,
        ),
      ),
      { status: 400 },
    );
  }

  try {
    callbackUrl = normalizeCallbackUrl(body?.callback_url);
  } catch (error) {
    const appError = error instanceof AppError
      ? error
      : new AppError(
        ErrorCode.UNSUPPORTED_URL,
        "callback_url 必须是有效的 HTTP(S) 地址。",
        400,
        getErrorDetail(error),
      );

    await writeUserActionLog(
      {
        action: "resolve_job_callback_rejected",
        level: "error",
        status: "error",
        details: {
          error_code: appError.code,
          error_message: appError.message,
          callback_url: typeof body?.callback_url === "string" ? body.callback_url : null,
        },
      },
      request,
    );

    return NextResponse.json(errorPayload(appError), { status: appError.status });
  }

  const job = startResolveJob(url, {
    callbackUrl,
    publicBaseUrl: resolvePublicBaseUrl(request),
    session_id: ensureXiaohongshuSession(request),
  });

  await writeUserActionLog(
    {
      action: "resolve_job_started",
      status: "started",
      details: {
        url,
        job_id: job.job_id,
        has_callback: Boolean(callbackUrl),
      },
    },
    request,
  );

  return NextResponse.json(job, { status: 202 });
}

function normalizeCallbackUrl(value) {
  if (value == null || value === "") {
    return "";
  }

  if (typeof value !== "string") {
    throw new AppError(ErrorCode.UNSUPPORTED_URL, "callback_url 必须是字符串。", 400);
  }

  const rawUrl = value.trim();

  if (!rawUrl) {
    return "";
  }

  if (rawUrl.length > 2048) {
    throw new AppError(ErrorCode.UNSUPPORTED_URL, "callback_url 不能超过 2048 个字符。", 400);
  }

  let parsed;

  try {
    parsed = new URL(rawUrl);
  } catch (error) {
    throw new AppError(ErrorCode.UNSUPPORTED_URL, "callback_url 格式无效。", 400, getErrorDetail(error));
  }

  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new AppError(ErrorCode.UNSUPPORTED_URL, "callback_url 仅支持 HTTP 或 HTTPS。", 400);
  }

  return parsed.toString();
}

function resolvePublicBaseUrl(request) {
  const configured = normalizePublicBaseUrl(process.env.SOCIAL_PUBLIC_BASE_URL || process.env.LINKMIGO_PUBLIC_BASE_URL);

  if (configured) {
    return configured;
  }

  const requestUrl = new URL(request.url);
  const forwardedHost = firstHeaderValue(request.headers.get("x-forwarded-host"));
  const forwardedProto = firstHeaderValue(request.headers.get("x-forwarded-proto"));
  const host = forwardedHost || request.headers.get("host") || requestUrl.host;
  const protocol = forwardedProto || requestUrl.protocol.replace(/:$/, "");

  return normalizePublicBaseUrl(`${protocol}://${host}`) || requestUrl.origin;
}

function normalizePublicBaseUrl(value) {
  const rawUrl = String(value || "").trim();

  if (!rawUrl) {
    return "";
  }

  try {
    const parsed = new URL(rawUrl);

    if (!["http:", "https:"].includes(parsed.protocol)) {
      return "";
    }

    return parsed.origin;
  } catch {
    return "";
  }
}

function firstHeaderValue(value) {
  return String(value || "")
    .split(",")
    .map((item) => item.trim())
    .find(Boolean);
}
