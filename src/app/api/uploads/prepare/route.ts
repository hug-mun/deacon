import { NextResponse } from "next/server";
import { z } from "zod";
import { getSupabaseServerClient } from "@/lib/supabase/server";

const MAX_IMAGE_SIZE = 50 * 1024 * 1024;
const IMAGE_MIME_TYPES = ["image/jpeg", "image/png", "image/heic"] as const;

const PrepareUploadSchema = z.object({
  session_id: z.string().uuid(),
  filename: z.string().trim().min(1).max(255),
  mime_type: z.enum(IMAGE_MIME_TYPES),
  size_bytes: z.number().int().positive().max(MAX_IMAGE_SIZE),
  file_hash: z.string().regex(/^[a-f0-9]{64}$/i),
});

function getExtension(filename: string, mimeType: string) {
  const extension = filename.split(".").pop()?.toLowerCase();
  if (extension && ["jpg", "jpeg", "png", "heic"].includes(extension)) {
    return extension === "jpeg" ? "jpg" : extension;
  }

  return mimeType === "image/png" ? "png" : mimeType === "image/heic" ? "heic" : "jpg";
}

export async function POST(request: Request) {
  const supabase = await getSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json(
      { error: { code: "unauthorized", message: "Sign in to upload media." } },
      { status: 401 },
    );
  }

  let input: z.infer<typeof PrepareUploadSchema>;
  try {
    input = PrepareUploadSchema.parse(await request.json());
  } catch {
    return NextResponse.json(
      { error: { code: "invalid_request", message: "The image upload details are invalid." } },
      { status: 400 },
    );
  }

  const { data: session } = await supabase
    .from("sessions")
    .select("id")
    .eq("id", input.session_id)
    .eq("user_id", user.id)
    .is("deleted_at", null)
    .maybeSingle();

  if (!session) {
    return NextResponse.json(
      { error: { code: "session_not_found", message: "The upload session was not found." } },
      { status: 404 },
    );
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
    return NextResponse.json({ duplicate: true, existing });
  }

  const mediaId = crypto.randomUUID();
  const extension = getExtension(input.filename, input.mime_type);
  const storageKey = `users/${user.id}/${mediaId}/original.${extension}`;

  const { data: media, error } = await supabase
    .from("media_items")
    .insert({
      id: mediaId,
      user_id: user.id,
      session_id: input.session_id,
      kind: "image",
      storage_key: storageKey,
      mime_type: input.mime_type,
      original_filename: input.filename,
      size_bytes: input.size_bytes,
      file_hash: input.file_hash,
      status: "uploading",
    })
    .select("id, storage_key, status")
    .single();

  if (error) {
    return NextResponse.json(
      { error: { code: "media_create_failed", message: "The upload could not be prepared." } },
      { status: 500 },
    );
  }

  return NextResponse.json({ duplicate: false, media });
}
