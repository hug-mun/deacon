const endpoint = process.env.MCP_TEST_URL ?? "http://127.0.0.1:3000/mcp";
const token = process.env.MCP_TEST_TOKEN;

if (!token) {
  console.error("MCP_TEST_TOKEN is required");
  process.exit(1);
}

async function call(id, method, params = {}) {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
  });
  const body = await response.json();
  if (!response.ok || body.error) {
    throw new Error(`${method} failed (${response.status}): ${JSON.stringify(body)}`);
  }
  return body.result;
}

const initialize = await call(1, "initialize", {
  protocolVersion: "2025-06-18",
  capabilities: {},
  clientInfo: { name: "deacon-mcp-smoke-test", version: "0.1.0" },
});
const tools = await call(2, "tools/list");
const search = await call(3, "tools/call", {
  name: "search_knowledge",
  arguments: { query: process.env.MCP_TEST_QUERY ?? "mindfulness respiración", limit: 3 },
});

const toolNames = (tools.tools ?? []).map((tool) => tool.name);
if (!toolNames.includes("search_knowledge")) throw new Error("search_knowledge is not advertised");
if (!toolNames.includes("get_media_item")) throw new Error("get_media_item is not advertised");
if (!toolNames.includes("get_transcript")) throw new Error("get_transcript is not advertised");
if (!search.structuredContent?.results) throw new Error("search_knowledge returned no structured results");

console.log(
  JSON.stringify(
    {
      server: initialize.serverInfo,
      tools: toolNames,
      resultCount: search.structuredContent.results.length,
      firstSource: search.structuredContent.results[0]?.filename ?? null,
    },
    null,
    2,
  ),
);
