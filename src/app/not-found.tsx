import Link from "next/link";

export default function NotFound() {
  return (
    <main className="app-error-shell">
      <div className="app-error-card">
        <p className="eyebrow">Deacon</p>
        <h1>No encontramos esa página.</h1>
        <p>Puede que el contenido se haya movido o que el enlace ya no esté disponible.</p>
        <Link className="app-error-link" href="/library">
          Volver a la biblioteca
        </Link>
      </div>
    </main>
  );
}
