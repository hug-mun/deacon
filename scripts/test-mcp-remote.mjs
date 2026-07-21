const endpoint = process.env.MCP_TEST_URL ?? "https://deacon.vercel.app/mcp";
const endpointUrl = new URL(endpoint);
const origin = endpointUrl.origin;

async function getJson(path) {
  const response = await fetch(`${origin}${path}`, { cache: "no-store" });
  const body = await response.json();
  if (!response.ok) throw new Error(`${path} failed (${response.status}): ${JSON.stringify(body)}`);
  return body;
}

const resource = await getJson("/.well-known/oauth-protected-resource");
const authorizationServer = await getJson("/.well-known/oauth-authorization-server");
const health = await getJson("/api/health");

if (resource.resource !== endpoint) throw new Error(`Protected-resource metadata points to ${resource.resource}, expected ${endpoint}`);
if (!resource.authorization_servers?.includes(origin)) throw new Error("OAuth issuer is not advertised by protected-resource metadata");
if (authorizationServer.issuer !== origin) throw new Error(`OAuth issuer is ${authorizationServer.issuer}, expected ${origin}`);
if (!authorizationServer.authorization_endpoint.startsWith(`${origin}/oauth/authorize`)) throw new Error("Authorization endpoint is not on the production issuer");
if (!authorizationServer.token_endpoint.startsWith(`${origin}/oauth/token`)) throw new Error("Token endpoint is not on the production issuer");
if (health.services?.find((service) => service.service === "mcp")?.status !== "ok") throw new Error("Production health does not report MCP as ready");

const unauthenticated = await fetch(endpoint, {
  method: "POST",
  headers: { Accept: "application/json, text/event-stream", "Content-Type": "application/json" },
  body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
});
if (unauthenticated.status !== 401) throw new Error(`Unauthenticated MCP request returned ${unauthenticated.status}, expected 401`);
const challenge = unauthenticated.headers.get("www-authenticate") ?? "";
if (!challenge.includes("oauth-protected-resource")) throw new Error("MCP 401 did not advertise OAuth protected-resource metadata");

console.log(JSON.stringify({
  endpoint,
  issuer: authorizationServer.issuer,
  toolsAuthentication: "OAuth 2.1 authorization code + S256 PKCE",
  health: "ok",
  unauthenticatedRequest: "401 with OAuth discovery challenge",
}, null, 2));
