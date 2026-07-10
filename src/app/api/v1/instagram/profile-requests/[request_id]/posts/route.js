import { NextResponse } from "next/server";

import { errorPayload, toAppError } from "@/lib/social-downloader/errors";
import { getProfilePostsPage } from "@/lib/social-downloader/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request, { params }) {
  const { request_id: requestId } = await params;
  const url = new URL(request.url);

  try {
    const page = await getProfilePostsPage(requestId, {
      cursor: url.searchParams.get("cursor"),
      limit: url.searchParams.get("limit"),
    });

    return NextResponse.json(page, { status: 200 });
  } catch (error) {
    const appError = toAppError(error);

    return NextResponse.json(errorPayload(appError), { status: appError.status });
  }
}
