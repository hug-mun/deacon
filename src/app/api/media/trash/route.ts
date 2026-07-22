import { NextResponse } from "next/server";
import { getSupabaseServerClient } from "@/lib/supabase/server";

const RECOVERY_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

export async function GET() {
  const supabase = await getSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json(
      { error: { code: "unauthorized", message: "Inicia sesión para ver la papelera." } },
      { status: 401 },
    );
  }

  const cutoff = new Date(Date.now() - RECOVERY_WINDOW_MS).toISOString();
  const { data, error } = await supabase
    .from("media_items")
    .select("id, original_filename, kind, image_title_es, image_title_en, deleted_at")
    .eq("user_id", user.id)
    .gte("deleted_at", cutoff)
    .order("deleted_at", { ascending: false });

  if (error) {
    return NextResponse.json(
      { error: { code: "trash_query_failed", message: "No se pudo cargar la papelera." } },
      { status: 500 },
    );
  }

  return NextResponse.json({ items: data ?? [] }, { headers: { "Cache-Control": "private, no-store" } });
}
