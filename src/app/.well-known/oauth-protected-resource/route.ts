import { NextResponse } from "next/server";
import { getMcpProtectedResourceMetadata } from "@/lib/mcp/oauth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET() {
  return NextResponse.json(getMcpProtectedResourceMetadata(), {
    headers: { "Cache-Control": "public, max-age=300" },
  });
}
