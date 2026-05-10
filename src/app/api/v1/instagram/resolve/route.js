import { NextResponse } from "next/server";

import { AppError, ErrorCode, errorPayload, getErrorDetail, toAppError } from "@/lib/social-downloader/errors";
import { resolveUrl } from "@/lib/social-downloader/service";
import { writeUserActionLog } from "@/lib/user-action-logger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request) {
  let body;

  try {
    body = await request.json();
  } catch (error) {
    await writeUserActionLog(
      {
        action: "resolve_invalid_json",
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

  if (!url || url.length > 2048) {
    await writeUserActionLog(
      {
        action: "resolve_rejected",
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
    await writeUserActionLog(
      {
        action: "resolve_requested",
        status: "started",
        details: {
          url,
        },
      },
      request,
    );

    const payload = await resolveUrl(url);

    await writeUserActionLog(
      {
        action: "resolve_succeeded",
        status: "ok",
        details: {
          url,
          request_id: payload.request_id,
          platform: payload.platform,
          shortcode: payload.shortcode,
          asset_count: payload.assets?.length ?? 0,
        },
      },
      request,
    );

    return NextResponse.json(payload, { status: 200 });
  } catch (error) {
    const appError = toAppError(error);

    await writeUserActionLog(
      {
        action: "resolve_failed",
        level: "error",
        status: "error",
        details: {
          url,
          error_code: appError.code,
          error_message: appError.message,
          error_status: appError.status,
          error_details: appError.details,
        },
      },
      request,
    );

    return NextResponse.json(errorPayload(appError), { status: appError.status });
  }
}
