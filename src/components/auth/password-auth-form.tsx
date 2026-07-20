"use client";

import { FormEvent, useCallback, useState } from "react";
import Link from "next/link";
import { appPath } from "@/lib/app-path";

type AuthMode = "signin" | "signup";
type ConnectionState = "not-checked" | "checking" | "connected" | "unreachable" | "not-configured";

type PasswordAuthFormProps = {
  redirectTo?: string;
};

const connectionLabels: Record<ConnectionState, string> = {
  "not-checked": "sin comprobar",
  checking: "comprobando",
  connected: "conectado",
  unreachable: "no disponible",
  "not-configured": "no configurado",
};

export function PasswordAuthForm({ redirectTo = "/library" }: PasswordAuthFormProps) {
  const [mode, setMode] = useState<AuthMode>("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [connection, setConnection] = useState<ConnectionState>("not-checked");
  const [debugStep, setDebugStep] = useState("Listo para comprobar la conexión");
  const [debugDetails, setDebugDetails] = useState("Toca «Comprobar de nuevo» para probar Supabase desde este dispositivo.");

  const isSignUp = mode === "signup";
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;

  const checkConnection = useCallback(async () => {
    if (!supabaseUrl) {
      setConnection("not-configured");
      setDebugStep("Comprobación de configuración");
      setDebugDetails("Falta NEXT_PUBLIC_SUPABASE_URL.");
      return;
    }

    setConnection("checking");
    setDebugStep("Comprobando conexión con Supabase");
    try {
      const response = await fetch(`${supabaseUrl}/auth/v1/health`, { cache: "no-store" });
      if (!response.ok) {
        throw new Error(`Health endpoint returned HTTP ${response.status}.`);
      }

      setConnection("connected");
      setDebugStep("Conexión comprobada");
      setDebugDetails("Supabase Auth está disponible desde este dispositivo.");
    } catch (connectionError) {
      setConnection("unreachable");
      setDebugDetails(
        connectionError instanceof Error
          ? connectionError.message
          : "No se pudo acceder a Supabase Auth.",
      );
    }
  }, [supabaseUrl]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setMessage(null);

    if (!process.env.NEXT_PUBLIC_SUPABASE_URL || !process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY) {
      setError("Supabase aún no está configurado. Añade las variables públicas de .env.example.");
      setDebugStep("Comprobación de configuración");
      setDebugDetails("Falta la URL pública de Supabase o la clave anónima.");
      return;
    }

    setIsSubmitting(true);
    setDebugStep(isSignUp ? "Creando cuenta" : "Iniciando sesión");
    setDebugDetails("Enviando las credenciales mediante la ruta segura de sesión de la aplicación…");
    let response: Response;
    try {
      response = await fetch(appPath("/api/auth/password"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode, email, password, redirect_to: redirectTo }),
      });
    } catch (requestError) {
      setIsSubmitting(false);
      const message = requestError instanceof Error ? requestError.message : "La aplicación no pudo acceder a la ruta de autenticación.";
      setError(message);
      setDebugStep("Ruta de sesión no disponible");
      setDebugDetails(message);
      return;
    }
    let result: { error?: { message?: string }; requires_confirmation?: boolean; redirect_to?: string } = {};
    try {
      result = await response.json();
    } catch {
      result = { error: { message: "La respuesta de autenticación no es válida." } };
    }

    setIsSubmitting(false);

    if (!response.ok || result.error) {
      const message = result.error?.message ?? `La autenticación falló con HTTP ${response.status}.`;
      setError(message);
      setDebugStep("Autenticación rechazada");
      setDebugDetails(
        `La ruta de sesión devolvió HTTP ${response.status}: ${message}`,
      );
      return;
    }

    if (isSignUp && result.requires_confirmation) {
      setMessage("Cuenta creada. Revisa tu correo electrónico para confirmarla antes de iniciar sesión.");
      setMode("signin");
      setDebugStep("Cuenta creada");
      setDebugDetails("Supabase creó la cuenta, pero no devolvió una sesión.");
      return;
    }

    setDebugStep("Autenticado");
    setDebugDetails("La aplicación guardó la sesión. Redirigiendo a tu biblioteca…");
    window.location.assign(result.redirect_to ?? redirectTo);
  }

  return (
    <div>
      <form className="auth-form" method="post" action={appPath("/api/auth/password")} onSubmit={handleSubmit}>
        <input type="hidden" name="mode" value={mode} />
        <input type="hidden" name="redirect_to" value={redirectTo} />
        <label htmlFor="email">Correo electrónico</label>
        <input
          id="email"
          name="email"
          type="email"
          autoComplete="email"
          placeholder="you@example.com"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          required
        />
        <label htmlFor="password">Contraseña</label>
        <input
          id="password"
          name="password"
          type="password"
          autoComplete={isSignUp ? "new-password" : "current-password"}
          placeholder="Al menos 8 caracteres"
          minLength={8}
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          required
        />
        <button className="primary-button auth-submit" type="submit" disabled={isSubmitting}>
          {isSubmitting ? "Procesando…" : isSignUp ? "Crear cuenta" : "Iniciar sesión"}
        </button>
        {message ? <p className="form-message success">{message}</p> : null}
        {error ? <p className="form-message error">{error}</p> : null}
      </form>
      {!isSignUp ? (
        <Link className="auth-forgot-link" href="/forgot-password">
          ¿Olvidaste tu contraseña?
        </Link>
      ) : null}
      <button
        className="auth-switch"
        type="button"
        onClick={() => {
          setMode(isSignUp ? "signin" : "signup");
          setError(null);
          setMessage(null);
        }}
      >
        {isSignUp ? "¿Ya tienes una cuenta? Inicia sesión" : "¿Eres nuevo? Crea una cuenta"}
      </button>
      <details className={`auth-debug ${connection}`} aria-live="polite">
        <summary>
          <strong>Detalles de conexión</strong>
          <button className="debug-check-button" type="button" onClick={(event) => { event.stopPropagation(); void checkConnection(); }}>
            Comprobar de nuevo
          </button>
        </summary>
        <div className="auth-debug-content">
          <dl>
            <div>
              <dt>Aplicación</dt>
              <dd>Este dispositivo</dd>
            </div>
            <div>
              <dt>Supabase</dt>
              <dd>{supabaseUrl ? new URL(supabaseUrl).host : "no configurado"}</dd>
            </div>
            <div>
              <dt>Red</dt>
              <dd>{connectionLabels[connection]}</dd>
            </div>
            <div>
              <dt>Último paso</dt>
              <dd>{debugStep}</dd>
            </div>
          </dl>
          <p>{debugDetails}</p>
        </div>
      </details>
    </div>
  );
}
