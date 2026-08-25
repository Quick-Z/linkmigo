import { NextResponse } from "next/server";

import { AppError, ErrorCode, errorPayload, getErrorDetail, toAppError } from "@/lib/social-downloader/errors";
import { resolveSocialComments } from "@/lib/social-downloader/comments";
import { getSocialDownloaderSettings } from "@/lib/social-downloader/settings";
import { normalizeSocialUrl } from "@/lib/social-downloader/social";
import {
  ensureXiaohongshuSession,
  xiaohongshuSessionCookie,
} from "@/lib/social-downloader/xiaohongshu-sessions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request) {
  let body;

  try {
    body = await request.json();
  } catch (error) {
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

  if (!url || url.length > 2048) {
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
    const normalized = normalizeSocialUrl(url);
    const baseSettings = getSocialDownloaderSettings();
    const sessionId = normalized.platform === "xiaohongshu"
      ? ensureXiaohongshuSession(request)
      : "";
    const sessionCookie = sessionId ? xiaohongshuSessionCookie(sessionId) : "";
    const settings = normalized.platform === "xiaohongshu" && sessionCookie
      ? { ...baseSettings, xiaohongshuCookie: sessionCookie }
      : baseSettings;
    const options = {
      cursor: body?.cursor,
      limit: body?.limit,
    };
    const payload = await resolveSocialComments(normalized, options, settings);

    const response = NextResponse.json(payload, { status: 200 });
    if (sessionId) {
      setSessionCookie(response, sessionId, request);
    }
    return response;
  } catch (error) {
    const appError = toAppError(error);

    return NextResponse.json(errorPayload(appError), { status: appError.status });
  }
}

function setSessionCookie(response, sessionId, request) {
  response.cookies.set("linkmigo_xhs_session", sessionId, {
    httpOnly: true,
    sameSite: "lax",
    secure: isHttpsRequest(request),
    maxAge: 60 * 60 * 24 * 30,
    path: "/",
  });
}

function isHttpsRequest(request) {
  const forwarded = request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim();
  return forwarded === "https" || new URL(request.url).protocol === "https:";
}
