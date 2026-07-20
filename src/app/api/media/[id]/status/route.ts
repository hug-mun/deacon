import { NextResponse } from "next/server";
import { z } from "zod";
import { getSupabaseServerClient } from "@/lib/supabase/server";

const ParamsSchema = z.object({ id: z.string().uuid() });

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const supabase = await getSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json(
      { error: { code: "unauthorized", message: "Inicia sesión para consultar el progreso." } },
      { status: 401 },
    );
  }

  const parsed = ParamsSchema.safeParse(await context.params);
  if (!parsed.success) {
    return NextResponse.json(
      { error: { code: "invalid_media_id", message: "El identificador no es válido." } },
      { status: 400 },
    );
  }

  const { data: media, error } = await supabase
    .from("media_items")
    .select("id, status, processing_stage, processing_progress, processing_error_code, processing_error_service, processing_error_message, processing_error_request_id")
    .eq("id", parsed.data.id)
    .eq("user_id", user.id)
    .is("deleted_at", null)
    .maybeSingle();

  if (error) {
    console.error("[deacon][media.status] query failed", {
      code: error.code,
      message: error.message,
      details: error.details,
      hint: error.hint,
      mediaId: parsed.data.id,
    });
    return NextResponse.json(
      { error: { code: "media_status_failed", message: "No se pudo consultar el progreso." } },
      { status: 500 },
    );
  }

  if (!media) {
    return NextResponse.json(
      { error: { code: "media_not_found", message: "No se encontró el contenido." } },
      { status: 404 },
    );
  }

  return NextResponse.json(media, {
    headers: { "Cache-Control": "no-store" },
  });
}
