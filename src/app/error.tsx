"use client";

import { useEffect } from "react";

export default function AppError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("[deacon][ui] route rendering failed", {
      message: error.message,
      digest: error.digest,
    });
  }, [error]);

  return (
    <main className="app-error-shell">
      <div className="app-error-card" role="alert">
        <p className="eyebrow">Deacon</p>
        <h1>Algo no salió bien.</h1>
        <p>
          La información no se perdió. Puedes intentar cargar esta pantalla otra vez o volver a tu biblioteca.
        </p>
        <div className="app-error-actions">
          <button type="button" onClick={() => reset()}>
            Intentar de nuevo
          </button>
          <a href="/library">Volver a la biblioteca</a>
        </div>
      </div>
    </main>
  );
}
