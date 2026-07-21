import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

function isAuthorized(request: Request) {
  const authorization = request.headers.get("authorization");
  const cronSecret = process.env.CRON_SECRET;
  const workerSecret = process.env.WORKER_SECRET;

  if (cronSecret && authorization === `Bearer ${cronSecret}`) return true;
  if (workerSecret && request.headers.get("x-worker-secret") === workerSecret) return true;
  return request.headers.get("user-agent") === "vercel-cron/1.0";
}

export async function GET(request: Request) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  try {
    // @ts-expect-error The worker is an ESM module shared with the Docker runtime.
    const { runWorkerOnce } = await import("../../../../../scripts/process-media.mjs");
    const result = await runWorkerOnce();
    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    console.error("[deacon][worker-route] processing failed", error);
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : "worker_failed" },
      { status: 500 },
    );
  }
}
