import { NextResponse } from "next/server";
import { z } from "zod";
import { chunkText } from "@/lib/retrieval/chunk-text";
import { getSupabaseServerClient } from "@/lib/supabase/server";

const NoteSchema = z.object({
  session_id: z.string().uuid(),
  body: z.string().trim().min(1).max(100_000),
});

async function replaceNoteChunks(
  supabase: Awaited<ReturnType<typeof getSupabaseServerClient>>,
  userId: string,
  note: { id: string; session_id: string; body: string },
) {
  const { error: deleteError } = await supabase
    .from("text_chunks")
    .delete()
    .eq("user_id", userId)
    .eq("source_type", "note")
    .eq("source_id", note.id);
  if (deleteError) throw deleteError;

  const rows = chunkText(note.body).map((chunk, index) => ({
    user_id: userId,
    session_id: note.session_id,
    source_type: "note",
    source_id: note.id,
    chunk_index: index,
    char_start: chunk.charStart,
    char_end: chunk.charEnd,
    content: chunk.content,
    embedding: null,
  }));

  if (rows.length === 0) return;
  const { error: insertError } = await supabase.from("text_chunks").insert(rows);
  if (insertError) throw insertError;
}

export async function GET(request: Request) {
  const supabase = await getSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json(
      { error: { code: "unauthorized", message: "Inicia sesión para ver tus notas." } },
      { status: 401 },
    );
  }

  const sessionId = new URL(request.url).searchParams.get("session_id");
  const query = supabase
    .from("notes")
    .select("id, session_id, body, created_at, updated_at")
    .eq("user_id", user.id)
    .is("deleted_at", null)
    .order("updated_at", { ascending: false })
    .limit(100);
  if (sessionId) query.eq("session_id", sessionId);

  const { data, error } = await query;
  if (error) {
    return NextResponse.json(
      { error: { code: "notes_query_failed", message: "No se pudieron cargar las notas." } },
      { status: 500 },
    );
  }
  return NextResponse.json({ notes: data ?? [] });
}

export async function POST(request: Request) {
  const supabase = await getSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json(
      { error: { code: "unauthorized", message: "Inicia sesión para guardar una nota." } },
      { status: 401 },
    );
  }

  const input = NoteSchema.safeParse(await request.json().catch(() => null));
  if (!input.success) {
    return NextResponse.json(
      { error: { code: "invalid_note", message: "Escribe una nota válida." } },
      { status: 400 },
    );
  }

  const { data: session } = await supabase
    .from("sessions")
    .select("id")
    .eq("id", input.data.session_id)
    .eq("user_id", user.id)
    .is("deleted_at", null)
    .maybeSingle();
  if (!session) {
    return NextResponse.json(
      { error: { code: "session_not_found", message: "No se encontró la sesión." } },
      { status: 404 },
    );
  }

  const { data: note, error } = await supabase
    .from("notes")
    .insert({ user_id: user.id, session_id: session.id, body: input.data.body })
    .select("id, session_id, body, created_at, updated_at")
    .single();
  if (error || !note) {
    console.error("[deacon][notes] insert failed", { code: error?.code, message: error?.message });
    return NextResponse.json(
      { error: { code: "note_create_failed", message: "No se pudo guardar la nota." } },
      { status: 500 },
    );
  }

  try {
    await replaceNoteChunks(supabase, user.id, note);
  } catch (chunkError) {
    console.error("[deacon][notes] chunk insert failed", {
      noteId: note.id,
      error: chunkError instanceof Error ? chunkError.message : String(chunkError),
    });
    await supabase.from("notes").delete().eq("id", note.id).eq("user_id", user.id);
    return NextResponse.json(
      { error: { code: "note_index_failed", message: "No se pudo indexar la nota." } },
      { status: 500 },
    );
  }

  return NextResponse.json({ note }, { status: 201 });
}
