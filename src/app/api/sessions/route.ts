import { NextResponse } from "next/server";
import { z } from "zod";
import { getSupabaseServerClient } from "@/lib/supabase/server";

const CreateSessionSchema = z.object({
  session_date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional()
    .nullable(),
  title: z.string().trim().max(200).optional().nullable(),
});

export async function POST(request: Request) {
  const supabase = await getSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json(
      { error: { code: "unauthorized", message: "Sign in to create a session." } },
      { status: 401 },
    );
  }

  let input: z.infer<typeof CreateSessionSchema>;
  try {
    input = CreateSessionSchema.parse(await request.json());
  } catch {
    return NextResponse.json(
      { error: { code: "invalid_request", message: "The session details are invalid." } },
      { status: 400 },
    );
  }

  const { data, error } = await supabase
    .from("sessions")
    .insert({
      user_id: user.id,
      session_date: input.session_date ?? null,
      title: input.title ?? null,
    })
    .select("id, session_date, title, created_at")
    .single();

  if (error) {
    return NextResponse.json(
      { error: { code: "session_create_failed", message: "The session could not be created." } },
      { status: 500 },
    );
  }

  return NextResponse.json({ session: data }, { status: 201 });
}
