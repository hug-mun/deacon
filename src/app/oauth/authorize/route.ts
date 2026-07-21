import { NextResponse } from "next/server";
import { getSupabaseServerClient } from "@/lib/supabase/server";
import {
  MCP_SCOPE,
  createAuthorizationCode,
  getMcpPublicUrl,
  getMcpServiceClient,
  safeRedirectUri,
} from "@/lib/mcp/oauth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function text(value: FormDataEntryValue | string | null) {
  return typeof value === "string" ? value : "";
}

function escapeHtml(value: string) {
  return value.replace(/[&<>'"]/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "'": "&#39;",
    '"': "&quot;",
  })[character] ?? character);
}

function invalidRequest(message: string) {
  return NextResponse.json({ error: "invalid_request", error_description: message }, { status: 400 });
}

function redirectError(redirectUri: string, error: string, state: string) {
  const url = new URL(redirectUri);
  url.searchParams.set("error", error);
  if (state) url.searchParams.set("state", state);
  return NextResponse.redirect(url);
}

function validateAuthorizationRequest(params: URLSearchParams | FormData) {
  const get = (key: string) => params.get(key);
  const responseType = text(get("response_type"));
  const clientId = text(get("client_id"));
  const redirectUri = text(get("redirect_uri"));
  const codeChallenge = text(get("code_challenge"));
  const codeChallengeMethod = text(get("code_challenge_method"));
  const resource = text(get("resource"));
  const state = text(get("state"));
  const scope = text(get("scope")) || MCP_SCOPE;

  if (responseType !== "code") return { error: invalidRequest("response_type must be code") };
  if (!clientId || !redirectUri || !codeChallenge || codeChallengeMethod !== "S256") {
    return { error: invalidRequest("client_id, redirect_uri, and S256 PKCE are required") };
  }
  if (!safeRedirectUri(redirectUri)) return { error: invalidRequest("redirect_uri is not allowed") };
  if (resource !== getMcpPublicUrl()) return { error: invalidRequest("resource does not match this MCP server") };
  if (scope !== MCP_SCOPE) return { error: invalidRequest("unsupported scope") };

  return { responseType, clientId, redirectUri, codeChallenge, codeChallengeMethod, resource, state, scope };
}

function renderConsent(values: Record<string, string>) {
  const hidden = Object.entries(values)
    .map(([key, value]) => `<input type="hidden" name="${escapeHtml(key)}" value="${escapeHtml(value)}">`)
    .join("");
  return new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Connect Deacon</title><style>body{font-family:system-ui,sans-serif;max-width:34rem;margin:10vh auto;padding:1.5rem;color:#171717}main{border:1px solid #ddd;border-radius:1rem;padding:2rem}button{border:0;border-radius:.6rem;padding:.75rem 1rem;font-weight:600;background:#111;color:#fff;cursor:pointer}button.secondary{background:#eee;color:#111;margin-left:.5rem}</style></head><body><main><p>DEACON</p><h1>Connect your study library?</h1><p>ChatGPT will be allowed to search your private dermatology exam-study material and read transcripts you select through Deacon.</p><form method="post">${hidden}<input type="hidden" name="approval" value="approve"><button type="submit">Allow access</button><button class="secondary" type="submit" name="approval" value="deny">Cancel</button></form></main></body></html>`,
    { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } },
  );
}

async function getUser() {
  const supabase = await getSupabaseServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  return user;
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const validated = validateAuthorizationRequest(url.searchParams);
  if (validated.error) return validated.error;

  const user = await getUser();
  if (!user) {
    const loginUrl = new URL("/login", url.origin);
    loginUrl.searchParams.set("next", `${url.pathname}${url.search}`);
    return NextResponse.redirect(loginUrl);
  }

  return renderConsent({
    response_type: validated.responseType,
    client_id: validated.clientId,
    redirect_uri: validated.redirectUri,
    code_challenge: validated.codeChallenge,
    code_challenge_method: validated.codeChallengeMethod,
    resource: validated.resource,
    state: validated.state,
    scope: validated.scope,
  });
}

export async function POST(request: Request) {
  const form = await request.formData();
  const validated = validateAuthorizationRequest(form);
  if (validated.error) return validated.error;
  if (text(form.get("approval")) !== "approve") {
    return redirectError(validated.redirectUri, "access_denied", validated.state);
  }

  const user = await getUser();
  if (!user) {
    const loginUrl = new URL("/login", new URL(request.url).origin);
    loginUrl.searchParams.set("next", `/oauth/authorize?${new URLSearchParams([...form.entries()].map(([key, value]) => [key, text(value)])).toString()}`);
    return NextResponse.redirect(loginUrl);
  }

  const { rawCode, codeHash } = createAuthorizationCode();
  const { error } = await getMcpServiceClient().from("mcp_oauth_codes").insert({
    code_hash: codeHash,
    client_id: validated.clientId,
    redirect_uri: validated.redirectUri,
    user_id: user.id,
    code_challenge: validated.codeChallenge,
    resource: validated.resource,
    scope: validated.scope,
    expires_at: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
  });
  if (error) {
    console.error("[deacon][oauth] authorization code insert failed", { code: error.code, message: error.message });
    return NextResponse.json({ error: "server_error" }, { status: 500 });
  }

  const callback = new URL(validated.redirectUri);
  callback.searchParams.set("code", rawCode);
  if (validated.state) callback.searchParams.set("state", validated.state);
  // Consent is submitted with POST. 303 makes the OAuth client follow the
  // callback with GET; a default 307 would replay the POST at ChatGPT's
  // callback endpoint and result in a Bad Request.
  return NextResponse.redirect(callback, 303);
}
