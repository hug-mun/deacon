"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { appPath } from "@/lib/app-path";

type ProcessingStatusProps = {
  mediaId: string;
  initialStatus: string;
  initialStage: string;
  initialProgress: number;
  initialErrorCode: string | null;
  initialErrorMessage?: string | null;
  initialErrorRequestId?: string | null;
};

const ACTIVE_STATUSES = new Set(["uploading", "processing"]);

function stageLabel(status: string, stage: string) {
  if (status === "ready") return "Lista";
  if (status === "failed") return "No se pudo preparar";
  if (status === "uploading") return "Cargando archivo";

  return {
    queued: "En cola",
    reading: "Leyendo el PDF",
    saving: "Guardando la transcripción",
    embedding: "Mejorando la búsqueda",
  }[stage] ?? "Preparando contenido";
}

function errorLabel(errorCode: string | null) {
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
}: ProcessingStatusProps) {
  const router = useRouter();
  const [isRetrying, setIsRetrying] = useState(false);
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

  const progress = Math.max(0, Math.min(100, state.progress ?? 0));
  const label = stageLabel(state.status, state.stage);

  async function retry() {
    setIsRetrying(true);
    try {
      const response = await fetch(appPath(`/api/media/${mediaId}/retry`), { method: "POST" });
      if (!response.ok) return;
      setState({ status: "processing", stage: "queued", progress: 0, errorCode: null, errorMessage: null, errorRequestId: null });
    } finally {
      setIsRetrying(false);
    }
  }

  return (
    <div className={`processing-status processing-status-${state.status}`}>
      <div className="processing-status-line">
        <span>{label}</span>
        {ACTIVE_STATUSES.has(state.status) ? <strong>{progress}%</strong> : null}
      </div>
      {ACTIVE_STATUSES.has(state.status) ? (
        <div
          className="processing-progress"
          role="progressbar"
          aria-label={`Progreso: ${progress}%`}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={progress}
        >
          <span style={{ width: `${progress}%` }} />
        </div>
      ) : null}
      {state.status === "failed" && state.errorCode ? (
        <>
          <small>{errorLabel(state.errorCode)}</small>
          {state.errorMessage ? <small>{state.errorMessage}</small> : null}
          {state.errorRequestId ? <small>Solicitud: {state.errorRequestId}</small> : null}
          <button type="button" className="processing-retry" onClick={retry} disabled={isRetrying}>
            {isRetrying ? "Reintentando…" : "Reintentar"}
          </button>
        </>
      ) : null}
    </div>
  );
}
