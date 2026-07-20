import { NextResponse } from "next/server";
import { z } from "zod";
import { getSupabaseServerClient } from "@/lib/supabase/server";

const ParamsSchema = z.object({ id: z.string().uuid() });

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const supabase = await getSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json(
      { error: { code: "unauthorized", message: "Inicia sesión para leer la transcripción." } },
      { status: 401 },
    );
  }

  const parsed = ParamsSchema.safeParse(await context.params);
  if (!parsed.success) {
    return NextResponse.json(
      { error: { code: "invalid_media_id", message: "El identificador no es válido." } },
      { status: 400 },
    );
  }

  const { data: transcript, error } = await supabase
    .from("transcripts")
    .select("full_text, language, media_item_id")
    .eq("media_item_id", parsed.data.id)
    .eq("user_id", user.id)
    .maybeSingle();

  if (error) {
    console.error("[deacon][media.transcript] query failed", {
      code: error.code,
      message: error.message,
      mediaId: parsed.data.id,
      userId: user.id,
    });
    return NextResponse.json(
      { error: { code: "transcript_failed", message: "No se pudo leer la transcripción." } },
      { status: 500 },
    );
  }

  if (!transcript) {
    return NextResponse.json(
      { error: { code: "transcript_not_found", message: "Todavía no hay una transcripción disponible." } },
      { status: 404 },
    );
  }

  const download = new URL(request.url).searchParams.get("download") === "1";
  if (download) {
    return new Response(transcript.full_text, {
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        "Content-Disposition": `attachment; filename="transcripcion-${transcript.media_item_id}.txt"`,
        "Cache-Control": "private, no-store",
      },
    });
  }

  return NextResponse.json(transcript, { headers: { "Cache-Control": "private, no-store" } });
}
