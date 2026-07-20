import Link from "next/link";
import { PasswordAuthForm } from "@/components/auth/password-auth-form";

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ reason?: string; next?: string }>;
}) {
  const params = await searchParams;
  const sessionMissing = params.reason === "session_missing";
  const authFailed = params.reason === "auth_failed";
  const confirmation = params.reason === "confirmation";
  const invalidRequest = params.reason === "invalid_request";
  const passwordUpdated = params.reason === "password_updated";
  const next = params.next && params.next.startsWith("/") && !params.next.startsWith("//") ? params.next : "/library";

  return (
    <main className="auth-shell">
      <section className="auth-form-panel">
        <div className="auth-card">
          <div className="auth-card-top">
            <Link className="back-link" href="/">← Deacon</Link>
          </div>
          <div>
            <h1>Bienvenido.</h1>
            <p className="lede">Inicia sesión para abrir tu biblioteca.</p>
          </div>
          {sessionMissing ? (
            <p className="auth-alert error" role="alert">
              Se volvió a abrir la página de inicio de sesión porque la biblioteca no recibió una sesión activa. Comprueba la conexión e inténtalo otra vez.
            </p>
          ) : null}
          {authFailed ? (
            <p className="auth-alert error" role="alert">
              Supabase no aceptó esas credenciales. Revisa el correo y la contraseña e inténtalo otra vez.
            </p>
          ) : null}
          {confirmation ? (
            <p className="auth-alert success" role="status">
              Cuenta creada. Confirma tu correo electrónico y luego inicia sesión.
            </p>
          ) : null}
          {invalidRequest ? (
            <p className="auth-alert error" role="alert">
              Introduce un correo electrónico y una contraseña válidos.
            </p>
          ) : null}
          {passwordUpdated ? (
            <p className="auth-alert success" role="status">
              Contraseña actualizada. Ya puedes iniciar sesión.
            </p>
          ) : null}
          <PasswordAuthForm redirectTo={next} />
        </div>
      </section>
    </main>
  );
}
