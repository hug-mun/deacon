"use client";

import { useRouter } from "next/navigation";
import { getSupabaseBrowserClient } from "@/lib/supabase/client";
import { appPath } from "@/lib/app-path";

export function SignOutButton() {
  const router = useRouter();

  async function handleSignOut() {
    await getSupabaseBrowserClient().auth.signOut();
    router.replace(appPath("/login"));
    router.refresh();
  }

  return (
    <button className="sign-out-button" type="button" onClick={handleSignOut}>
      Cerrar sesión
    </button>
  );
}
