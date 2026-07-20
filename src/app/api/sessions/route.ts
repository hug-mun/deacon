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

export async function GET(request: Request) {
  const supabase = await getSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json(
      { error: { code: "unauthorized", message: "Inicia sesión para ver tus sesiones." } },
      { status: 401 },
    );
  }

  const params = new URL(request.url).searchParams;
  const query = supabase
    .from("sessions")
    .select("id, channel_id, title, session_date, created_at, updated_at")
    .eq("user_id", user.id)
    .is("deleted_at", null)
    .order("session_date", { ascending: false, nullsFirst: false })
    .order("created_at", { ascending: false })
    .limit(100);
  const channelId = params.get("channel_id");
  if (channelId) query.eq("channel_id", channelId);
  if (params.get("unsorted") === "true") query.is("channel_id", null);

  const { data: sessions, error } = await query;
  if (error) {
    return NextResponse.json(
      { error: { code: "sessions_query_failed", message: "No se pudieron cargar las sesiones." } },
      { status: 500 },
    );
  }
  return NextResponse.json({ sessions: sessions ?? [] });
}

export async function POST(request: Request) {
  console.info("[deacon][sessions] POST started");
  const supabase = await getSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    console.warn("[deacon][sessions] unauthorized request");
    return NextResponse.json(
      { error: { code: "unauthorized", message: "Inicia sesión para crear una sesión." } },
      { status: 401 },
    );
  }

  let input: z.infer<typeof CreateSessionSchema>;
  try {
    input = CreateSessionSchema.parse(await request.json());
  } catch {
    console.warn("[deacon][sessions] invalid request body");
    return NextResponse.json(
      { error: { code: "invalid_request", message: "Los datos de la sesión no son válidos." } },
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
    console.error("[deacon][sessions] insert failed", {
      code: error.code,
      message: error.message,
      details: error.details,
      hint: error.hint,
      userId: user.id,
    });
    return NextResponse.json(
      { error: { code: "session_create_failed", message: "No se pudo crear la sesión." } },
      { status: 500 },
    );
  }

  console.info("[deacon][sessions] created", { sessionId: data.id, userId: user.id });
  return NextResponse.json({ session: data }, { status: 201 });
}
