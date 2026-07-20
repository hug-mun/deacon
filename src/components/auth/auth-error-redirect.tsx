"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { appPath } from "@/lib/app-path";

export function AuthErrorRedirect() {
  const router = useRouter();

  useEffect(() => {
    const hash = window.location.hash.replace(/^#/, "");
    if (!hash) return;

    const params = new URLSearchParams(hash);
    const error = params.get("error");
    const errorCode = params.get("error_code");
    if (!error && !errorCode) return;

    const reason = errorCode ?? error ?? "recovery_failed";
    router.replace(appPath(`/forgot-password?reason=${encodeURIComponent(reason)}`));
  }, [router]);

  return null;
}
