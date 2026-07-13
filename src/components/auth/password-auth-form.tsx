"use client";

import { FormEvent, useCallback, useState } from "react";

type AuthMode = "signin" | "signup";
type ConnectionState = "not-checked" | "checking" | "connected" | "unreachable" | "not-configured";

export function PasswordAuthForm() {
  const [mode, setMode] = useState<AuthMode>("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [connection, setConnection] = useState<ConnectionState>("not-checked");
  const [debugStep, setDebugStep] = useState("Ready to check connection");
  const [debugDetails, setDebugDetails] = useState("Tap Check again to test Supabase from this device.");

  const isSignUp = mode === "signup";
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;

  const checkConnection = useCallback(async () => {
    if (!supabaseUrl) {
      setConnection("not-configured");
      setDebugStep("Configuration check");
      setDebugDetails("NEXT_PUBLIC_SUPABASE_URL is missing.");
      return;
    }

    setConnection("checking");
    setDebugStep("Supabase connection check");
    try {
      const response = await fetch(`${supabaseUrl}/auth/v1/health`, { cache: "no-store" });
      if (!response.ok) {
        throw new Error(`Health endpoint returned HTTP ${response.status}.`);
      }

      setConnection("connected");
      setDebugDetails("Supabase Auth is reachable from this device.");
    } catch (connectionError) {
      setConnection("unreachable");
      setDebugDetails(
        connectionError instanceof Error
          ? connectionError.message
          : "Supabase Auth could not be reached.",
      );
    }
  }, [supabaseUrl]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setMessage(null);

    if (!process.env.NEXT_PUBLIC_SUPABASE_URL || !process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY) {
      setError("Supabase is not configured yet. Add the public variables from .env.example.");
      setDebugStep("Configuration check");
      setDebugDetails("The public Supabase URL or anonymous key is missing.");
      return;
    }

    setIsSubmitting(true);
    setDebugStep(isSignUp ? "Creating account" : "Signing in");
    setDebugDetails("Sending credentials through the secure app session route…");
    let response: Response;
    try {
      response = await fetch("/api/auth/password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode, email, password }),
      });
    } catch (requestError) {
      setIsSubmitting(false);
      const message = requestError instanceof Error ? requestError.message : "The app could not reach its auth route.";
      setError(message);
      setDebugStep("Session route unreachable");
      setDebugDetails(message);
      return;
    }
    let result: { error?: { message?: string }; requires_confirmation?: boolean } = {};
    try {
      result = await response.json();
    } catch {
      result = { error: { message: "The authentication response was invalid." } };
    }

    setIsSubmitting(false);

    if (!response.ok || result.error) {
      const message = result.error?.message ?? `Authentication failed with HTTP ${response.status}.`;
      setError(message);
      setDebugStep("Authentication rejected");
      setDebugDetails(
        `The session route returned HTTP ${response.status}: ${message}`,
      );
      return;
    }

    if (isSignUp && result.requires_confirmation) {
      setMessage("Account created. Check your email to confirm it before signing in.");
      setMode("signin");
      setDebugStep("Account created");
      setDebugDetails("Supabase created the account but did not return a session.");
      return;
    }

    setDebugStep("Authenticated");
    setDebugDetails("Session cookie set by the app. Redirecting to your library…");
    window.location.assign("/library");
  }

  return (
    <div>
      <form className="auth-form" method="post" action="/api/auth/password" onSubmit={handleSubmit}>
        <input type="hidden" name="mode" value={mode} />
        <label htmlFor="email">Email / username</label>
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
        <label htmlFor="password">Password</label>
        <input
          id="password"
          name="password"
          type="password"
          autoComplete={isSignUp ? "new-password" : "current-password"}
          placeholder="At least 8 characters"
          minLength={8}
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          required
        />
        <button type="submit" disabled={isSubmitting}>
          {isSubmitting ? "Working…" : isSignUp ? "Create account" : "Sign in"}
        </button>
        {message ? <p className="form-message success">{message}</p> : null}
        {error ? <p className="form-message error">{error}</p> : null}
      </form>
      <button
        className="auth-switch"
        type="button"
        onClick={() => {
          setMode(isSignUp ? "signin" : "signup");
          setError(null);
          setMessage(null);
        }}
      >
        {isSignUp ? "Already have an account? Sign in" : "New here? Create an account"}
      </button>
      <aside className={`auth-debug ${connection}`} aria-live="polite">
        <div className="auth-debug-heading">
          <strong>Connection details</strong>
          <button className="debug-check-button" type="button" onClick={() => void checkConnection()}>
            Check again
          </button>
        </div>
        <dl>
          <div>
            <dt>App</dt>
            <dd>This device</dd>
          </div>
          <div>
            <dt>Supabase</dt>
            <dd>{supabaseUrl ? new URL(supabaseUrl).host : "not configured"}</dd>
          </div>
          <div>
            <dt>Network</dt>
            <dd>{connection}</dd>
          </div>
          <div>
            <dt>Last step</dt>
            <dd>{debugStep}</dd>
          </div>
        </dl>
        <p>{debugDetails}</p>
      </aside>
    </div>
  );
}
