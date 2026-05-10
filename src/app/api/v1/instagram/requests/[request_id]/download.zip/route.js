import fs from "node:fs/promises";

import { NextResponse } from "next/server";

import { errorPayload, toAppError } from "@/lib/social-downloader/errors";
import { getZipFile } from "@/lib/social-downloader/service";
import { writeUserActionLog } from "@/lib/user-action-logger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request, { params }) {
  const { request_id: requestId } = await params;
  const selectedAssetIds = parseAssetIds(new URL(request.url).searchParams.get("asset_ids"));

  try {
    const { assets, filePath, filename, record } = await getZipFile(requestId, {
      assetIds: selectedAssetIds,
    });
    const buffer = await fs.readFile(filePath);

    await writeUserActionLog(
      {
        action: "zip_download_served",
        status: "ok",
        details: {
          request_id: requestId,
          platform: record.platform,
          shortcode: record.shortcode,
          filename,
          selected_asset_ids: selectedAssetIds,
          asset_count: assets?.length ?? 0,
          size_bytes: buffer.length,
        },
      },
      request,
    );

    return new Response(buffer, {
      headers: {
        "content-type": "application/zip",
        "content-length": String(buffer.length),
        "content-disposition": `attachment; filename="${fallbackFilename(filename)}"; filename*=UTF-8''${encodeURIComponent(filename)}`,
        "cache-control": "no-store",
      },
    });
  } catch (error) {
    const appError = toAppError(error);

    await writeUserActionLog(
      {
        action: "zip_download_failed",
        level: "error",
        status: "error",
        details: {
          request_id: requestId,
          error_code: appError.code,
          error_message: appError.message,
          error_status: appError.status,
          error_details: appError.details,
          selected_asset_ids: selectedAssetIds,
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

function parseAssetIds(value) {
  if (!value) {
    return [];
  }

  return [...new Set(value.split(",").map((assetId) => assetId.trim()).filter(Boolean))];
}
