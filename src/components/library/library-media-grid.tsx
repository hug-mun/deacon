"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ImageViewer } from "@/components/library/image-viewer";
import { MediaProcessingStatus } from "@/components/library/media-processing-status";
import { PdfReader } from "@/components/library/pdf-reader";
import { appPath } from "@/lib/app-path";

type MediaItem = {
  id: string;
  original_filename: string;
  storage_key: string;
  status: string;
  kind: string;
  processing_stage: string;
  processing_progress: number;
  processing_error_code: string | null;
  processing_error_service: string | null;
  processing_error_message: string | null;
  processing_error_request_id: string | null;
  image_title_en: string | null;
  image_title_es: string | null;
  image_description: string | null;
  image_ocr_text: string | null;
  created_at: string;
  signedUrl: string | null;
};

type LibraryMediaGridProps = {
  initialMedia: MediaItem[];
  initialHasMore: boolean;
  initialCursor: string | null;
};

type OpenRequest = {
  mediaId: string;
  query: string;
  charStart: number | null;
};

function MediaCard({ item }: { item: MediaItem }) {
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

  const title = item.image_title_es ?? item.image_title_en ?? item.original_filename;

  return (
    <article className="media-card" id={`media-${item.id}`}>
      {item.signedUrl ? (
        <ImageViewer
          mediaId={item.id}
          src={item.signedUrl}
          alt={title}
          title={title}
          englishTitle={item.image_title_en}
        />
      ) : (
        <div className="media-placeholder">Vista previa no disponible</div>
      )}
      <div className="media-card-body">
        <strong>{title}</strong>
        {item.image_title_en && item.image_title_es ? <small className="media-card-title-en">{item.image_title_en}</small> : null}
        {item.image_description ? <p>{item.image_description}</p> : null}
        {status}
      </div>
    </article>
  );
}

export function LibraryMediaGrid({ initialMedia, initialHasMore, initialCursor }: LibraryMediaGridProps) {
  const [media, setMedia] = useState(initialMedia);
  const [hasMore, setHasMore] = useState(initialHasMore);
  const [cursor, setCursor] = useState(initialCursor);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pendingOpen, setPendingOpen] = useState<OpenRequest | null>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    async function openRequestedItem(event: Event) {
      const detail = (event as CustomEvent<{ mediaId?: string; query?: string; charStart?: number | null }>).detail;
      if (!detail.mediaId || media.some((item) => item.id === detail.mediaId)) return;

      try {
        const response = await fetch(appPath(`/api/media/${detail.mediaId}`), { cache: "no-store" });
        const body = await response.json();
        if (!response.ok || !body.media) return;
        setMedia((current) => [body.media, ...current.filter((item) => item.id !== body.media.id)]);
        setPendingOpen({ mediaId: body.media.id, query: detail.query ?? "", charStart: detail.charStart ?? null });
      } catch {
        // The search result remains available if the item cannot be opened right now.
      }
    }

    window.addEventListener("deacon:load-media", openRequestedItem);
    return () => window.removeEventListener("deacon:load-media", openRequestedItem);
  }, [media]);

  useEffect(() => {
    if (!pendingOpen) return;
    const target = document.getElementById(`media-${pendingOpen.mediaId}`);
    if (!target) return;

    target.scrollIntoView({ behavior: "smooth", block: "center" });
    if (target.matches("details")) {
      window.dispatchEvent(new CustomEvent("deacon:open-media", {
        detail: pendingOpen,
      }));
    } else {
      window.dispatchEvent(new CustomEvent("deacon:open-image", {
        detail: { mediaId: pendingOpen.mediaId },
      }));
    }
    window.setTimeout(() => setPendingOpen(null), 0);
  }, [media, pendingOpen]);

  const loadMore = useCallback(async () => {
    if (isLoading || !hasMore) return;
    setIsLoading(true);
    setError(null);

    try {
      const query = cursor ? `?cursor=${encodeURIComponent(cursor)}` : "";
      const response = await fetch(appPath(`/api/media${query}`), { cache: "no-store" });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error?.message ?? "No se pudo cargar más contenido.");
      setMedia((current) => [...current, ...(body.media ?? [])]);
      setHasMore(Boolean(body.hasMore));
      setCursor(body.nextCursor ?? null);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "No se pudo cargar más contenido.");
    } finally {
      setIsLoading(false);
    }
  }, [cursor, hasMore, isLoading]);

  useEffect(() => {
    const sentinel = sentinelRef.current;
    if (!sentinel || !hasMore) return;

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) void loadMore();
      },
      { rootMargin: "700px 0px" },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [hasMore, loadMore]);

  return (
    <>
      <div className="media-grid">
        {media.map((item) => <MediaCard key={item.id} item={item} />)}
      </div>
      {hasMore ? (
        <div className="media-load-more">
          <div ref={sentinelRef} className="media-load-sentinel" aria-hidden="true" />
          <button type="button" onClick={loadMore} disabled={isLoading}>
            {isLoading ? "Cargando…" : "Cargar más"}
          </button>
          {error ? <p role="alert">{error}</p> : null}
        </div>
      ) : null}
    </>
  );
}
