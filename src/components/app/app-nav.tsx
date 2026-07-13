import Link from "next/link";

type NavSection = "library" | "search";

export function AppNav({ active = "library" }: { active?: NavSection }) {
  return (
    <nav className="app-nav" aria-label="Primary navigation">
      <Link className="nav-brand" href="/library">
        Deacon
      </Link>
      <div className="nav-links">
        <Link className={`nav-link ${active === "library" ? "active" : ""}`} href="/library">
          Library
        </Link>
        <Link className={`nav-link ${active === "search" ? "active" : ""}`} href="/search">
          Search
        </Link>
        <Link className="add-button" href="/library#upload-panel">
          <span aria-hidden="true">＋</span> Add
        </Link>
      </div>
    </nav>
  );
}
