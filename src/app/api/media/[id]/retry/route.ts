import { NextResponse } from "next/server";
import { z } from "zod";
import { getSupabaseServerClient } from "@/lib/supabase/server";

const ParamsSchema = z.object({ id: z.string().uuid() });

export async function POST(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const supabase = await getSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json(
      { error: { code: "unauthorized", message: "Inicia sesión para reintentar." } },
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
    .update({
      status: "processing",
      processing_stage: "queued",
      processing_progress: 0,
      processing_error_code: null,
      processing_error_service: null,
      processing_error_message: null,
      processing_error_request_id: null,
      processing_started_at: null,
      processing_completed_at: null,
    })
    .eq("id", parsed.data.id)
    .eq("user_id", user.id)
    .eq("status", "failed")
    .is("deleted_at", null)
    .select("id, status, processing_stage, processing_progress, processing_error_code, processing_error_message, processing_error_request_id")
    .maybeSingle();

  if (error) {
    console.error("[deacon][media.retry] update failed", {
      code: error.code,
      message: error.message,
      mediaId: parsed.data.id,
      userId: user.id,
    });
    return NextResponse.json(
      { error: { code: "media_retry_failed", message: "No se pudo reintentar este archivo." } },
      { status: 500 },
    );
  }

  if (!media) {
    return NextResponse.json(
      { error: { code: "media_not_retryable", message: "Este archivo no está listo para reintentar." } },
      { status: 409 },
    );
  }

  console.info("[deacon][media.retry] queued", { mediaId: media.id, userId: user.id });
  return NextResponse.json(media);
}
