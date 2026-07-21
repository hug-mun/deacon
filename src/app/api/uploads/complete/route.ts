import { after, NextResponse } from "next/server";
import { z } from "zod";
import { getSupabaseServerClient } from "@/lib/supabase/server";

const CompleteUploadSchema = z.object({
  media_id: z.string().uuid(),
});

export async function POST(request: Request) {
  console.info("[deacon][uploads.complete] POST started");
  const supabase = await getSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    console.warn("[deacon][uploads.complete] unauthorized request");
    return NextResponse.json(
      { error: { code: "unauthorized", message: "Inicia sesión para completar una carga." } },
      { status: 401 },
    );
  }

  let input: z.infer<typeof CompleteUploadSchema>;
  try {
    input = CompleteUploadSchema.parse(await request.json());
  } catch {
    console.warn("[deacon][uploads.complete] validation failed");
    return NextResponse.json(
      { error: { code: "invalid_request", message: "El identificador del contenido no es válido." } },
      { status: 400 },
    );
  }

  console.info("[deacon][uploads.complete] validated input", {
    mediaId: input.media_id,
    userId: user.id,
  });

  const { data: media } = await supabase
    .from("media_items")
    .select("id, storage_key, status")
    .eq("id", input.media_id)
    .eq("user_id", user.id)
    .is("deleted_at", null)
    .maybeSingle();

  if (!media) {
    console.warn("[deacon][uploads.complete] media not found or not owned", {
      mediaId: input.media_id,
      userId: user.id,
    });
    return NextResponse.json(
      { error: { code: "media_not_found", message: "No se encontró el contenido." } },
      { status: 404 },
    );
  }

  console.info("[deacon][uploads.complete] media found", media);

  if (media.status === "processing" || media.status === "ready") {
    return NextResponse.json({ status: media.status, media_id: media.id });
  }

  const pathParts = media.storage_key.split("/");
  const filename = pathParts.pop();
  const folder = pathParts.join("/");
  const { data: objects, error: storageError } = await supabase.storage
    .from("media")
    .list(folder, { limit: 100, search: filename });

  if (storageError || !filename || !objects?.some((object) => object.name === filename)) {
    console.error("[deacon][uploads.complete] storage object verification failed", {
      storageError: storageError
        ? {
            message: storageError.message,
            name: storageError.name,
          }
        : null,
      storageKey: media.storage_key,
      filename,
      objectCount: objects?.length ?? 0,
    });
    return NextResponse.json(
      { error: { code: "object_not_found", message: "No se encontró el archivo cargado en el almacenamiento." } },
      { status: 400 },
    );
  }

  const { error } = await supabase
    .from("media_items")
    .update({
      status: "processing",
      processing_stage: "queued",
      processing_progress: 0,
      processing_error_code: null,
      processing_error_service: null,
      processing_error_message: null,
      processing_error_request_id: null,
    })
    .eq("id", media.id)
    .eq("user_id", user.id);

  if (error) {
    console.error("[deacon][uploads.complete] status update failed", {
      code: error.code,
      message: error.message,
      details: error.details,
      hint: error.hint,
      mediaId: media.id,
    });
    return NextResponse.json(
      { error: { code: "media_finalize_failed", message: "No se pudo finalizar la carga." } },
      { status: 500 },
    );
  }

  console.info("[deacon][uploads.complete] finalized", {
    mediaId: media.id,
    status: "processing",
  });

  // Start the first processing pass immediately. The Vercel cron remains the
  // safety net for queued files and retries, so a user does not wait for the
  // next minute tick after a successful upload.
  after(async () => {
    try {
      // @ts-expect-error The worker is an ESM module shared with the Docker runtime.
      const { runWorkerOnce } = await import("../../../../../scripts/process-media.mjs");
      await runWorkerOnce();
    } catch (error) {
      console.error("[deacon][uploads.complete] immediate processing failed", {
        mediaId: media.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  return NextResponse.json({ status: "processing", media_id: media.id });
}
