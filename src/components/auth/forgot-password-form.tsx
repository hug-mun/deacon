"use client";

import { FormEvent, useState } from "react";
import Link from "next/link";
import { getSupabaseBrowserClient } from "@/lib/supabase/client";
import { appPath } from "@/lib/app-path";

export function ForgotPasswordForm() {
  const [email, setEmail] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isVerifying, setIsVerifying] = useState(false);
  const [sent, setSent] = useState(false);
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const isValidCodeLength = code.length === 6 || code.length === 8;

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

  async function handleCodeSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setIsVerifying(true);
    setError(null);

    const { error: verifyError } = await getSupabaseBrowserClient().auth.verifyOtp({
      email,
      token: code.trim(),
      type: "recovery",
    });

    setIsVerifying(false);
    if (verifyError) {
      setError("El código no es válido o ya expiró. Solicita uno nuevo.");
      return;
    }

    window.location.assign(appPath("/reset-password"));
  }

  if (sent) {
    return (
      <div className="auth-form-result">
        <p className="auth-alert success" role="status">Revisa tu correo. Puedes abrir el enlace o introducir aquí el código de recuperación.</p>
        <form className="auth-form" onSubmit={handleCodeSubmit}>
          <label htmlFor="recovery-code">Código de recuperación</label>
          <input
            id="recovery-code"
            type="text"
            inputMode="numeric"
            autoComplete="one-time-code"
            pattern="[0-9]{6,8}"
            minLength={6}
            maxLength={8}
            placeholder="12345678"
            value={code}
            onChange={(event) => setCode(event.target.value.replace(/\D/g, "").slice(0, 8))}
            required
          />
          <button className="primary-button auth-submit" type="submit" disabled={isVerifying || !isValidCodeLength}>
            {isVerifying ? "Verificando…" : "Usar código"}
          </button>
          {error ? <p className="form-message error">{error}</p> : null}
        </form>
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
        {isSubmitting ? "Enviando…" : "Enviar enlace"}
      </button>
      {error ? <p className="form-message error">{error}</p> : null}
      <Link className="auth-forgot-link" href="/login">Volver a iniciar sesión</Link>
    </form>
  );
}
