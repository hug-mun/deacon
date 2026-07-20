"use client";

import { FormEvent, useState } from "react";
import { useRouter } from "next/navigation";
import { getSupabaseBrowserClient } from "@/lib/supabase/client";
import { appPath } from "@/lib/app-path";

export function ResetPasswordForm() {
  const router = useRouter();
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);

    if (password.length < 8) {
      setError("La contraseña debe tener al menos 8 caracteres.");
      return;
    }
    if (password !== confirmation) {
      setError("Las contraseñas no coinciden.");
      return;
    }

    setIsSubmitting(true);
    const { error: updateError } = await getSupabaseBrowserClient().auth.updateUser({ password });
    setIsSubmitting(false);

    if (updateError) {
      setError("El enlace de recuperación expiró o ya fue utilizado. Solicita uno nuevo.");
      return;
    }

    router.replace(appPath("/login?reason=password_updated"));
  }

  return (
    <form className="auth-form" onSubmit={handleSubmit}>
      <label htmlFor="new-password">Nueva contraseña</label>
      <input
        id="new-password"
        type="password"
        autoComplete="new-password"
        placeholder="Al menos 8 caracteres"
        minLength={8}
        value={password}
        onChange={(event) => setPassword(event.target.value)}
        required
      />
      <label htmlFor="confirm-password">Repite la contraseña</label>
      <input
        id="confirm-password"
        type="password"
        autoComplete="new-password"
        placeholder="Repite la contraseña"
        minLength={8}
        value={confirmation}
        onChange={(event) => setConfirmation(event.target.value)}
        required
      />
      <button className="primary-button auth-submit" type="submit" disabled={isSubmitting}>
        {isSubmitting ? "Guardando…" : "Guardar contraseña"}
      </button>
      {error ? <p className="form-message error">{error}</p> : null}
    </form>
  );
}
