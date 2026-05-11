import { NextResponse } from "next/server";

import { AppError, ErrorCode, errorPayload } from "@/lib/social-downloader/errors";
import { getResolveJob } from "@/lib/social-downloader/jobs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_request, { params }) {
  const { job_id: jobId } = await params;
  const job = getResolveJob(jobId);

  if (!job) {
    return NextResponse.json(
      errorPayload(
        new AppError(
          ErrorCode.CACHE_EXPIRED,
          "解析任务不存在或已过期，请重新搜索。",
          404,
        ),
      ),
      { status: 404 },
    );
  }

  return NextResponse.json(job, {
    status: 200,
    headers: {
      "cache-control": "no-store",
    },
  });
}
