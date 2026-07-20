import { NextResponse } from "next/server";
import { z } from "zod";
import { getSupabaseServerClient } from "@/lib/supabase/server";

const MAX_FILE_SIZE = 50 * 1024 * 1024;
const MEDIA_MIME_TYPES = [
  "image/jpeg",
  "image/png",
  "image/heic",
  "application/pdf",
] as const;

const PrepareUploadSchema = z.object({
  session_id: z.string().uuid().optional().nullable(),
  session_date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional()
    .nullable(),
  filename: z.string().trim().min(1).max(255),
  mime_type: z.enum(MEDIA_MIME_TYPES),
  size_bytes: z.number().int().positive().max(MAX_FILE_SIZE),
  file_hash: z.string().regex(/^[a-f0-9]{64}$/i),
});

function getExtension(filename: string, mimeType: string) {
  const extension = filename.split(".").pop()?.toLowerCase();
  if (extension && ["jpg", "jpeg", "png", "heic", "pdf"].includes(extension)) {
    return extension === "jpeg" ? "jpg" : extension;
  }

  if (mimeType === "application/pdf") return "pdf";
  return mimeType === "image/png" ? "png" : mimeType === "image/heic" ? "heic" : "jpg";
}

export async function POST(request: Request) {
  console.info("[deacon][uploads.prepare] POST started");
  const supabase = await getSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    console.warn("[deacon][uploads.prepare] unauthorized request");
    return NextResponse.json(
      { error: { code: "unauthorized", message: "Inicia sesión para cargar contenido." } },
      { status: 401 },
    );
  }

  let input: z.infer<typeof PrepareUploadSchema>;
  try {
    input = PrepareUploadSchema.parse(await request.json());
  } catch {
    console.warn("[deacon][uploads.prepare] validation failed");
    return NextResponse.json(
      { error: { code: "invalid_request", message: "Los datos del archivo no son válidos." } },
      { status: 400 },
    );
  }

  console.info("[deacon][uploads.prepare] validated input", {
    userId: user.id,
    sessionId: input.session_id,
    filename: input.filename,
    mimeType: input.mime_type,
    sizeBytes: input.size_bytes,
    fileHashPrefix: input.file_hash.slice(0, 8),
  });

  let sessionId = input.session_id ?? null;

  if (sessionId) {
    const { data: session } = await supabase
      .from("sessions")
      .select("id")
      .eq("id", sessionId)
      .eq("user_id", user.id)
      .is("deleted_at", null)
      .maybeSingle();

    if (!session) {
      console.warn("[deacon][uploads.prepare] session not found or not owned", {
        userId: user.id,
        sessionId,
      });
      return NextResponse.json(
        { error: { code: "session_not_found", message: "No se encontró la sesión de carga." } },
        { status: 404 },
      );
    }

    console.info("[deacon][uploads.prepare] session ownership verified", { sessionId });
  }

  const { data: existing } = await supabase
    .from("media_items")
    .select("id, original_filename, thumbnail_key, status")
    .eq("user_id", user.id)
    .eq("file_hash", input.file_hash)
    .is("deleted_at", null)
    .limit(1)
    .maybeSingle();

  if (existing) {
    console.info("[deacon][uploads.prepare] duplicate found", {
      existingMediaId: existing.id,
      userId: user.id,
    });
    return NextResponse.json({ duplicate: true, existing });
  }

  if (!sessionId) {
    const { data: session, error: sessionError } = await supabase
      .from("sessions")
      .insert({
        user_id: user.id,
        session_date: input.session_date ?? null,
      })
      .select("id")
      .single();

    if (sessionError || !session) {
      console.error("[deacon][uploads.prepare] automatic session creation failed", {
        code: sessionError?.code,
        message: sessionError?.message,
        details: sessionError?.details,
        hint: sessionError?.hint,
        userId: user.id,
      });
      return NextResponse.json(
        { error: { code: "session_create_failed", message: "No se pudo crear la sesión de carga." } },
        { status: 500 },
      );
    }

    sessionId = session.id;
    console.info("[deacon][uploads.prepare] automatic session created", { sessionId });
  }

  const mediaId = crypto.randomUUID();
  const extension = getExtension(input.filename, input.mime_type);
  const kind = input.mime_type === "application/pdf" ? "document" : "image";
  const storageKey = `users/${user.id}/${mediaId}/original.${extension}`;

  console.info("[deacon][uploads.prepare] inserting media row", {
    mediaId,
    kind,
    mimeType: input.mime_type,
    storageKey,
  });

  const { data: media, error } = await supabase
    .from("media_items")
    .insert({
      id: mediaId,
      user_id: user.id,
      session_id: sessionId,
      kind,
      storage_key: storageKey,
      mime_type: input.mime_type,
      original_filename: input.filename,
      size_bytes: input.size_bytes,
      file_hash: input.file_hash,
      status: "uploading",
      processing_stage: "queued",
      processing_progress: 0,
    })
    .select("id, storage_key, session_id, status, processing_stage, processing_progress")
    .single();

  if (error) {
    console.error("[deacon][uploads.prepare] media insert failed", {
      code: error.code,
      message: error.message,
      details: error.details,
      hint: error.hint,
      mediaId,
      kind,
      mimeType: input.mime_type,
      userId: user.id,
    });
    return NextResponse.json(
      { error: { code: "media_create_failed", message: "No se pudo preparar la carga." } },
      { status: 500 },
    );
  }

  console.info("[deacon][uploads.prepare] media row created", {
    mediaId: media.id,
    storageKey: media.storage_key,
    status: media.status,
  });
  return NextResponse.json({ duplicate: false, media });
}
