"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { appPath } from "@/lib/app-path";
import { getProcessingProgress } from "@/lib/media/processing-progress";

type ProcessingStatusProps = {
  mediaId: string;
  initialStatus: string;
  initialStage: string;
  initialProgress: number;
  initialErrorCode: string | null;
  initialErrorMessage?: string | null;
  initialErrorRequestId?: string | null;
  onDelete?: () => void;
};

const ACTIVE_STATUSES = new Set(["uploading", "processing"]);

function stageLabel(status: string, stage: string) {
  if (status === "ready") return "Lista";
  if (status === "failed") return "No se pudo preparar";
  if (status === "uploading") return "Cargando archivo";

  return {
    queued: "Procesando",
    reading: "Leyendo el PDF",
    saving: "Guardando la transcripción",
    embedding: "Mejorando la búsqueda",
  }[stage] ?? "Preparando contenido";
}

function errorLabel(errorCode: string | null) {
  if (errorCode === "upload_incomplete") {
    return "La carga no terminó. Puedes borrarlo y volver a cargarlo.";
  }
  if (errorCode === "image_vision_permission_denied") {
    return "La clave de IA no tiene permiso para analizar imágenes."
  }
  if (errorCode === "image_format_unsupported") {
    return "Convierte esta imagen a JPG o PNG para analizarla."
  }
  return "No se pudo terminar este archivo."
}

export function MediaProcessingStatus({
  mediaId,
  initialStatus,
  initialStage,
  initialProgress,
  initialErrorCode,
  initialErrorMessage = null,
  initialErrorRequestId = null,
  onDelete,
}: ProcessingStatusProps) {
  const router = useRouter();
  const [isRetrying, setIsRetrying] = useState(false);
  const [retryError, setRetryError] = useState<string | null>(null);
  const [processingStartedAt, setProcessingStartedAt] = useState(() => Date.now());
  const [state, setState] = useState({
    status: initialStatus,
    stage: initialStage,
    progress: initialProgress,
    errorCode: initialErrorCode,
    errorMessage: initialErrorMessage,
    errorRequestId: initialErrorRequestId,
  });

  useEffect(() => {
    if (!ACTIVE_STATUSES.has(state.status)) return;

    let cancelled = false;
    async function refreshStatus() {
      try {
        const response = await fetch(appPath(`/api/media/${mediaId}/status`), {
          cache: "no-store",
        });
        if (!response.ok || cancelled) return;
        const next = await response.json();
        if (next.status === "processing" && state.status !== "processing") {
          setProcessingStartedAt(Date.now());
        }
        setState({
          status: next.status,
          stage: next.processing_stage,
          progress: next.processing_progress,
          errorCode: next.processing_error_code,
          errorMessage: next.processing_error_message,
          errorRequestId: next.processing_error_request_id,
        });
        if (next.status === "ready" || next.status === "failed") {
          router.refresh();
        }
      } catch {
        // The next polling cycle will retry. The current state remains visible.
      }
    }

    const interval = window.setInterval(refreshStatus, 1500);
    void refreshStatus();
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [mediaId, router, state.status]);

  const { progress, estimated } = getProcessingProgress({
    status: state.status,
    actualProgress: state.progress,
    startedAt: processingStartedAt,
  });
  const label = stageLabel(state.status, state.stage);

  async function retry() {
    setIsRetrying(true);
    setRetryError(null);
    try {
      const response = await fetch(appPath(`/api/media/${mediaId}/retry`), { method: "POST" });
      if (!response.ok) {
        setRetryError("No se pudo reintentar. Vuelve a intentarlo en un momento.");
        return;
      }
      setProcessingStartedAt(Date.now());
      setState({ status: "processing", stage: "queued", progress: 0, errorCode: null, errorMessage: null, errorRequestId: null });
    } finally {
      setIsRetrying(false);
    }
  }

  return (
    <div className={`processing-status processing-status-${state.status}`}>
      <div className="processing-status-line">
        <span>{label}</span>
        {ACTIVE_STATUSES.has(state.status) ? <strong>{estimated ? `${progress}% aprox.` : `${progress}%`}</strong> : null}
      </div>
      {ACTIVE_STATUSES.has(state.status) ? (
        <div
          className={`processing-progress${estimated ? " processing-progress-estimated" : ""}`}
          role="progressbar"
          aria-label={estimated ? `Progreso aproximado: ${progress}%` : `Progreso: ${progress}%`}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={progress}
        >
          <span style={{ width: `${progress}%` }} />
        </div>
      ) : null}
      {state.status === "failed" ? (
        <>
          <small>{errorLabel(state.errorCode)}</small>
          {state.errorMessage ? <small>{state.errorMessage}</small> : null}
          {state.errorRequestId ? <small>Solicitud: {state.errorRequestId}</small> : null}
          <div className="processing-actions">
            <button type="button" className="processing-retry" onClick={retry} disabled={isRetrying}>
              {isRetrying ? "Reintentando…" : "Reintentar"}
            </button>
            {onDelete ? (
              <button type="button" className="processing-delete" onClick={onDelete}>
                Borrar
              </button>
            ) : null}
          </div>
          {retryError ? <small>{retryError}</small> : null}
        </>
      ) : null}
    </div>
  );
}
