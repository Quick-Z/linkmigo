import { NextResponse } from "next/server";

import { AppError, ErrorCode, errorPayload } from "@/lib/social-downloader/errors";
import { getProfileDownloadJob } from "@/lib/social-downloader/profile-download-jobs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_request, { params }) {
  const { request_id: requestId, job_id: jobId } = await params;
  const job = getProfileDownloadJob(jobId);

  if (!job || job.request_id !== requestId) {
    return NextResponse.json(
      errorPayload(new AppError(ErrorCode.NO_MEDIA_FOUND, "下载任务不存在或已过期。", 404)),
      { status: 404 },
    );
  }

  return NextResponse.json(job, {
    headers: {
      "cache-control": "no-store",
    },
  });
}
