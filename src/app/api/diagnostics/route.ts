import { NextResponse } from "next/server";
import { classifyOpenAiFailure } from "@/lib/openai/provider-error";
import { getSupabaseServerClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type ServiceStatus = "ok" | "degraded" | "down" | "not_configured";

type ServiceCheck = {
  service: string;
  status: ServiceStatus;
  message: string;
  code?: string;
  requestId?: string | null;
};

const onePixelPng =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

function openAiCheckError(response: Response, body: unknown): ServiceCheck {
  const failure = classifyOpenAiFailure(response.status, body, response.headers);
  const messages = {
    quota_exhausted: "OpenAI no tiene crédito disponible.",
    rate_limited: "OpenAI está limitando temporalmente las solicitudes.",
    authentication: "La clave de OpenAI no es válida.",
    permission_denied: "La clave no tiene el permiso model.request para este modelo.",
    provider_unavailable: "OpenAI no responde ahora.",
    network: "No se pudo acceder a OpenAI.",
    invalid_request: "OpenAI rechazó la solicitud de diagnóstico.",
  } as const;
  return {
    service: "openai_vision",
    status: failure.kind === "permission_denied" ? "degraded" : "down",
    message: messages[failure.kind],
    code: failure.code ?? failure.kind,
    requestId: failure.requestId,
  };
}

async function checkVision() {
  const apiKey = process.env.OPENAI_API_KEY;
  const model = process.env.OPENAI_VISION_MODEL || "gpt-5.6-luna";
  const detail = process.env.OPENAI_VISION_DETAIL || "low";
  if (!apiKey) {
    return {
      service: "openai_vision",
      status: "not_configured" as const,
      message: "OPENAI_API_KEY no está configurada.",
      code: "missing_api_key",
    };
  }

  try {
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        max_completion_tokens: 16,
        messages: [{
          role: "user",
          content: [
            { type: "text", text: "Reply with one character: K" },
            { type: "image_url", image_url: { url: `data:image/png;base64,${onePixelPng}`, detail } },
          ],
        }],
      }),
      cache: "no-store",
    });
    const body = await response.json().catch(() => null);
    if (!response.ok) return openAiCheckError(response, body);
    return {
      service: "openai_vision",
      status: "ok" as const,
      message: `${model} acepta solicitudes de visión (${detail}).`,
      code: "vision_request_ok",
      requestId: response.headers.get("x-request-id"),
    };
  } catch {
    return {
      service: "openai_vision",
      status: "down" as const,
      message: "No se pudo acceder a OpenAI.",
      code: "network_error",
    };
  }
}

async function checkOpenAiApi() {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return {
      service: "openai_api",
      status: "not_configured" as const,
      message: "OPENAI_API_KEY no está configurada.",
      code: "missing_api_key",
    };
  }

  try {
    const response = await fetch("https://api.openai.com/v1/models", {
      headers: { Authorization: `Bearer ${apiKey}` },
      cache: "no-store",
    });
    const body = await response.json().catch(() => null);
    if (!response.ok) {
      const failure = classifyOpenAiFailure(response.status, body, response.headers);
      return {
        service: "openai_api",
        status: "down" as const,
        message: "La clave de OpenAI no pudo autenticarse.",
        code: failure.code ?? failure.kind,
        requestId: failure.requestId,
      };
    }
    return {
      service: "openai_api",
      status: "ok" as const,
      message: "La API de OpenAI responde.",
      code: "api_reachable",
      requestId: response.headers.get("x-request-id"),
    };
  } catch {
    return {
      service: "openai_api",
      status: "down" as const,
      message: "No se pudo acceder a OpenAI.",
      code: "network_error",
    };
  }
}

export async function GET(request: Request) {
  const supabase = await getSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json(
      { error: { code: "unauthorized", message: "Inicia sesión para revisar los servicios." } },
      { status: 401 },
    );
  }

  const deep = new URL(request.url).searchParams.get("deep") === "1";
  const checks: ServiceCheck[] = [
    { service: "app", status: "ok", message: "La aplicación responde.", code: "app_reachable" },
  ];

  const { error: databaseError } = await supabase.from("media_items").select("id").limit(1);
  checks.push(databaseError
    ? { service: "supabase_database", status: "down", message: "No se pudo consultar la base de datos.", code: databaseError.code }
    : { service: "supabase_database", status: "ok", message: "La base de datos responde.", code: "database_query_ok" });

  const { error: storageError } = await supabase.storage.from("media").list(`users/${user.id}`, { limit: 1 });
  checks.push(storageError
    ? { service: "supabase_storage", status: "down", message: "No se pudo consultar el almacenamiento privado.", code: storageError.name }
    : { service: "supabase_storage", status: "ok", message: "El almacenamiento privado responde.", code: "storage_query_ok" });

  checks.push(await checkOpenAiApi());
  if (deep) checks.push(await checkVision());
  else checks.push({ service: "openai_vision", status: "degraded", message: "No probado; pulsa Revisar IA para ejecutar una solicitud mínima.", code: "deep_check_skipped" });

  const publicUrl = process.env.MCP_PUBLIC_URL;
  const oauthReady = Boolean(publicUrl && process.env.MCP_OAUTH_SIGNING_SECRET);
  checks.push({
    service: "mcp",
    status: oauthReady ? "ok" : "degraded",
    message: oauthReady ? "MCP y OAuth están configurados." : "MCP responde, pero falta la firma OAuth de producción.",
    code: oauthReady ? "mcp_oauth_ready" : "mcp_oauth_incomplete",
  });

  const { data: worker } = await supabase
    .from("service_health")
    .select("status, instance_id, last_heartbeat_at, last_success_at, last_error_at, last_error_code, last_error_message")
    .eq("service_name", "media_worker")
    .maybeSingle();
  const heartbeatAge = worker?.last_heartbeat_at
    ? Date.now() - new Date(worker.last_heartbeat_at).getTime()
    : Number.POSITIVE_INFINITY;
  checks.push({
    service: "media_worker",
    status: worker && heartbeatAge < 90_000 && worker.status !== "down" ? worker.status : "down",
    message: worker
      ? `Worker ${worker.instance_id ?? "sin instancia"}; último heartbeat hace ${Math.max(0, Math.round(heartbeatAge / 1000))}s.`
      : "No se encontró un heartbeat del worker.",
    code: worker?.last_error_code ?? (worker ? "worker_heartbeat_ok" : "worker_missing"),
  });

  return NextResponse.json({ checkedAt: new Date().toISOString(), deep, services: checks });
}
