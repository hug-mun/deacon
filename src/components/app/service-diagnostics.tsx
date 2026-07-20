"use client";

import { useCallback, useEffect, useState } from "react";
import { appPath } from "@/lib/app-path";

type Check = { service: string; status: string; message: string; code?: string; requestId?: string | null };

const labels: Record<string, string> = {
  app: "Aplicación",
  supabase_database: "Base de datos",
  supabase_storage: "Almacenamiento",
  openai_api: "OpenAI API",
  openai_vision: "OpenAI visión",
  media_worker: "Worker de archivos",
  mcp: "MCP / ChatGPT",
};

export function ServiceDiagnostics() {
  const [checks, setChecks] = useState<Check[]>([]);
  const [isChecking, setIsChecking] = useState(false);
  const [deep, setDeep] = useState(false);

  const run = useCallback(async (deepCheck: boolean) => {
    setIsChecking(true);
    setDeep(deepCheck);
    try {
      const response = await fetch(appPath(`/api/diagnostics${deepCheck ? "?deep=1" : ""}`), { cache: "no-store" });
      const body = await response.json();
      if (response.ok) setChecks(body.services ?? []);
    } finally {
      setIsChecking(false);
    }
  }, []);

  // The request is an external synchronization; defer it past the effect body.
  useEffect(() => {
    const timer = window.setTimeout(() => void run(false), 0);
    return () => window.clearTimeout(timer);
  }, [run]);

  return (
    <details className="service-diagnostics">
      <summary>
        <div className="service-diagnostics-heading">
          <p className="eyebrow">Estado del sistema</p>
          <h2 id="diagnostics-heading">Servicios</h2>
        </div>
        <span className="diagnostics-summary-status">{checks.length > 0 ? "Disponible" : "Comprobando…"}</span>
      </summary>
      <div className="service-diagnostics-content" aria-labelledby="diagnostics-heading">
        <div className="service-diagnostics-actions">
          <span>Diagnóstico técnico</span>
          <button className="secondary-button diagnostics-button" type="button" onClick={() => void run(true)} disabled={isChecking}>
            {isChecking && deep ? "Revisando IA…" : "Revisar IA"}
          </button>
        </div>
        {checks.length > 0 ? (
          <div className="service-diagnostics-grid">
            {checks.map((check) => (
              <div className={`service-check service-check-${check.status}`} key={check.service}>
                <div><strong>{labels[check.service] ?? check.service}</strong><span>{check.status}</span></div>
                <small>{check.message}</small>
                {check.requestId ? <small>Solicitud: {check.requestId}</small> : null}
              </div>
            ))}
          </div>
        ) : <p>Comprobando servicios…</p>}
      </div>
    </details>
  );
}
