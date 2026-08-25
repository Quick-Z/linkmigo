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
    setSessionCookie(response, sessionId);
    return response;
  } catch (error) {
    const response = NextResponse.json({
      status: "error",
      qr_data_url: null,
      error: getErrorDetail(error) || "小红书二维码生成失败。",
    }, { status: 503 });
    if (sessionId) setSessionCookie(response, sessionId);
    return response;
  }
}

function setSessionCookie(response, sessionId) {
  response.cookies.set("linkmigo_xhs_session", sessionId, {
    httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production",
    maxAge: 60 * 60 * 24 * 30, path: "/",
  });
}
