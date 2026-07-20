import Link from "next/link";
import { SignOutButton } from "@/components/auth/sign-out-button";

export function AppNav() {
  return (
    <nav className="app-nav" aria-label="Navegación principal">
      <Link className="nav-brand" href="/library">
        <span className="brand-mark" aria-hidden="true">D</span>
        Deacon
      </Link>
      <div className="nav-actions">
        <SignOutButton />
      </div>
    </nav>
  );
}
