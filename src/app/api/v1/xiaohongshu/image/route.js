import { NextResponse } from "next/server";

import { AppError, ErrorCode, errorPayload, getErrorDetail, toAppError } from "@/lib/social-downloader/errors";
import { getSocialDownloaderSettings } from "@/lib/social-downloader/settings";
import { fetchWithTimeout } from "@/lib/social-downloader/utils";

const MAX_BYTES = 12 * 1024 * 1024;

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request) {
  try {
    const rawUrl = new URL(request.url).searchParams.get("url") || "";
    const sourceUrl = normalizeImageUrl(rawUrl);
    const response = await fetchWithTimeout(sourceUrl, {
      cache: "no-store",
      headers: {
        accept: "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
        referer: "https://www.xiaohongshu.com/",
        "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/124 Safari/537.36",
      },
    }, getSocialDownloaderSettings().httpTimeoutMs);

    if (response.status >= 400) {
      throw new AppError(ErrorCode.UPSTREAM_BLOCKED, `小红书图片请求失败（${response.status}）。`, 502);
    }
    const contentType = response.headers.get("content-type") || "image/jpeg";
    const contentLength = Number.parseInt(response.headers.get("content-length") || "", 10);
    if (!contentType.toLowerCase().startsWith("image/")) {
      throw new AppError(ErrorCode.NO_MEDIA_FOUND, "小红书地址没有返回图片。", 404);
    }
    if (Number.isFinite(contentLength) && contentLength > MAX_BYTES) {
      throw new AppError(ErrorCode.NO_MEDIA_FOUND, "小红书图片过大。", 413);
    }

    return new Response(response.body, {
      status: 200,
      headers: {
        "cache-control": "public, max-age=1800",
        "content-type": contentType,
        "x-content-type-options": "nosniff",
        ...(Number.isFinite(contentLength) ? { "content-length": String(contentLength) } : {}),
      },
    });
  } catch (error) {
    const appError = toAppError(error);
    return NextResponse.json(errorPayload(appError), { status: appError.status });
  }
}

function normalizeImageUrl(value) {
  const raw = String(value || "").trim();
  if (!raw || raw.length > 8192) throw new AppError(ErrorCode.UNSUPPORTED_URL, "小红书图片地址无效。", 400);
  let parsed;
  try { parsed = new URL(raw); } catch (error) {
    throw new AppError(ErrorCode.UNSUPPORTED_URL, "小红书图片地址格式无效。", 400, getErrorDetail(error));
  }
  if (!/^https?:$/.test(parsed.protocol) || !isAllowedHost(parsed.hostname)) {
    throw new AppError(ErrorCode.UNSUPPORTED_URL, "仅支持小红书图片地址。", 400);
  }
  return parsed.toString();
}

function isAllowedHost(hostname) {
  const host = String(hostname || "").toLowerCase();
  return host === "xiaohongshu.com" || host.endsWith(".xiaohongshu.com") || host === "xhscdn.com" || host.endsWith(".xhscdn.com");
}
