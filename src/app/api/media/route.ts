import { NextResponse } from "next/server";
import { getSupabaseServerClient } from "@/lib/supabase/server";

const PAGE_SIZE = 24;

const MEDIA_FIELDS =
  "id, original_filename, storage_key, status, kind, processing_stage, processing_progress, processing_error_code, processing_error_service, processing_error_message, processing_error_request_id, image_title_en, image_title_es, image_description, image_ocr_text, created_at";

function decodeCursor(value: string | null) {
  if (!value) return null;
  try {
    const decoded = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as { createdAt?: string; id?: string };
    if (!decoded.createdAt || !decoded.id) return null;
    return decoded as { createdAt: string; id: string };
  } catch {
    return null;
  }
}

function encodeCursor(item: { created_at: string; id: string }) {
  return Buffer.from(JSON.stringify({ createdAt: item.created_at, id: item.id })).toString("base64url");
}

export async function GET(request: Request) {
  const supabase = await getSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json(
      { error: { code: "unauthorized", message: "Inicia sesión para abrir tu biblioteca." } },
      { status: 401 },
    );
  }

  const searchParams = new URL(request.url).searchParams;
  const cursor = decodeCursor(searchParams.get("cursor"));

  let mediaQuery = supabase
    .from("media_items")
    .select(MEDIA_FIELDS)
    .eq("user_id", user.id)
    .is("deleted_at", null)
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .range(0, PAGE_SIZE);

  if (cursor) {
    mediaQuery = mediaQuery.or(
      `created_at.lt.${cursor.createdAt},and(created_at.eq.${cursor.createdAt},id.lt.${cursor.id})`,
    );
  }

  const { data: mediaItems, error } = await mediaQuery;

  if (error) {
    console.error("[deacon][media.list] query failed", {
      code: error.code,
      message: error.message,
      userId: user.id,
      cursor: cursor ? "present" : "initial",
    });
    return NextResponse.json(
      { error: { code: "media_list_failed", message: "No se pudo cargar más contenido." } },
      { status: 500 },
    );
  }

  const hasMore = (mediaItems ?? []).length > PAGE_SIZE;
  const pageItems = (mediaItems ?? []).slice(0, PAGE_SIZE);
  const nextCursor = pageItems.length > 0 ? encodeCursor(pageItems[pageItems.length - 1]) : null;
  const media = await Promise.all(
    pageItems.map(async (item) => {
      const { data: signedUrl } = await supabase.storage
        .from("media")
        .createSignedUrl(item.storage_key, 300);

      return {
        ...item,
        signedUrl: signedUrl?.signedUrl ?? null,
      };
    }),
  );

  return NextResponse.json(
    { media, hasMore, nextCursor },
    { headers: { "Cache-Control": "private, no-store" } },
  );
}
