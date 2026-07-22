"use client";

import { useEffect, useState } from "react";
import { appPath } from "@/lib/app-path";

type TrashItem = {
  id: string;
  original_filename: string;
  kind: string;
  image_title_es: string | null;
  image_title_en: string | null;
  deleted_at: string;
};

export function TrashList() {
  const [items, setItems] = useState<TrashItem[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [restoringId, setRestoringId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void fetch(appPath("/api/media/trash"), { cache: "no-store" })
      .then(async (response) => {
        const body = await response.json();
        if (!response.ok) throw new Error(body.error?.message ?? "No se pudo cargar la papelera.");
        setItems(body.items ?? []);
      })
      .catch((loadError) => setError(loadError instanceof Error ? loadError.message : "No se pudo cargar la papelera."))
      .finally(() => setIsLoading(false));
  }, []);

  async function restore(item: TrashItem) {
    setRestoringId(item.id);
    setError(null);
    try {
      const response = await fetch(appPath(`/api/media/${item.id}`), { method: "POST" });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error?.message ?? "No se pudo recuperar el contenido.");
      setItems((current) => current.filter((candidate) => candidate.id !== item.id));
    } catch (restoreError) {
      setError(restoreError instanceof Error ? restoreError.message : "No se pudo recuperar el contenido.");
    } finally {
      setRestoringId(null);
    }
  }

  if (isLoading) {
    return <p className="trash-empty">Cargando papelera…</p>;
  }

  if (items.length === 0 && !error) {
    return <p className="trash-empty">No tienes contenido borrado recientemente.</p>;
  }

  return (
    <section className="trash-list" aria-label="Contenido borrado">
      {items.map((item) => (
        <article className="trash-item" key={item.id}>
          <div>
            <strong>{item.image_title_es ?? item.image_title_en ?? item.original_filename}</strong>
            <span>{item.kind === "document" ? "PDF" : "Imagen"} · Borrado el {new Date(item.deleted_at).toLocaleDateString("es-MX")}</span>
          </div>
          <button type="button" onClick={() => void restore(item)} disabled={restoringId === item.id}>
            {restoringId === item.id ? "Recuperando…" : "Recuperar"}
          </button>
        </article>
      ))}
      {error ? <p className="trash-error" role="alert">{error}</p> : null}
    </section>
  );
}
