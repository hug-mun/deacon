"use client";

import { SyntheticEvent, useCallback, useEffect, useRef, useState } from "react";
import { MediaProcessingStatus } from "@/components/library/media-processing-status";
import { appPath } from "@/lib/app-path";

type VideoPlayerProps = {
  mediaId: string;
  filename: string;
  status: string;
  processingStage: string;
  processingProgress: number;
  processingErrorCode: string | null;
  processingErrorMessage?: string | null;
  processingErrorRequestId?: string | null;
  onDelete?: () => void;
};

function formatTimestamp(ms: number) {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

export function VideoPlayer({
  mediaId,
  filename,
  status,
  processingStage,
  processingProgress,
  processingErrorCode,
  processingErrorMessage = null,
  processingErrorRequestId = null,
  onDelete,
}: VideoPlayerProps) {
  const playerRef = useRef<HTMLDetailsElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const pendingSeekMs = useRef<number | null>(null);
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  const [isLoadingVideo, setIsLoadingVideo] = useState(false);
  const [videoError, setVideoError] = useState<string | null>(null);
  const [seekNotice, setSeekNotice] = useState<number | null>(null);

  const loadVideo = useCallback(async () => {
    if (videoUrl !== null || isLoadingVideo) return;

    setIsLoadingVideo(true);
    setVideoError(null);
    try {
      const response = await fetch(appPath(`/api/media/${mediaId}`), { cache: "no-store" });
      const body = await response.json();
      if (!response.ok || !body.media?.signedUrl) {
        throw new Error(body.error?.message ?? "No se pudo cargar el video.");
      }
      setVideoUrl(body.media.signedUrl);
    } catch (error) {
      setVideoError(error instanceof Error ? error.message : "No se pudo cargar el video.");
    } finally {
      setIsLoadingVideo(false);
    }
  }, [isLoadingVideo, mediaId, videoUrl]);

  function handleToggle(event: SyntheticEvent<HTMLDetailsElement>) {
    if (event.currentTarget.open) void loadVideo();
  }

  const seekTo = useCallback((startMs: number) => {
    const video = videoRef.current;
    if (!video) {
      pendingSeekMs.current = startMs;
      return;
    }
    const apply = () => {
      video.currentTime = startMs / 1000;
      void video.play().catch(() => {});
    };
    if (video.readyState >= 1) apply();
    else video.addEventListener("loadedmetadata", apply, { once: true });
  }, []);

  useEffect(() => {
    function handleOpenMedia(event: Event) {
      const detail = (event as CustomEvent<{ mediaId?: string; startMs?: number | null }>).detail;
      if (detail.mediaId !== mediaId) return;
      playerRef.current?.setAttribute("open", "");
      void loadVideo();
      if (typeof detail.startMs === "number") {
        setSeekNotice(detail.startMs);
        seekTo(detail.startMs);
      }
      window.requestAnimationFrame(() => playerRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }));
    }

    window.addEventListener("deacon:open-media", handleOpenMedia);
    return () => window.removeEventListener("deacon:open-media", handleOpenMedia);
  }, [loadVideo, mediaId, seekTo]);

  // A seek requested before the video element existed applies once the URL loads.
  useEffect(() => {
    if (videoUrl !== null && pendingSeekMs.current !== null) {
      const startMs = pendingSeekMs.current;
      pendingSeekMs.current = null;
      window.requestAnimationFrame(() => seekTo(startMs));
    }
  }, [seekTo, videoUrl]);

  function closePlayer() {
    videoRef.current?.pause();
    playerRef.current?.removeAttribute("open");
    playerRef.current?.querySelector("summary")?.focus();
  }

  return (
    <details className="media-reader" id={`media-${mediaId}`} name="knowledge-document" ref={playerRef} onToggle={handleToggle}>
      <summary className="media-reader-summary">
        <div className="document-placeholder">
          <strong>VIDEO</strong>
          <span>{isLoadingVideo ? "Abriendo…" : status === "ready" ? "Toca para ver" : "Preparando video"}</span>
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
            onDelete={onDelete}
          />
        </div>
      </summary>
      <div className="transcript-reader">
        <div className="transcript-reader-heading">
          <p className="eyebrow">Video</p>
          <h3>{filename}</h3>
          {seekNotice !== null ? (
            <p className="video-seek-notice">Reproduciendo desde {formatTimestamp(seekNotice)}</p>
          ) : null}
        </div>
        {videoError ? (
          <p className="transcript-error">{videoError}</p>
        ) : videoUrl ? (
          <video ref={videoRef} className="video-player" src={videoUrl} controls playsInline preload="metadata" />
        ) : (
          <p>{isLoadingVideo ? "Cargando este video…" : "Abre este video para reproducirlo."}</p>
        )}
        <div className="transcript-reader-actions">
          <a className="transcript-download" href={appPath(`/api/media/${mediaId}/transcript?download=1`)}>
            Descargar transcripción
          </a>
          {onDelete ? (
            <button type="button" className="media-delete-button" onClick={onDelete}>
              Borrar contenido
            </button>
          ) : null}
          <button type="button" className="transcript-close" onClick={closePlayer}>
            Cerrar
          </button>
        </div>
      </div>
    </details>
  );
}
