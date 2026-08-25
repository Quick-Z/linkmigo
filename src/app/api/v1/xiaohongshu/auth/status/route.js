import { NextResponse } from "next/server";

import {
  ensureXiaohongshuSession,
  xiaohongshuSessionSnapshot,
} from "@/lib/social-downloader/xiaohongshu-sessions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request) {
  const sessionId = ensureXiaohongshuSession(request);
  const response = NextResponse.json(xiaohongshuSessionSnapshot(sessionId));
  response.cookies.set("linkmigo_xhs_session", sessionId, {
    httpOnly: true, sameSite: "lax", secure: isHttpsRequest(request),
    maxAge: 60 * 60 * 24 * 30, path: "/",
  });
  return response;
}

function isHttpsRequest(request) {
  const forwarded = request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim();
  return forwarded === "https" || new URL(request.url).protocol === "https:";
}
