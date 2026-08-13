import fs from "node:fs/promises";

import { NextResponse } from "next/server";

import { AppError, ErrorCode, errorPayload, toAppError } from "@/lib/social-downloader/errors";
import { getProfileDownloadJobFile } from "@/lib/social-downloader/profile-download-jobs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_request, { params }) {
  const { request_id: requestId, job_id: jobId } = await params;
  const file = getProfileDownloadJobFile(jobId, requestId);

  if (!file) {
    return NextResponse.json(
      errorPayload(new AppError(ErrorCode.NO_MEDIA_FOUND, "下载文件不存在或任务尚未完成。", 404)),
      { status: 404 },
    );
  }

  try {
    const buffer = await fs.readFile(file.filePath);

    return new Response(buffer, {
      headers: {
        "content-type": "application/zip",
        "content-length": String(buffer.length),
        "content-disposition": `attachment; filename="${fallbackFilename(file.filename)}"; filename*=UTF-8''${encodeURIComponent(file.filename)}`,
        "cache-control": "no-store",
      },
      status: 200,
    });
  } catch (error) {
    const appError = toAppError(error);

    return NextResponse.json(errorPayload(appError), { status: appError.status });
  }
}

function fallbackFilename(filename) {
  return String(filename || "instagram-profile.zip")
    .replace(/[^\x20-\x7E]+/g, "_")
    .replace(/"/g, "");
}
