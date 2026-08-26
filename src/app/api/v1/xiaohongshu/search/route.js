import { NextResponse } from "next/server";

import {
  ensureXiaohongshuSession,
  xiaohongshuSessionCookie,
} from "@/lib/social-downloader/xiaohongshu-sessions";
import { searchXiaohongshu } from "@/lib/social-downloader/xiaohongshu";
import { saveXiaohongshuSearchRecord } from "@/lib/social-downloader/service";
import { errorPayload, getErrorDetail, toAppError } from "@/lib/social-downloader/errors";
import { getSocialDownloaderSettings } from "@/lib/social-downloader/settings";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request) {
  let body;

  try {
    body = await request.json();
  } catch (error) {
    return NextResponse.json({
      error: { code: "INVALID_JSON", message: "请求体必须是 JSON", details: getErrorDetail(error) },
    }, { status: 400 });
  }

  const rawKeyword = body?.keyword ?? body?.query ?? body?.text;
  const keyword = typeof rawKeyword === "string" ? rawKeyword.trim() : "";
  const limit = body?.limit;

  try {
    const sessionId = ensureXiaohongshuSession(request);
    const baseSettings = getSocialDownloaderSettings();
    const payload = await searchXiaohongshu(
      keyword,
      { limit },
      {
        ...baseSettings,
        xiaohongshuSessionId: sessionId,
        xiaohongshuCookie: xiaohongshuSessionCookie(sessionId) || baseSettings.xiaohongshuCookie,
      },
    );
    try {
      const record = await saveXiaohongshuSearchRecord({ keyword, posts: payload.posts, sessionId });
      if (record?.request_id) payload.request_id = record.request_id;
    } catch {
      // Search results remain usable even if the optional download index cannot be saved.
    }
    const response = NextResponse.json(payload, { status: 200 });
    setSessionCookie(response, sessionId, request);
    return response;
  } catch (error) {
    const appError = toAppError(error);
    const errorText = [
      appError.message,
      typeof appError.details === "string" ? appError.details : JSON.stringify(appError.details || ""),
    ].join(" ");
    const requiresLogin = appError.code === "LOGIN_REQUIRED" || (
      appError.code === "UPSTREAM_BLOCKED" && /登录|验证|captcha|restricted|blocked|限制|环境异常|访问频繁/i.test(errorText)
    );
    if (requiresLogin) {
      const upstreamDetails = appError.details && typeof appError.details !== "object"
        ? { upstream: appError.details }
        : {};
      appError.details = {
        ...(appError.details && typeof appError.details === "object" ? appError.details : {}),
        ...upstreamDetails,
        requires_login: true,
        login_platforms: ["xiaohongshu"],
      };
    }
    const response = NextResponse.json(errorPayload(appError), { status: appError.status });
    if (sessionId) setSessionCookie(response, sessionId, request);
    return response;
  }
}

function setSessionCookie(response, sessionId, request) {
  response.cookies.set("linkmigo_xhs_session", sessionId, {
    httpOnly: true,
    sameSite: "lax",
    secure: request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim() === "https" || new URL(request.url).protocol === "https:",
    maxAge: 60 * 60 * 24 * 30,
    path: "/",
  });
}
