import { NextResponse } from "next/server";

import { getXiaohongshuSessionId, logoutXiaohongshuSession } from "@/lib/social-downloader/xiaohongshu-sessions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request) {
  await logoutXiaohongshuSession(getXiaohongshuSessionId(request));
  const response = NextResponse.json({ status: "anonymous" });
  response.cookies.delete("linkmigo_xhs_session");
  return response;
}
