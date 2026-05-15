import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import { Readable } from "node:stream";

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
    const fileStats = await fs.stat(filePath);
    const fileSize = fileStats.size;
    const rangeHeader = request.headers.get("range");
    const range = parseRangeHeader(rangeHeader, fileSize);

    if (range === false) {
      await writeUserActionLog(
        {
          action: "asset_preview_range_rejected",
          level: "error",
          status: "error",
          details: {
            request_id: requestId,
            asset_id: assetId,
            filename: asset.filename,
            media_type: asset.media_type,
            content_type: asset.content_type,
            size_bytes: fileSize,
            range_header: rangeHeader,
          },
        },
        request,
      );

      return new Response(null, {
        headers: {
          "accept-ranges": "bytes",
          "cache-control": "no-store",
          "content-range": `bytes */${fileSize}`,
        },
        status: 416,
      });
    }

    const responseRange = range ?? { start: 0, end: Math.max(0, fileSize - 1) };
    const contentLength = fileSize === 0 ? 0 : responseRange.end - responseRange.start + 1;
    const body = fileSize === 0
      ? null
      : Readable.toWeb(createReadStream(filePath, responseRange));
    const status = range ? 206 : 200;

    await writeUserActionLog(
      {
        action: "asset_preview_served",
        status: "ok",
        details: {
          request_id: requestId,
          asset_id: assetId,
          filename: asset.filename,
          media_type: asset.media_type,
          content_type: asset.content_type,
          size_bytes: fileSize,
          response_bytes: contentLength,
          range_header: rangeHeader,
          status_code: status,
        },
      },
      request,
    );

    return new Response(body, {
      headers: {
        "accept-ranges": "bytes",
        "content-type": asset.content_type,
        "content-length": String(contentLength),
        "content-disposition": `inline; filename="${fallbackFilename(asset.filename)}"; filename*=UTF-8''${encodeURIComponent(asset.filename)}`,
        "cache-control": "no-store",
        ...(range ? { "content-range": `bytes ${responseRange.start}-${responseRange.end}/${fileSize}` } : {}),
      },
      status,
    });
  } catch (error) {
    const appError = toAppError(error);

    await writeUserActionLog(
      {
        action: "asset_preview_failed",
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

function parseRangeHeader(rangeHeader, fileSize) {
  if (!rangeHeader) {
    return null;
  }

  const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim());

  if (!match || fileSize <= 0) {
    return false;
  }

  const [, rawStart, rawEnd] = match;

  if (!rawStart && !rawEnd) {
    return false;
  }

  if (!rawStart) {
    const suffixLength = Number.parseInt(rawEnd, 10);

    if (!Number.isFinite(suffixLength) || suffixLength <= 0) {
      return false;
    }

    return {
      start: Math.max(fileSize - suffixLength, 0),
      end: fileSize - 1,
    };
  }

  const start = Number.parseInt(rawStart, 10);
  const requestedEnd = rawEnd ? Number.parseInt(rawEnd, 10) : fileSize - 1;
  const end = Math.min(requestedEnd, fileSize - 1);

  if (
    !Number.isFinite(start) ||
    !Number.isFinite(requestedEnd) ||
    start < 0 ||
    requestedEnd < start ||
    start >= fileSize
  ) {
    return false;
  }

  return { start, end };
}

function fallbackFilename(filename) {
  return filename.replace(/[^\x20-\x7E]+/g, "_").replace(/"/g, "");
}
