import { NextResponse } from "next/server";
import { getSupabaseServerClient } from "@/lib/supabase/server";
import { appPath } from "@/lib/app-path";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const error = url.searchParams.get("error_code") ?? url.searchParams.get("error");
  if (error) {
    return NextResponse.redirect(new URL(appPath(`/forgot-password?reason=${encodeURIComponent(error)}`), url.origin));
  }

  const code = url.searchParams.get("code");
  const requestedNext = url.searchParams.get("next") ?? "/library";
  const next = requestedNext.startsWith("/") && !requestedNext.startsWith("//") ? requestedNext : "/library";

  if (code) {
    const supabase = await getSupabaseServerClient();
    const { error: exchangeError } = await supabase.auth.exchangeCodeForSession(code);
    if (exchangeError) {
      return NextResponse.redirect(new URL(appPath("/forgot-password?reason=otp_expired"), url.origin));
    }
  }

  return NextResponse.redirect(new URL(appPath(next), url.origin));
}
