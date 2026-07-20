"use client";

import { FormEvent, useState } from "react";
import Link from "next/link";
import { getSupabaseBrowserClient } from "@/lib/supabase/client";
import { appPath } from "@/lib/app-path";

export function ForgotPasswordForm() {
  const [email, setEmail] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setIsSubmitting(true);
    setError(null);

    try {
      const redirectTo = `${window.location.origin}${appPath("/reset-password")}`;
      const { error: resetError } = await getSupabaseBrowserClient().auth.resetPasswordForEmail(email, { redirectTo });
      if (resetError) throw resetError;
      setSent(true);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "No se pudo enviar el correo de recuperación.");
    } finally {
      setIsSubmitting(false);
    }
  }

  if (sent) {
    return (
      <div className="auth-form-result">
        <p className="auth-alert success" role="status">
          Te enviamos un enlace de recuperación a <strong>{email}</strong>. Revisa también la carpeta de spam.
        </p>
        <Link className="auth-forgot-link" href="/login">Volver a iniciar sesión</Link>
      </div>
    );
  }

  return (
    <form className="auth-form" onSubmit={handleSubmit}>
      <label htmlFor="forgot-email">Correo electrónico</label>
      <input
        id="forgot-email"
        type="email"
        autoComplete="email"
        placeholder="you@example.com"
        value={email}
        onChange={(event) => setEmail(event.target.value)}
        required
      />
      <button className="primary-button auth-submit" type="submit" disabled={isSubmitting}>
        {isSubmitting ? "Enviando…" : "Enviar enlace de recuperación"}
      </button>
      {error ? <p className="form-message error">{error}</p> : null}
      <Link className="auth-forgot-link" href="/login">Volver a iniciar sesión</Link>
    </form>
  );
}
