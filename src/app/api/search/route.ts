import { NextResponse } from "next/server";
import { z } from "zod";
import {
  classifyOpenAiFailure,
  networkFailure,
  openAiSearchNotice,
  type OpenAiProviderFailure,
} from "@/lib/openai/provider-error";
import { getSupabaseServerClient } from "@/lib/supabase/server";

const SearchSchema = z.object({
  q: z.string().trim().min(2).max(300),
});

type SearchRow = {
  id: string;
  session_id: string;
  source_type: string;
  source_id: string;
  content: string;
  start_ms: number | null;
  end_ms: number | null;
  char_start: number | null;
  char_end: number | null;
  media_item_id: string | null;
  original_filename: string | null;
  similarity: number;
};

function makeSnippet(content: string, query: string) {
  const normalizedContent = content.toLocaleLowerCase();
  const terms = query.toLocaleLowerCase().split(/\s+/).filter(Boolean);
  const matchIndex = terms
    .map((term) => normalizedContent.indexOf(term))
    .filter((index) => index >= 0)
    .sort((left, right) => left - right)[0] ?? 0;
  const start = Math.max(0, matchIndex - 120);
  const end = Math.min(content.length, start + 420);
  const prefix = start > 0 ? "…" : "";
  const suffix = end < content.length ? "…" : "";
  return `${prefix}${content.slice(start, end).trim()}${suffix}`;
}

async function createEmbedding(text: string): Promise<{
  embedding: number[] | null;
  missingKey: boolean;
  failure: OpenAiProviderFailure | null;
}> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return { embedding: null, missingKey: true, failure: null };

  try {
    const response = await fetch("https://api.openai.com/v1/embeddings", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "text-embedding-3-small",
        input: text,
      }),
      cache: "no-store",
    });

    const body = (await response.json().catch(() => null)) as {
      data?: Array<{ embedding?: number[] }>;
      error?: { code?: string; type?: string; message?: string };
    } | null;
    if (!response.ok) {
      const failure = classifyOpenAiFailure(response.status, body, response.headers);
      console.error("[deacon][search] embedding provider rejected request", {
        status: failure.status,
        kind: failure.kind,
        code: failure.code,
        requestId: failure.requestId,
        retryAfterSeconds: failure.retryAfterSeconds,
      });
      return { embedding: null, missingKey: false, failure };
    }

    const embedding = body?.data?.[0]?.embedding;
    if (!embedding || embedding.length !== 1536) {
      const failure = classifyOpenAiFailure(response.status, body, response.headers);
      console.error("[deacon][search] embedding provider returned an invalid vector", {
        status: response.status,
        kind: failure.kind,
        requestId: failure.requestId,
      });
      return { embedding: null, missingKey: false, failure };
    }

    return { embedding, missingKey: false, failure: null };
  } catch (error) {
    const failure = networkFailure(error);
    console.error("[deacon][search] embedding network request failed", {
      kind: failure.kind,
      error: error instanceof Error ? error.message : String(error),
    });
    return { embedding: null, missingKey: false, failure };
  }
}

export async function GET(request: Request) {
  const supabase = await getSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json(
      { error: { code: "unauthorized", message: "Inicia sesión para buscar." } },
      { status: 401 },
    );
  }

  const input = SearchSchema.safeParse({
    q: new URL(request.url).searchParams.get("q") ?? "",
  });
  if (!input.success) {
    return NextResponse.json(
      { error: { code: "invalid_query", message: "Escribe al menos dos caracteres para buscar." } },
      { status: 400 },
    );
  }

  try {
    const lexicalPromise = supabase.rpc("search_text_chunks", {
      query_text: input.data.q,
      match_user_id: user.id,
      match_count: 20,
    });
    const { data: lexicalData, error: lexicalError } = await lexicalPromise;
    if (lexicalError) {
      console.error("[deacon][search] lexical query failed", {
        code: lexicalError.code,
        message: lexicalError.message,
        details: lexicalError.details,
        hint: lexicalError.hint,
        userId: user.id,
      });
    }

    const { embedding, missingKey, failure: embeddingFailure } = await createEmbedding(input.data.q);
    let vectorRows: SearchRow[] = [];
    if (!missingKey && embedding) {
      const { data: vectorData, error: vectorError } = await supabase.rpc("match_text_chunks", {
        query_embedding: `[${embedding.join(",")}]`,
        match_user_id: user.id,
        match_count: 20,
      });

      if (vectorError) {
        console.error("[deacon][search] vector query failed; continuing with lexical results", {
          code: vectorError.code,
          message: vectorError.message,
          details: vectorError.details,
          hint: vectorError.hint,
          userId: user.id,
        });
      } else {
        vectorRows = (vectorData ?? []) as SearchRow[];
      }
    }

    const lexicalRows = (lexicalData ?? []) as SearchRow[];
    if (lexicalRows.length === 0 && vectorRows.length === 0 && lexicalError) {
      return NextResponse.json(
        {
          error: {
            code: "search_unavailable",
            message: "La búsqueda no está disponible ahora. Inténtalo de nuevo en unos momentos.",
          },
        },
        { status: 503 },
      );
    }

    const merged = new Map<string, SearchRow & { lexicalSimilarity?: number; vectorSimilarity?: number }>();
    for (const row of lexicalRows) {
      merged.set(row.id, { ...row, lexicalSimilarity: row.similarity });
    }
    for (const row of vectorRows) {
      const existing = merged.get(row.id);
      merged.set(row.id, {
        ...(existing ?? row),
        ...row,
        lexicalSimilarity: existing?.lexicalSimilarity,
        vectorSimilarity: row.similarity,
        similarity: existing
          ? Math.max(row.similarity, existing.similarity)
          : row.similarity,
      });
    }

    const rankedRows = [...merged.values()]
      .sort((left, right) => right.similarity - left.similarity)
      .slice(0, 20);
    const mediaIds = [...new Set(rankedRows.map((row) => row.media_item_id).filter((id): id is string => Boolean(id)))];
    const { data: imageTitles, error: imageTitlesError } = mediaIds.length
      ? await supabase
          .from("media_items")
          .select("id, image_title_en, image_title_es")
          .eq("user_id", user.id)
          .is("deleted_at", null)
          .in("id", mediaIds)
      : { data: [], error: null };
    if (imageTitlesError) {
      console.error("[deacon][search] image title lookup failed", {
        code: imageTitlesError.code,
        message: imageTitlesError.message,
        userId: user.id,
      });
    }
    const titleByMediaId = new Map((imageTitles ?? []).map((item) => [item.id, item]));

    const groupedRows = new Map<string, SearchRow & {
      image_title_en: string | null;
      image_title_es: string | null;
      lexicalSimilarity?: number;
      vectorSimilarity?: number;
      match_count: number;
      matches: Array<{ id: string; char_start: number | null; char_end: number | null; start_ms: number | null; end_ms: number | null; score: number; snippet: string }>;
    }>();
    for (const row of rankedRows) {
      const key = row.media_item_id ?? `${row.source_type}:${row.source_id}`;
      const existing = groupedRows.get(key);
      if (existing) {
        existing.match_count += 1;
        if (existing.matches.length < 3) {
          existing.matches.push({
            id: row.id,
            char_start: row.char_start,
            char_end: row.char_end,
            start_ms: row.start_ms,
            end_ms: row.end_ms,
            score: row.similarity,
            snippet: makeSnippet(row.content, input.data.q),
          });
        }
        continue;
      }
      groupedRows.set(key, {
        ...row,
        image_title_en: row.media_item_id ? titleByMediaId.get(row.media_item_id)?.image_title_en ?? null : null,
        image_title_es: row.media_item_id ? titleByMediaId.get(row.media_item_id)?.image_title_es ?? null : null,
        match_count: 1,
        matches: [{
          id: row.id,
          char_start: row.char_start,
          char_end: row.char_end,
          start_ms: row.start_ms,
          end_ms: row.end_ms,
          score: row.similarity,
          snippet: makeSnippet(row.content, input.data.q),
        }],
      });
    }

    const rows = [...groupedRows.values()].slice(0, 8);
    return NextResponse.json({
      query: input.data.q,
      mode: vectorRows.length > 0 && lexicalRows.length > 0 ? "hybrid" : vectorRows.length > 0 ? "vector" : "lexical",
      notice: embeddingFailure ? openAiSearchNotice(embeddingFailure) : missingKey ? null : undefined,
      results: rows.map((result) => ({
        id: result.id,
        session_id: result.session_id,
        source_type: result.source_type,
        source_id: result.source_id,
        media_item_id: result.media_item_id,
        original_filename: result.original_filename,
        title_en: result.image_title_en,
        title_es: result.image_title_es,
        char_start: result.char_start,
        char_end: result.char_end,
        similarity: result.similarity,
        score: result.similarity,
        match_count: result.match_count,
        matches: result.matches,
      })),
    });
  } catch (error) {
    console.error("[deacon][search] request failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    return NextResponse.json(
      { error: { code: "search_unavailable", message: "La búsqueda no está disponible ahora. Inténtalo de nuevo." } },
      { status: 503 },
    );
  }
}
