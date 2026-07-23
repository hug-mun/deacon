import { NextResponse } from "next/server";
import { z } from "zod";
import { getSupabaseServerClient } from "@/lib/supabase/server";

const ParamsSchema = z.object({ id: z.string().uuid() });
const MEDIA_FIELDS =
  "id, original_filename, storage_key, status, kind, processing_stage, processing_progress, processing_error_code, processing_error_service, processing_error_message, processing_error_request_id, image_title_en, image_title_es, image_description, image_ocr_text, created_at";
const RECOVERY_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

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
      { error: { code: "unauthorized", message: "Inicia sesión para abrir este contenido." } },
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

  const { data: item, error } = await supabase
    .from("media_items")
    .select(MEDIA_FIELDS)
    .eq("id", parsed.data.id)
    .eq("user_id", user.id)
    .is("deleted_at", null)
    .maybeSingle();

  if (error) {
    console.error("[deacon][media.item] query failed", {
      code: error.code,
      message: error.message,
      mediaId: parsed.data.id,
      userId: user.id,
    });
    return NextResponse.json(
      { error: { code: "media_item_failed", message: "No se pudo abrir este contenido." } },
      { status: 500 },
    );
  }

  if (!item) {
    return NextResponse.json(
      { error: { code: "media_not_found", message: "No se encontró este contenido." } },
      { status: 404 },
    );
  }

  // Videos stream progressively with range requests, so their signed URL must
  // outlive a full viewing session instead of the 5-minute image window.
  const signedUrlTtl = item.kind === "video" ? 4 * 60 * 60 : 300;
  const { data: signedUrl } = await supabase.storage
    .from("media")
    .createSignedUrl(item.storage_key, signedUrlTtl);

  return NextResponse.json(
    { media: { ...item, signedUrl: signedUrl?.signedUrl ?? null } },
    { headers: { "Cache-Control": "private, no-store" } },
  );
}

export async function DELETE(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const supabase = await getSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json(
      { error: { code: "unauthorized", message: "Inicia sesión para borrar contenido." } },
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

  const { data: item, error } = await supabase
    .from("media_items")
    .update({ deleted_at: new Date().toISOString() })
    .eq("id", parsed.data.id)
    .eq("user_id", user.id)
    .is("deleted_at", null)
    .select("id, deleted_at")
    .maybeSingle();

  if (error || !item) {
    return NextResponse.json(
      { error: { code: item ? "media_delete_failed" : "media_not_found", message: "No se pudo borrar el contenido." } },
      { status: item ? 500 : 404 },
    );
  }

  return NextResponse.json({ deleted: true, id: item.id, deleted_at: item.deleted_at });
}

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
      { error: { code: "unauthorized", message: "Inicia sesión para recuperar contenido." } },
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

  const cutoff = new Date(Date.now() - RECOVERY_WINDOW_MS).toISOString();
  const { data: item, error } = await supabase
    .from("media_items")
    .update({ deleted_at: null })
    .eq("id", parsed.data.id)
    .eq("user_id", user.id)
    .gte("deleted_at", cutoff)
    .select("id, status, deleted_at")
    .maybeSingle();

  if (error || !item) {
    return NextResponse.json(
      { error: { code: item ? "media_restore_failed" : "media_not_found", message: "Este contenido ya no se puede recuperar." } },
      { status: item ? 500 : 404 },
    );
  }

  return NextResponse.json({ restored: true, media: item });
}
