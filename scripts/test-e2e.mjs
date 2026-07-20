const endpoint = (process.env.DEACON_TEST_URL ?? "http://127.0.0.1:3000").replace(/\/$/, "");

async function request(path, init) {
  const response = await fetch(`${endpoint}${path}`, { ...init, signal: AbortSignal.timeout(10000) });
  const body = await response.text();
  let json = null;
  try { json = JSON.parse(body); } catch {}
  return { response, body, json };
}

function expect(condition, message) {
  if (!condition) throw new Error(message);
}

const checks = [];
const home = await request("/");
expect(home.response.ok, `home failed (${home.response.status})`);
checks.push({ service: "app", status: home.response.status });

const health = await request("/api/health");
expect([200, 503].includes(health.response.status), `health endpoint failed (${health.response.status})`);
expect(health.json?.services?.some((service) => service.service === "app"), "health endpoint omitted app status");
checks.push({ service: "health", status: health.response.status });

const mcpInfo = await request("/mcp");
expect(mcpInfo.response.ok && mcpInfo.json?.transport === "Streamable HTTP", "MCP discovery failed");
checks.push({ service: "mcp_discovery", status: mcpInfo.response.status });

const mcpUnauthorized = await request("/api/mcp", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
});
expect(mcpUnauthorized.response.status === 401, "MCP did not reject an unauthenticated request");
expect(mcpUnauthorized.response.headers.get("www-authenticate")?.includes("oauth-protected-resource"), "MCP did not advertise OAuth metadata");
checks.push({ service: "mcp_auth", status: mcpUnauthorized.response.status });

for (const path of ["/.well-known/oauth-protected-resource", "/.well-known/oauth-authorization-server"]) {
  const metadata = await request(path);
  expect(metadata.response.ok, `${path} failed (${metadata.response.status})`);
  checks.push({ service: path, status: metadata.response.status });
}

const unauthorizedDiagnostics = await request("/api/diagnostics");
expect(unauthorizedDiagnostics.response.status === 401, "diagnostics exposed without authentication");
checks.push({ service: "diagnostics_auth", status: unauthorizedDiagnostics.response.status });

const unauthorizedUpload = await request("/api/uploads/prepare", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ filename: "test.png", mime_type: "image/png", size_bytes: 1, file_hash: "0".repeat(64) }),
});
expect(unauthorizedUpload.response.status === 401, "upload preparation did not reject an unauthenticated request");
checks.push({ service: "upload_auth", status: unauthorizedUpload.response.status });

console.log(JSON.stringify({ endpoint, checks }, null, 2));
