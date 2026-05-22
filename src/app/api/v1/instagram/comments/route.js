import { NextResponse } from "next/server";

import { AppError, ErrorCode, errorPayload, getErrorDetail, toAppError } from "@/lib/social-downloader/errors";
import { getSocialDownloaderSettings } from "@/lib/social-downloader/settings";
import { normalizeSocialUrl } from "@/lib/social-downloader/social";
import { resolveXiaoyuzhouComments } from "@/lib/social-downloader/xiaoyuzhou";

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

    if (normalized.platform !== "xiaoyuzhou") {
      throw new AppError(ErrorCode.UNSUPPORTED_URL, "目前仅支持读取小宇宙单集评论。", 400);
    }

    const payload = await resolveXiaoyuzhouComments(
      normalized,
      {
        cursor: body?.cursor,
        limit: body?.limit,
      },
      getSocialDownloaderSettings(),
    );

    return NextResponse.json(payload, { status: 200 });
  } catch (error) {
    const appError = toAppError(error);

    return NextResponse.json(errorPayload(appError), { status: appError.status });
  }
}
