import { NextResponse } from "next/server";
import { z } from "zod";
import { chunkText } from "@/lib/retrieval/chunk-text";
import { getSupabaseServerClient } from "@/lib/supabase/server";

const ParamsSchema = z.object({ id: z.string().uuid() });
const UpdateSchema = z.object({ body: z.string().trim().min(1).max(100_000) });

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
      { error: { code: "unauthorized", message: "Inicia sesión para leer una nota." } },
      { status: 401 },
    );
  }

  const params = ParamsSchema.safeParse(await context.params);
  if (!params.success) {
    return NextResponse.json(
      { error: { code: "invalid_note", message: "El identificador no es válido." } },
      { status: 400 },
    );
  }

  const { data: note, error } = await supabase
    .from("notes")
    .select("id, session_id, body, created_at, updated_at")
    .eq("id", params.data.id)
    .eq("user_id", user.id)
    .is("deleted_at", null)
    .maybeSingle();
  if (error) {
    return NextResponse.json(
      { error: { code: "note_query_failed", message: "No se pudo cargar la nota." } },
      { status: 500 },
    );
  }
  if (!note) {
    return NextResponse.json(
      { error: { code: "note_not_found", message: "No se encontró la nota." } },
      { status: 404 },
    );
  }
  return NextResponse.json({ note });
}

export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const supabase = await getSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json(
      { error: { code: "unauthorized", message: "Inicia sesión para editar una nota." } },
      { status: 401 },
    );
  }

  const params = ParamsSchema.safeParse(await context.params);
  const input = UpdateSchema.safeParse(await request.json().catch(() => null));
  if (!params.success || !input.success) {
    return NextResponse.json(
      { error: { code: "invalid_note", message: "La nota no es válida." } },
      { status: 400 },
    );
  }

  const { data: note, error } = await supabase
    .from("notes")
    .update({ body: input.data.body })
    .eq("id", params.data.id)
    .eq("user_id", user.id)
    .is("deleted_at", null)
    .select("id, session_id, body, created_at, updated_at")
    .maybeSingle();
  if (error || !note) {
    return NextResponse.json(
      { error: { code: note ? "note_update_failed" : "note_not_found", message: "No se pudo editar la nota." } },
      { status: note ? 500 : 404 },
    );
  }

  const { error: deleteError } = await supabase
    .from("text_chunks")
    .delete()
    .eq("user_id", user.id)
    .eq("source_type", "note")
    .eq("source_id", note.id);
  if (deleteError) {
    return NextResponse.json(
      { error: { code: "note_index_failed", message: "No se pudo actualizar el índice de la nota." } },
      { status: 500 },
    );
  }

  const rows = chunkText(note.body).map((chunk, index) => ({
    user_id: user.id,
    session_id: note.session_id,
    source_type: "note",
    source_id: note.id,
    chunk_index: index,
    char_start: chunk.charStart,
    char_end: chunk.charEnd,
    content: chunk.content,
    embedding: null,
  }));
  const { error: insertError } = rows.length
    ? await supabase.from("text_chunks").insert(rows)
    : { error: null };
  if (insertError) {
    return NextResponse.json(
      { error: { code: "note_index_failed", message: "No se pudo actualizar el índice de la nota." } },
      { status: 500 },
    );
  }

  return NextResponse.json({ note });
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
      { error: { code: "unauthorized", message: "Inicia sesión para borrar una nota." } },
      { status: 401 },
    );
  }

  const params = ParamsSchema.safeParse(await context.params);
  if (!params.success) {
    return NextResponse.json(
      { error: { code: "invalid_note", message: "El identificador no es válido." } },
      { status: 400 },
    );
  }

  const { data: note, error } = await supabase
    .from("notes")
    .update({ deleted_at: new Date().toISOString() })
    .eq("id", params.data.id)
    .eq("user_id", user.id)
    .is("deleted_at", null)
    .select("id")
    .maybeSingle();
  if (error || !note) {
    return NextResponse.json(
      { error: { code: note ? "note_delete_failed" : "note_not_found", message: "No se pudo borrar la nota." } },
      { status: note ? 500 : 404 },
    );
  }

  await supabase
    .from("text_chunks")
    .delete()
    .eq("user_id", user.id)
    .eq("source_type", "note")
    .eq("source_id", note.id);

  return NextResponse.json({ deleted: true, id: note.id });
}
