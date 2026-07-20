import Link from "next/link";
import { ForgotPasswordForm } from "@/components/auth/forgot-password-form";

export default async function ForgotPasswordPage({
  searchParams,
}: {
  searchParams: Promise<{ reason?: string }>;
}) {
  const { reason } = await searchParams;
  const recoveryError = reason === "otp_expired" || reason === "access_denied";

  return (
    <main className="auth-shell">
      <section className="auth-form-panel">
        <div className="auth-card">
          <div className="auth-card-top">
            <Link className="back-link" href="/login">← Iniciar sesión</Link>
          </div>
          <div>
            <p className="eyebrow">Recuperar acceso</p>
            <h1>Restablece tu contraseña.</h1>
            <p className="lede">Te enviaremos un enlace para elegir una nueva.</p>
          </div>
          {recoveryError ? (
            <p className="auth-alert error" role="alert">
              El enlace expiró o ya fue utilizado. Solicita un enlace nuevo.
            </p>
          ) : null}
          <ForgotPasswordForm />
        </div>
      </section>
    </main>
  );
}
