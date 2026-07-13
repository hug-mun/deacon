import { NextResponse } from "next/server";
import { z } from "zod";
import { getSupabaseServerClient } from "@/lib/supabase/server";

const CompleteUploadSchema = z.object({
  media_id: z.string().uuid(),
});

export async function POST(request: Request) {
  const supabase = await getSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json(
      { error: { code: "unauthorized", message: "Sign in to complete an upload." } },
      { status: 401 },
    );
  }

  let input: z.infer<typeof CompleteUploadSchema>;
  try {
    input = CompleteUploadSchema.parse(await request.json());
  } catch {
    return NextResponse.json(
      { error: { code: "invalid_request", message: "The media id is invalid." } },
      { status: 400 },
    );
  }

  const { data: media } = await supabase
    .from("media_items")
    .select("id, storage_key, status")
    .eq("id", input.media_id)
    .eq("user_id", user.id)
    .is("deleted_at", null)
    .maybeSingle();

  if (!media) {
    return NextResponse.json(
      { error: { code: "media_not_found", message: "The media item was not found." } },
      { status: 404 },
    );
  }

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
    return NextResponse.json(
      { error: { code: "object_not_found", message: "The uploaded image was not found in storage." } },
      { status: 400 },
    );
  }

  const { error } = await supabase
    .from("media_items")
    .update({ status: "processing" })
    .eq("id", media.id)
    .eq("user_id", user.id);

  if (error) {
    return NextResponse.json(
      { error: { code: "media_finalize_failed", message: "The upload could not be finalized." } },
      { status: 500 },
    );
  }

  return NextResponse.json({ status: "processing", media_id: media.id });
}
