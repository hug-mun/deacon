import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type PublicCheck = {
  service: string;
  status: "ok" | "degraded" | "down" | "not_configured";
};

const onePixelPng =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

function serviceClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  return createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });
}

async function openAiStatus(): Promise<PublicCheck> {
  const key = process.env.OPENAI_API_KEY;
  if (!key) return { service: "openai_api", status: "not_configured" };

  try {
    const response = await fetch("https://api.openai.com/v1/models", {
      headers: { Authorization: `Bearer ${key}` },
      cache: "no-store",
      signal: AbortSignal.timeout(5000),
    });
    if (response.ok) return { service: "openai_api", status: "ok" };
    return { service: "openai_api", status: response.status === 401 || response.status === 403 ? "degraded" : "down" };
  } catch {
    return { service: "openai_api", status: "down" };
  }
}

async function openAiVisionStatus(): Promise<PublicCheck> {
  const key = process.env.OPENAI_API_KEY;
  const model = process.env.OPENAI_VISION_MODEL || "gpt-5.6-luna";
  const detail = process.env.OPENAI_VISION_DETAIL || "low";
  if (!key) return { service: "openai_vision", status: "not_configured" };

  try {
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        max_completion_tokens: 16,
        messages: [{ role: "user", content: [
          { type: "text", text: "Reply with K." },
          { type: "image_url", image_url: { url: `data:image/png;base64,${onePixelPng}`, detail } },
        ] }],
      }),
      cache: "no-store",
      signal: AbortSignal.timeout(10_000),
    });
    return {
      service: "openai_vision",
      status: response.ok ? "ok" : response.status === 401 || response.status === 403 || response.status === 429 ? "degraded" : "down",
    };
  } catch {
    return { service: "openai_vision", status: "down" };
  }
}

export async function GET(request: Request) {
  const deep = new URL(request.url).searchParams.get("deep") === "1";
  const checks: PublicCheck[] = [{ service: "app", status: "ok" }];
  const supabase = serviceClient();

  if (!supabase) {
    checks.push({ service: "supabase_database", status: "not_configured" });
    checks.push({ service: "supabase_storage", status: "not_configured" });
    checks.push({ service: "media_worker", status: "not_configured" });
  } else {
    const { error: databaseError } = await supabase.from("users").select("id").limit(1);
    checks.push({ service: "supabase_database", status: databaseError ? "down" : "ok" });

    const { data: bucket, error: storageError } = await supabase.storage.getBucket("media");
    checks.push({ service: "supabase_storage", status: storageError || !bucket ? "down" : "ok" });

    const { data: worker } = await supabase
      .from("service_health")
      .select("status, last_heartbeat_at")
      .eq("service_name", "media_worker")
      .maybeSingle();
    const heartbeatAge = worker?.last_heartbeat_at
      ? Date.now() - new Date(worker.last_heartbeat_at).getTime()
      : Number.POSITIVE_INFINITY;
    checks.push({
      service: "media_worker",
      status: worker && heartbeatAge < 90_000 && worker.status !== "down" ? worker.status : "down",
    });
  }

  checks.push(await openAiStatus());
  if (deep) checks.push(await openAiVisionStatus());
  checks.push({
    service: "mcp",
    status: process.env.MCP_OAUTH_SIGNING_SECRET ? "ok" : "degraded",
  });

  const hasDown = checks.some((check) => check.status === "down");
  const hasDegraded = checks.some((check) => check.status === "degraded" || check.status === "not_configured");
  const status = hasDown ? "down" : hasDegraded ? "degraded" : "ok";
  return NextResponse.json(
    { status, checkedAt: new Date().toISOString(), services: checks },
    { status: status === "down" ? 503 : 200, headers: { "Cache-Control": "no-store" } },
  );
}
