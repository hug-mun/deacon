import { NextResponse } from "next/server";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { authenticateMcpRequest, createMcpServer } from "@/lib/mcp/server";
import { getMcpProtectedResourceMetadataUrl, getMcpPublicUrl } from "@/lib/mcp/oauth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function handleMcp(request: Request) {
  const user = await authenticateMcpRequest(request);
  if (!user) {
    return NextResponse.json(
      { error: "unauthorized", message: "MCP requires a valid Bearer token." },
      {
        status: 401,
        headers: {
          "WWW-Authenticate": `Bearer resource_metadata="${getMcpProtectedResourceMetadataUrl()}", scope="knowledge:read"`,
        },
      },
    );
  }

  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  const server = createMcpServer(user.id);
  await server.connect(transport);
  return transport.handleRequest(request);
}

export async function POST(request: Request) {
  try {
    return await handleMcp(request);
  } catch (error) {
    console.error("[deacon][mcp] request failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    return NextResponse.json(
      { error: "mcp_request_failed", message: "No se pudo procesar la solicitud MCP." },
      { status: 500 },
    );
  }
}

export async function GET() {
  return NextResponse.json({
    name: "deacon-knowledge",
    endpoint: getMcpPublicUrl(),
    transport: "Streamable HTTP",
    authentication: "Bearer token required",
    authorizationServer: getMcpProtectedResourceMetadataUrl(),
    tools: ["search_knowledge", "list_library", "get_media_item", "get_transcript"],
  });
}

export async function DELETE(request: Request) {
  return handleMcp(request);
}
