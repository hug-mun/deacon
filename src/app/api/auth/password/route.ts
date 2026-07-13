import { NextResponse } from "next/server";
import { z } from "zod";
import { getSupabaseServerClient } from "@/lib/supabase/server";

const PasswordAuthSchema = z.object({
  mode: z.enum(["signin", "signup"]),
  email: z.string().email(),
  password: z.string().min(8),
});

function formRedirect(path: string) {
  return new NextResponse(null, {
    status: 303,
    headers: { Location: path },
  });
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
      { error: { code: "invalid_request", message: "Enter a valid email and password." } },
      { status: 400 },
    );
  }

  const supabase = await getSupabaseServerClient();
  const result =
    input.mode === "signup"
      ? await supabase.auth.signUp({ email: input.email, password: input.password })
      : await supabase.auth.signInWithPassword({ email: input.email, password: input.password });

  if (result.error) {
    if (isFormSubmission) {
      return formRedirect("/login?reason=auth_failed");
    }

    return NextResponse.json(
      { error: { code: "authentication_failed", message: result.error.message } },
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
    return formRedirect("/library");
  }

  return NextResponse.json({
    authenticated: true,
    user: { id: result.data.user?.id, email: result.data.user?.email },
  });
}
