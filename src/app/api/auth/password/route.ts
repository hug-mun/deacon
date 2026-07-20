import { NextResponse } from "next/server";
import { z } from "zod";
import { getSupabaseServerClient } from "@/lib/supabase/server";

const PasswordAuthSchema = z.object({
  mode: z.enum(["signin", "signup"]),
  email: z.string().email(),
  password: z.string().min(8),
  redirect_to: z.string().startsWith("/").refine((value) => !value.startsWith("//")).default("/library"),
});

function formRedirect(path: string) {
  return new NextResponse(null, {
    status: 303,
    headers: { Location: path },
  });
}

function authRedirect(path: string) {
  return path.startsWith("/") && !path.startsWith("//") ? path : "/library";
}

function getAuthErrorMessage(message: string) {
  const normalized = message.toLowerCase();
  if (normalized.includes("invalid login credentials")) {
    return "El correo electrónico o la contraseña no son correctos.";
  }
  if (normalized.includes("user already registered")) {
    return "Ya existe una cuenta con ese correo electrónico.";
  }
  if (normalized.includes("email not confirmed")) {
    return "Confirma tu correo electrónico antes de iniciar sesión.";
  }
  if (normalized.includes("password")) {
    return "La contraseña no cumple los requisitos.";
  }
  return "No se pudo completar la autenticación. Comprueba tus datos e inténtalo otra vez.";
}

export async function POST(request: Request) {
  let input: z.infer<typeof PasswordAuthSchema>;
  const isFormSubmission = !(request.headers.get("content-type") ?? "").includes("application/json");

  try {
    const body = isFormSubmission
      ? Object.fromEntries((await request.formData()).entries())
      : await request.json();
    input = PasswordAuthSchema.parse(body);
  } catch {
    if (isFormSubmission) {
      return formRedirect("/login?reason=invalid_request");
    }

    return NextResponse.json(
      { error: { code: "invalid_request", message: "Introduce un correo electrónico y una contraseña válidos." } },
      { status: 400 },
    );
  }

  const supabase = await getSupabaseServerClient();
  let result:
    | Awaited<ReturnType<typeof supabase.auth.signUp>>
    | Awaited<ReturnType<typeof supabase.auth.signInWithPassword>>;
  try {
    result =
      input.mode === "signup"
        ? await supabase.auth.signUp({ email: input.email, password: input.password })
        : await supabase.auth.signInWithPassword({ email: input.email, password: input.password });
  } catch {
    const message = "No se pudo conectar con Supabase. Comprueba que el servicio local esté activo y que la URL sea http://127.0.0.1:54321.";
    if (isFormSubmission) {
      return formRedirect("/login?reason=auth_failed");
    }
    return NextResponse.json(
      { error: { code: "supabase_unreachable", message } },
      { status: 503 },
    );
  }

  if (result.error) {
    if (isFormSubmission) {
      return formRedirect("/login?reason=auth_failed");
    }

    return NextResponse.json(
      { error: { code: "authentication_failed", message: getAuthErrorMessage(result.error.message) } },
      { status: 401 },
    );
  }

  if (!result.data.session) {
    if (isFormSubmission) {
      return formRedirect("/login?reason=confirmation");
    }

    return NextResponse.json({ requires_confirmation: true }, { status: 200 });
  }

  if (isFormSubmission) {
    return formRedirect(authRedirect(input.redirect_to));
  }

  return NextResponse.json({
    authenticated: true,
    redirect_to: authRedirect(input.redirect_to),
    user: { id: result.data.user?.id, email: result.data.user?.email },
  });
}
