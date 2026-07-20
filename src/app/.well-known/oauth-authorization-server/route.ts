import { NextResponse } from "next/server";
import { getMcpAuthorizationServerMetadata } from "@/lib/mcp/oauth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET() {
  return NextResponse.json(getMcpAuthorizationServerMetadata(), {
    headers: { "Cache-Control": "public, max-age=300" },
  });
}
