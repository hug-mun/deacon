import { NextResponse } from "next/server";
import {
  MCP_SCOPE,
  createAccessToken,
  getMcpPublicUrl,
  getMcpServiceClient,
  hashCode,
  verifyPkce,
} from "@/lib/mcp/oauth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function oauthError(error: string, description: string, status = 400) {
  return NextResponse.json({ error, error_description: description }, { status, headers: { "Cache-Control": "no-store" } });
}

export async function POST(request: Request) {
  const form = await request.formData();
  const grantType = String(form.get("grant_type") ?? "");
  const code = String(form.get("code") ?? "");
  const clientId = String(form.get("client_id") ?? "");
  const redirectUri = String(form.get("redirect_uri") ?? "");
  const codeVerifier = String(form.get("code_verifier") ?? "");
  const resource = String(form.get("resource") ?? "");

  if (grantType !== "authorization_code") return oauthError("unsupported_grant_type", "Only authorization_code is supported.");
  if (!code || !clientId || !redirectUri || !codeVerifier) return oauthError("invalid_request", "code, client_id, redirect_uri, and code_verifier are required.");
  if (resource !== getMcpPublicUrl()) return oauthError("invalid_target", "resource does not match this MCP server.");

  const now = new Date().toISOString();
  const { data: authorizationCode, error } = await getMcpServiceClient()
    .from("mcp_oauth_codes")
    .update({ used_at: now })
    .eq("code_hash", hashCode(code))
    .eq("client_id", clientId)
    .eq("redirect_uri", redirectUri)
    .eq("resource", resource)
    .is("used_at", null)
    .gt("expires_at", now)
    .select("user_id, code_challenge, scope")
    .maybeSingle();
  if (error || !authorizationCode) return oauthError("invalid_grant", "The authorization code is invalid, expired, or already used.");
  if (authorizationCode.scope !== MCP_SCOPE || !verifyPkce(codeVerifier, authorizationCode.code_challenge)) {
    return oauthError("invalid_grant", "PKCE verification failed.");
  }

  const issued = createAccessToken({ userId: authorizationCode.user_id, scope: MCP_SCOPE, resource });
  return NextResponse.json(
    { access_token: issued.token, token_type: "Bearer", expires_in: issued.expiresIn, scope: MCP_SCOPE },
    { headers: { "Cache-Control": "no-store", Pragma: "no-cache" } },
  );
}
