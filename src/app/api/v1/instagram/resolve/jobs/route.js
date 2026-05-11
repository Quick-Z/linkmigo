import { NextResponse } from "next/server";

import { AppError, ErrorCode, errorPayload, getErrorDetail } from "@/lib/social-downloader/errors";
import { startResolveJob } from "@/lib/social-downloader/jobs";
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

  const job = startResolveJob(url);

  await writeUserActionLog(
    {
      action: "resolve_job_started",
      status: "started",
      details: {
        url,
        job_id: job.job_id,
      },
    },
    request,
  );

  return NextResponse.json(job, { status: 202 });
}
