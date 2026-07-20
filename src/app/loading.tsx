export default function Loading() {
  return (
    <main className="app-loading-shell" aria-live="polite">
      <div className="app-loading-card">
        <span className="loading-spinner" aria-hidden="true" />
        <p>Cargando tu biblioteca…</p>
      </div>
    </main>
  );
}
