import { NextResponse } from "next/server";

import { AppError, ErrorCode, errorPayload, getErrorDetail, toAppError } from "@/lib/social-downloader/errors";
import { getSocialDownloaderSettings } from "@/lib/social-downloader/settings";
import { fetchWithTimeout } from "@/lib/social-downloader/utils";

const IMAGE_MAX_BYTES = 12 * 1024 * 1024;
const INSTAGRAM_IMAGE_HEADERS = {
  accept: "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
  "accept-language": "en-US,en;q=0.9",
  referer: "https://www.instagram.com/",
  "sec-fetch-dest": "image",
  "sec-fetch-mode": "no-cors",
  "sec-fetch-site": "cross-site",
  "user-agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
};

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request) {
  try {
    const rawUrl = new URL(request.url).searchParams.get("url") || "";
    const sourceUrl = normalizeInstagramImageUrl(rawUrl);
    const response = await fetchWithTimeout(
      sourceUrl,
      {
        cache: "no-store",
        headers: INSTAGRAM_IMAGE_HEADERS,
      },
      getSocialDownloaderSettings().httpTimeoutMs,
    );

    if (response.status === 404) {
      throw new AppError(ErrorCode.NO_MEDIA_FOUND, "图片不存在。", 404);
    }

    if (response.status >= 400) {
      throw new AppError(ErrorCode.UPSTREAM_BLOCKED, `图片请求失败（${response.status}）。`, 502);
    }

    const contentType = response.headers.get("content-type") || "image/jpeg";
    const contentLength = Number.parseInt(response.headers.get("content-length") || "", 10);

    if (!contentType.toLowerCase().startsWith("image/")) {
      throw new AppError(ErrorCode.NO_MEDIA_FOUND, "目标地址没有返回图片。", 404);
    }

    if (Number.isFinite(contentLength) && contentLength > IMAGE_MAX_BYTES) {
      throw new AppError(ErrorCode.NO_MEDIA_FOUND, "图片过大。", 413);
    }

    return new Response(response.body, {
      headers: {
        "cache-control": "public, max-age=1800",
        "content-type": contentType,
        "x-content-type-options": "nosniff",
        ...(Number.isFinite(contentLength) ? { "content-length": String(contentLength) } : {}),
      },
      status: 200,
    });
  } catch (error) {
    const appError = toAppError(error);

    return NextResponse.json(errorPayload(appError), { status: appError.status });
  }
}

function normalizeInstagramImageUrl(value) {
  const rawUrl = String(value || "").trim();

  if (!rawUrl || rawUrl.length > 8192) {
    throw new AppError(ErrorCode.UNSUPPORTED_URL, "图片地址无效。", 400);
  }

  let parsed;

  try {
    parsed = new URL(rawUrl);
  } catch (error) {
    throw new AppError(ErrorCode.UNSUPPORTED_URL, "图片地址格式无效。", 400, getErrorDetail(error));
  }

  if (!["http:", "https:"].includes(parsed.protocol) || !isAllowedInstagramImageHost(parsed.hostname)) {
    throw new AppError(ErrorCode.UNSUPPORTED_URL, "仅支持代理 Instagram 图片。", 400);
  }

  return parsed.toString();
}

function isAllowedInstagramImageHost(hostname) {
  const host = String(hostname || "").toLowerCase();

  return (
    host === "instagram.com" ||
    host.endsWith(".instagram.com") ||
    host === "cdninstagram.com" ||
    host.endsWith(".cdninstagram.com") ||
    host === "fbcdn.net" ||
    host.endsWith(".fbcdn.net") ||
    host === "fbsbx.com" ||
    host.endsWith(".fbsbx.com")
  );
}
