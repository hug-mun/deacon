import { redirect } from "next/navigation";
import { AppNav } from "@/components/app/app-nav";
import { InlineSearch } from "@/components/search/inline-search";
import { UploadPanel } from "@/components/upload/upload-panel";
import { LibraryMediaGrid } from "@/components/library/library-media-grid";
import { getSupabaseServerClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

const PAGE_SIZE = 24;

function encodeCursor(item: { created_at: string; id: string }) {
  return Buffer.from(JSON.stringify({ createdAt: item.created_at, id: item.id })).toString("base64url");
}

export default async function LibraryPage() {
  const supabase = await getSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login?reason=session_missing");
  }

  const { data: mediaItems } = await supabase
    .from("media_items")
    .select(
      "id, original_filename, storage_key, status, kind, processing_stage, processing_progress, processing_error_code, processing_error_service, processing_error_message, processing_error_request_id, image_title_en, image_title_es, image_description, image_ocr_text, created_at",
    )
    .eq("user_id", user.id)
    .is("deleted_at", null)
    .order("created_at", { ascending: false })
    .range(0, PAGE_SIZE);

  const hasMore = (mediaItems ?? []).length > PAGE_SIZE;
  const firstPageItems = (mediaItems ?? []).slice(0, PAGE_SIZE);
  const initialCursor = firstPageItems.length > 0 ? encodeCursor(firstPageItems[firstPageItems.length - 1]) : null;
  const media = await Promise.all(
    firstPageItems.map(async (item) => {
      const { data: signedUrl } = await supabase.storage
        .from("media")
        .createSignedUrl(item.storage_key, 300);

      return {
        ...item,
        signedUrl: signedUrl?.signedUrl ?? null,
      };
    }),
  );

  return (
    <main className="library-shell">
      <AppNav />
      <header className="library-header">
        <div>
          <p className="eyebrow">Biblioteca</p>
          <h1>Tu biblioteca.</h1>
          <p className="lede">Tus imágenes, transcripciones y notas en un solo lugar.</p>
        </div>
        <UploadPanel />
      </header>
      <InlineSearch />
      {media.length > 0 ? (
        <section className="media-section" aria-labelledby="media-heading">
          <div className="section-heading">
            <p className="eyebrow">Contenido reciente</p>
            <h2 id="media-heading">Contenido reciente</h2>
          </div>
          <LibraryMediaGrid initialMedia={media} initialHasMore={hasMore} initialCursor={initialCursor} />
        </section>
      ) : null}
    </main>
  );
}
