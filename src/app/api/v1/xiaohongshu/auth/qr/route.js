import { NextResponse } from "next/server";

import {
  ensureXiaohongshuSession,
  startXiaohongshuQrLogin,
} from "@/lib/social-downloader/xiaohongshu-sessions";
import { getErrorDetail } from "@/lib/social-downloader/errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request) {
  let sessionId = "";
  try {
    sessionId = ensureXiaohongshuSession(request);
    const payload = await startXiaohongshuQrLogin(sessionId);
    const response = NextResponse.json(payload, { status: payload.status === "error" ? 503 : 200 });
    setSessionCookie(response, sessionId, request);
    return response;
  } catch (error) {
    console.error("xiaohongshu QR login failed", error);
    const response = NextResponse.json({
      status: "error",
      qr_data_url: null,
      error: getErrorDetail(error) || "小红书二维码生成失败。",
    }, { status: 503 });
    if (sessionId) setSessionCookie(response, sessionId, request);
    return response;
  }
}

function setSessionCookie(response, sessionId, request) {
  response.cookies.set("linkmigo_xhs_session", sessionId, {
    httpOnly: true, sameSite: "lax", secure: isHttpsRequest(request),
    maxAge: 60 * 60 * 24 * 30, path: "/",
  });
}

function isHttpsRequest(request) {
  const forwarded = request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim();
  return forwarded === "https" || new URL(request.url).protocol === "https:";
}
