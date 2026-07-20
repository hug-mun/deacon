import Link from "next/link";
import { ResetPasswordForm } from "@/components/auth/reset-password-form";

export default function ResetPasswordPage() {
  return (
    <main className="auth-shell">
      <section className="auth-form-panel">
        <div className="auth-card">
          <div className="auth-card-top">
            <Link className="back-link" href="/login">← Iniciar sesión</Link>
          </div>
          <div>
            <p className="eyebrow">Nueva contraseña</p>
            <h1>Elige una nueva contraseña.</h1>
            <p className="lede">Usa al menos 8 caracteres para proteger tu biblioteca.</p>
          </div>
          <ResetPasswordForm />
        </div>
      </section>
    </main>
  );
}
