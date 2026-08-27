import { NextResponse } from "next/server";

import { AppError, ErrorCode, errorPayload, getErrorDetail } from "@/lib/social-downloader/errors";
import { startProfileDownloadJob } from "@/lib/social-downloader/profile-download-jobs";
import { getXiaohongshuSessionId } from "@/lib/social-downloader/xiaohongshu-sessions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request, { params }) {
  const { request_id: requestId } = await params;
  let body = {};

  try {
    body = await request.json();
  } catch (error) {
    return NextResponse.json(
      errorPayload(
        new AppError(
          ErrorCode.INVALID_JSON,
          "请求体必须是 JSON",
          400,
          getErrorDetail(error),
        ),
      ),
      { status: 400 },
    );
  }

  try {
    const job = startProfileDownloadJob(requestId, {
      postIds: parsePostIds(body?.post_ids),
      includeMedia: body?.include_media !== false,
      includePostText: body?.include_post_text === true,
      includeComments: body?.include_comments === true,
      commentLimit: body?.comment_limit,
      sessionId: getXiaohongshuSessionId(request),
    });

    return NextResponse.json(job, { status: 202 });
  } catch (error) {
    const appError = error instanceof AppError ? error : new AppError(ErrorCode.INTERNAL_SERVER_ERROR, "下载任务创建失败。", 500, getErrorDetail(error));

    return NextResponse.json(errorPayload(appError), { status: appError.status });
  }
}

function parsePostIds(value) {
  if (!Array.isArray(value)) {
    return [];
  }

  return [...new Set(value.map((item) => String(item || "").trim()).filter(Boolean))];
}
