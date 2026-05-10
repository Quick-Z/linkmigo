import fs from "node:fs/promises";

import { NextResponse } from "next/server";

import { errorPayload, toAppError } from "@/lib/social-downloader/errors";
import { getAssetFile } from "@/lib/social-downloader/service";
import { writeUserActionLog } from "@/lib/user-action-logger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request, { params }) {
  const { request_id: requestId, asset_id: assetId } = await params;

  try {
    const { asset, filePath } = await getAssetFile({ requestId, assetId });
    const buffer = await fs.readFile(filePath);

    await writeUserActionLog(
      {
        action: "asset_download_served",
        status: "ok",
        details: {
          request_id: requestId,
          asset_id: assetId,
          filename: asset.filename,
          media_type: asset.media_type,
          content_type: asset.content_type,
          size_bytes: buffer.length,
        },
      },
      request,
    );

    return new Response(buffer, {
      headers: {
        "content-type": asset.content_type,
        "content-length": String(buffer.length),
        "content-disposition": `attachment; filename="${fallbackFilename(asset.filename)}"; filename*=UTF-8''${encodeURIComponent(asset.filename)}`,
        "cache-control": "no-store",
      },
    });
  } catch (error) {
    const appError = toAppError(error);

    await writeUserActionLog(
      {
        action: "asset_download_failed",
        level: "error",
        status: "error",
        details: {
          request_id: requestId,
          asset_id: assetId,
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

function fallbackFilename(filename) {
  return filename.replace(/[^\x20-\x7E]+/g, "_").replace(/"/g, "");
}
