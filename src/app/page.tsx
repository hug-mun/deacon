import Link from "next/link";

export default function Home() {
  return (
    <main className="shell">
      <p className="eyebrow">Deacon</p>
      <h1>Your master classes, remembered.</h1>
      <p className="lede">
        Upload recordings, screenshots, and notes. Deacon will organize the
        material and make it searchable when processing is ready.
      </p>
      <div className="status-card" aria-live="polite">
        <span className="status-dot" />
        <span>Phase 0 foundation is ready to build on.</span>
      </div>
      <div className="home-actions">
        <Link className="primary-button" href="/login">
          Open Deacon
        </Link>
        <Link className="text-link" href="/library">
          Go to library →
        </Link>
      </div>
    </main>
  );
}
