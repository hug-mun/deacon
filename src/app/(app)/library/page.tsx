/* eslint-disable @next/next/no-img-element */
import { redirect } from "next/navigation";
import { AppNav } from "@/components/app/app-nav";
import { PdfReader } from "@/components/library/pdf-reader";
import { InlineSearch } from "@/components/search/inline-search";
import { MediaProcessingStatus } from "@/components/library/media-processing-status";
import { UploadPanel } from "@/components/upload/upload-panel";
import { getSupabaseServerClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

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
      "id, original_filename, storage_key, status, kind, processing_stage, processing_progress, processing_error_code, processing_error_service, processing_error_message, processing_error_request_id, image_description, image_ocr_text, created_at",
    )
    .eq("user_id", user.id)
    .is("deleted_at", null)
    .order("created_at", { ascending: false });

  const media = await Promise.all(
    (mediaItems ?? []).map(async (item) => {
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
          <div className="media-grid">
            {media.map((item) => {
              const status = (
                <MediaProcessingStatus
                  mediaId={item.id}
                  initialStatus={item.status}
                  initialStage={item.processing_stage}
                  initialProgress={item.processing_progress}
                  initialErrorCode={item.processing_error_code}
                  initialErrorMessage={item.processing_error_message}
                  initialErrorRequestId={item.processing_error_request_id}
                />
              );

              if (item.kind === "document") {
                return (
                  <PdfReader
                    key={item.id}
                    mediaId={item.id}
                    filename={item.original_filename}
                    status={item.status}
                    processingStage={item.processing_stage}
                    processingProgress={item.processing_progress}
                    processingErrorCode={item.processing_error_code}
                    processingErrorMessage={item.processing_error_message}
                    processingErrorRequestId={item.processing_error_request_id}
                  />
                );
              }

              return (
                <article className="media-card" id={`media-${item.id}`} key={item.id}>
                  {item.signedUrl ? (
                    <img src={item.signedUrl} alt={item.original_filename} />
                  ) : (
                    <div className="media-placeholder">Vista previa no disponible</div>
                  )}
                  <div className="media-card-body">
                    <strong>{item.original_filename}</strong>
                    {item.image_description ? <p>{item.image_description}</p> : null}
                    {status}
                  </div>
                </article>
              );
            })}
          </div>
        </section>
      ) : null}
    </main>
  );
}
