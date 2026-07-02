import fs from "node:fs/promises";

import { NextResponse } from "next/server";

import { AppError, ErrorCode, errorPayload, getErrorDetail, toAppError } from "@/lib/social-downloader/errors";
import { getProfileZipFile } from "@/lib/social-downloader/service";

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

  const selectedPostIds = parsePostIds(body?.post_ids);

  try {
    const { filePath, filename } = await getProfileZipFile(requestId, {
      postIds: selectedPostIds,
    });
    const buffer = await fs.readFile(filePath);

    return new Response(buffer, {
      headers: {
        "content-type": "application/zip",
        "content-length": String(buffer.length),
        "content-disposition": `attachment; filename="${fallbackFilename(filename)}"; filename*=UTF-8''${encodeURIComponent(filename)}`,
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

function parsePostIds(value) {
  if (!Array.isArray(value)) {
    return [];
  }

  return [...new Set(value.map((item) => String(item || "").trim()).filter(Boolean))];
}
