import Link from "next/link";
import { AuthErrorRedirect } from "@/components/auth/auth-error-redirect";

export default function Home() {
  return (
    <main className="shell">
      <AuthErrorRedirect />
      <p className="eyebrow">Deacon · biblioteca de estudio</p>
      <h1>Vuelve a la idea exacta cuando la necesites.</h1>
      <p className="lede">
        Guarda las imágenes, transcripciones y notas de tus clases. Deacon las
        organiza y las convierte en una biblioteca que puedes buscar y repasar.
      </p>
      <div className="status-card" aria-live="polite">
        <span className="status-dot" />
        <span>Tu espacio privado para estudiar con más memoria y menos fricción.</span>
      </div>
      <div className="home-actions">
        <Link className="primary-button" href="/login">Abrir Deacon</Link>
        <Link className="text-link" href="/library">
          Ir a la biblioteca →
        </Link>
      </div>
    </main>
  );
}
