import { NextResponse } from "next/server";

import { writeUserActionLog } from "@/lib/user-action-logger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request) {
  let body;

  try {
    body = await request.json();
  } catch (error) {
    await writeUserActionLog(
      {
        action: "client_log_invalid_json",
        level: "error",
        source: "client",
        status: "error",
        details: {
          error_message: error instanceof Error ? error.message : "Invalid JSON",
        },
      },
      request,
    );

    return NextResponse.json({ ok: false }, { status: 400 });
  }

  await writeUserActionLog(
    {
      action: typeof body?.action === "string" ? body.action : "client_action",
      level: body?.level === "error" ? "error" : "info",
      source: "client",
      status: body?.status === "error" ? "error" : "ok",
      details: body?.details ?? {},
    },
    request,
  );

  return NextResponse.json({ ok: true }, { status: 200 });
}
