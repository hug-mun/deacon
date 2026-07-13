import Link from "next/link";
import { PasswordAuthForm } from "@/components/auth/password-auth-form";

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ reason?: string }>;
}) {
  const params = await searchParams;
  const sessionMissing = params.reason === "session_missing";
  const authFailed = params.reason === "auth_failed";
  const confirmation = params.reason === "confirmation";
  const invalidRequest = params.reason === "invalid_request";

  return (
    <main className="auth-shell">
      <div className="auth-card">
        <Link className="back-link" href="/">
          ← Deacon
        </Link>
        <p className="eyebrow">Private library</p>
        <h1>Welcome back.</h1>
        <p className="lede">Sign in with your email and password to open your master-class knowledge base.</p>
        {sessionMissing ? (
          <p className="auth-alert error" role="alert">
            The login page was reached again because the library did not receive an active session. Tap “Check again,” then try signing in once more.
          </p>
        ) : null}
        {authFailed ? (
          <p className="auth-alert error" role="alert">
            Supabase did not accept those credentials. Check the email and password and try again.
          </p>
        ) : null}
        {confirmation ? (
          <p className="auth-alert success" role="status">
            Account created. Confirm your email, then sign in.
          </p>
        ) : null}
        {invalidRequest ? (
          <p className="auth-alert error" role="alert">
            Please enter a valid email and password.
          </p>
        ) : null}
        <PasswordAuthForm />
      </div>
    </main>
  );
}
