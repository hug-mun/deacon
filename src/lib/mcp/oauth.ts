import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { createClient } from "@supabase/supabase-js";

export const MCP_SCOPE = "knowledge:read";

function base64Url(value: Buffer | string) {
  return Buffer.from(value).toString("base64url");
}

function decodeBase64Url(value: string) {
  return Buffer.from(value, "base64url").toString("utf8");
}

export function getMcpPublicUrl() {
  const value = process.env.MCP_PUBLIC_URL || `${process.env.APP_PUBLIC_URL || "http://localhost:3000"}/mcp`;
  return value.replace(/\/$/, "");
}

export function getMcpIssuer() {
  if (process.env.MCP_OAUTH_ISSUER) return process.env.MCP_OAUTH_ISSUER.replace(/\/$/, "");
  const resource = new URL(getMcpPublicUrl());
  const resourcePath = resource.pathname.replace(/\/mcp\/?$/, "");
  return `${resource.origin}${resourcePath}`.replace(/\/$/, "");
}

export function getMcpProtectedResourceMetadataUrl() {
  return `${getMcpIssuer()}/.well-known/oauth-protected-resource`;
}

export function getMcpAuthorizationServerMetadata() {
  const issuer = getMcpIssuer();
  return {
    issuer,
    authorization_endpoint: `${issuer}/oauth/authorize`,
    token_endpoint: `${issuer}/oauth/token`,
    client_id_metadata_document_supported: true,
    token_endpoint_auth_methods_supported: ["none"],
    code_challenge_methods_supported: ["S256"],
    scopes_supported: [MCP_SCOPE],
  };
}

export function getMcpProtectedResourceMetadata() {
  return {
    resource: getMcpPublicUrl(),
    authorization_servers: [getMcpIssuer()],
    scopes_supported: [MCP_SCOPE],
    resource_documentation: `${getMcpIssuer()}/mcp`,
  };
}

export function createAuthorizationCode() {
  const rawCode = base64Url(randomBytes(32));
  return { rawCode, codeHash: createHash("sha256").update(rawCode).digest("hex") };
}

export function hashCode(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

export function verifyPkce(codeVerifier: string, codeChallenge: string) {
  const expected = base64Url(createHash("sha256").update(codeVerifier).digest());
  const actual = Buffer.from(codeChallenge);
  const candidate = Buffer.from(expected);
  return actual.length === candidate.length && timingSafeEqual(actual, candidate);
}

function getSigningSecret() {
  const secret = process.env.MCP_OAUTH_SIGNING_SECRET;
  if (!secret) throw new Error("MCP_OAUTH_SIGNING_SECRET is not configured");
  return secret;
}

export function createAccessToken(input: { userId: string; scope: string; resource: string }) {
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    sub: input.userId,
    aud: input.resource,
    scope: input.scope,
    iat: now,
    exp: now + 3600,
    jti: base64Url(randomBytes(16)),
  };
  const encodedPayload = base64Url(JSON.stringify(payload));
  const signature = base64Url(createHmac("sha256", getSigningSecret()).update(encodedPayload).digest());
  return { token: `${encodedPayload}.${signature}`, expiresIn: 3600 };
}

export function verifyAccessToken(token: string) {
  const [encodedPayload, encodedSignature] = token.split(".");
  if (!encodedPayload || !encodedSignature) return null;

  const expectedSignature = createHmac("sha256", getSigningSecret()).update(encodedPayload).digest();
  const actualSignature = Buffer.from(encodedSignature, "base64url");
  if (actualSignature.length !== expectedSignature.length || !timingSafeEqual(actualSignature, expectedSignature)) {
    return null;
  }

  let payload: { sub?: string; aud?: string; scope?: string; exp?: number };
  try {
    payload = JSON.parse(decodeBase64Url(encodedPayload));
  } catch {
    return null;
  }

  if (
    !payload.sub ||
    payload.aud !== getMcpPublicUrl() ||
    payload.scope !== MCP_SCOPE ||
    !payload.exp ||
    payload.exp <= Math.floor(Date.now() / 1000)
  ) {
    return null;
  }
  return { id: payload.sub, scope: payload.scope };
}

export function getMcpServiceClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceRoleKey) throw new Error("MCP Supabase service configuration is missing");
  return createClient(url, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

export function safeRedirectUri(value: string) {
  const allowedPrefix = process.env.MCP_OAUTH_REDIRECT_PREFIX || "https://chatgpt.com/connector/oauth/";
  return value.startsWith(allowedPrefix) && !value.includes("\n") && !value.includes("\r");
}
