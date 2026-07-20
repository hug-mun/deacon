"use client";

import { SyntheticEvent, useCallback, useEffect, useRef, useState } from "react";
import { MediaProcessingStatus } from "@/components/library/media-processing-status";
import { appPath } from "@/lib/app-path";

type PdfReaderProps = {
  mediaId: string;
  filename: string;
  status: string;
  processingStage: string;
  processingProgress: number;
  processingErrorCode: string | null;
  processingErrorMessage?: string | null;
  processingErrorRequestId?: string | null;
  transcript?: string | null;
};

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function HighlightedTranscript({ text, query }: { text: string; query: string | null }) {
  const terms = (query ?? "").split(/\s+/).map((term) => term.trim()).filter((term) => term.length > 2);
  if (terms.length === 0) return <>{text}</>;

  const pattern = new RegExp(`(${terms.map(escapeRegExp).join("|")})`, "gi");
  return <>{text.split(pattern).map((part, index) => {
    const isMatch = terms.some((term) => part.toLocaleLowerCase() === term.toLocaleLowerCase());
    return isMatch ? <mark key={`${part}-${index}`}>{part}</mark> : <span key={`${part}-${index}`}>{part}</span>;
  })}</>;
}

export function PdfReader({
  mediaId,
  filename,
  status,
  processingStage,
  processingProgress,
  processingErrorCode,
  processingErrorMessage = null,
  processingErrorRequestId = null,
  transcript: initialTranscript = null,
}: PdfReaderProps) {
  const readerRef = useRef<HTMLDetailsElement>(null);
  const transcriptContentRef = useRef<HTMLDivElement>(null);
  const [transcript, setTranscript] = useState<string | null>(initialTranscript);
  const [isLoadingTranscript, setIsLoadingTranscript] = useState(false);
  const [transcriptError, setTranscriptError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState<string | null>(null);
  const [focusCharStart, setFocusCharStart] = useState<number | null>(null);

  const loadTranscript = useCallback(async () => {
    if (transcript !== null || isLoadingTranscript || status !== "ready") return;

    setIsLoadingTranscript(true);
    setTranscriptError(null);
    try {
      const response = await fetch(appPath(`/api/media/${mediaId}/transcript`), { cache: "no-store" });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error?.message ?? "No se pudo cargar la transcripción.");
      setTranscript(body.full_text ?? "");
    } catch (error) {
      setTranscriptError(error instanceof Error ? error.message : "No se pudo cargar la transcripción.");
    } finally {
      setIsLoadingTranscript(false);
    }
  }, [isLoadingTranscript, mediaId, status, transcript]);

  function handleToggle(event: SyntheticEvent<HTMLDetailsElement>) {
    if (event.currentTarget.open) void loadTranscript();
  }

  useEffect(() => {
    function handleOpenMedia(event: Event) {
      const detail = (event as CustomEvent<{ mediaId?: string; query?: string; charStart?: number | null }>).detail;
      if (detail.mediaId !== mediaId) return;
      setSearchQuery(detail.query ?? null);
      setFocusCharStart(detail.charStart ?? null);
      readerRef.current?.setAttribute("open", "");
      window.requestAnimationFrame(() => readerRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }));
    }

    window.addEventListener("deacon:open-media", handleOpenMedia);
    return () => window.removeEventListener("deacon:open-media", handleOpenMedia);
  }, [loadTranscript, mediaId]);

  useEffect(() => {
    if (transcript === null || focusCharStart === null || !transcriptContentRef.current) return;
    const content = transcriptContentRef.current;
    const ratio = Math.max(0, Math.min(1, focusCharStart / Math.max(transcript.length, 1)));
    window.requestAnimationFrame(() => {
      content.scrollTo({
        top: Math.max(0, ratio * content.scrollHeight - content.clientHeight * 0.25),
        behavior: "smooth",
      });
    });
  }, [focusCharStart, transcript]);

  function closeReader() {
    readerRef.current?.removeAttribute("open");
    readerRef.current?.querySelector("summary")?.focus();
  }

  return (
    <details className="media-reader" id={`media-${mediaId}`} name="knowledge-document" ref={readerRef} onToggle={handleToggle}>
      <summary className="media-reader-summary">
        <div className="document-placeholder">
          <strong>PDF</strong>
          <span>{isLoadingTranscript ? "Abriendo…" : status === "ready" ? "Toca para leer" : "Preparando texto"}</span>
        </div>
        <div className="media-card-body">
          <strong>{filename}</strong>
          <MediaProcessingStatus
            mediaId={mediaId}
            initialStatus={status}
            initialStage={processingStage}
            initialProgress={processingProgress}
            initialErrorCode={processingErrorCode}
            initialErrorMessage={processingErrorMessage}
            initialErrorRequestId={processingErrorRequestId}
          />
        </div>
      </summary>
      <div className="transcript-reader">
        <div className="transcript-reader-heading">
          <p className="eyebrow">Transcripción completa</p>
          <h3>{filename}</h3>
        </div>
        <div className="transcript-content" ref={transcriptContentRef}>
          {transcriptError ? (
            <p className="transcript-error">{transcriptError}</p>
          ) : transcript !== null ? (
            transcript.length > 0 ? (
              <p><HighlightedTranscript text={transcript} query={searchQuery} /></p>
            ) : (
              <p>El PDF no contiene texto extraíble.</p>
            )
          ) : (
            <p>{isLoadingTranscript ? "Cargando esta transcripción…" : "Abre este PDF para cargar su transcripción."}</p>
          )}
        </div>
        <div className="transcript-reader-actions">
          {transcript !== null ? (
            <a className="transcript-download" href={appPath(`/api/media/${mediaId}/transcript?download=1`)}>
              Descargar texto
            </a>
          ) : null}
          <button type="button" className="transcript-close" onClick={closeReader}>
            Cerrar
          </button>
        </div>
      </div>
    </details>
  );
}
