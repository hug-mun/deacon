import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { verifyAccessToken } from "@/lib/mcp/oauth";

type McpUser = { id: string; token: string };

function getServiceClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceRoleKey) throw new Error("MCP Supabase service configuration is missing");
  return createClient(url, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

export async function authenticateMcpRequest(request: Request): Promise<McpUser | null> {
  const header = request.headers.get("authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice("Bearer ".length).trim() : "";
  if (!token) return null;

  if (process.env.MCP_OAUTH_SIGNING_SECRET) {
    try {
      const oauthUser = verifyAccessToken(token);
      if (oauthUser) return { id: oauthUser.id, token };
    } catch (error) {
      console.error("[deacon][mcp] OAuth token verification failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const devToken = process.env.MCP_DEV_TOKEN;
  const devUserId = process.env.MCP_DEV_USER_ID;
  if (devToken && devUserId && token === devToken) {
    return { id: devUserId, token };
  }

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anonKey) return null;
  const authClient = createClient(url, anonKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const {
    data: { user },
  } = await authClient.auth.getUser(token);
  return user ? { id: user.id, token } : null;
}

function resultJson(value: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
    structuredContent: value as Record<string, unknown>,
  };
}

async function createQueryEmbedding(query: string) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return null;

  const response = await fetch("https://api.openai.com/v1/embeddings", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ model: "text-embedding-3-small", input: query }),
    cache: "no-store",
  });
  if (!response.ok) return null;

  const body = await response.json().catch(() => null);
  const embedding = body?.data?.[0]?.embedding;
  return Array.isArray(embedding) && embedding.length === 1536 ? embedding : null;
}

async function searchKnowledge(
  supabase: SupabaseClient,
  userId: string,
  query: string,
  limit: number,
) {
  const { data: lexicalData, error: lexicalError } = await supabase.rpc("search_text_chunks", {
    query_text: query,
    match_user_id: userId,
    match_count: limit,
  });
  if (lexicalError) throw new Error(`Lexical retrieval failed: ${lexicalError.message}`);

  const embedding = await createQueryEmbedding(query);
  let vectorData: unknown[] = [];
  if (embedding) {
    const { data, error } = await supabase.rpc("match_text_chunks", {
      query_embedding: `[${embedding.join(",")}]`,
      match_user_id: userId,
      match_count: limit,
    });
    if (!error) vectorData = data ?? [];
  }

  const rows = [...(lexicalData ?? []), ...vectorData] as Array<{
    id: string;
    source_type: string;
    source_id: string;
    session_id: string;
    media_item_id: string | null;
    original_filename: string | null;
    content: string;
    start_ms: number | null;
    end_ms: number | null;
    char_start: number | null;
    char_end: number | null;
    similarity: number;
  }>;

  const merged = new Map<string, (typeof rows)[number]>();
  for (const row of rows) {
    const existing = merged.get(row.id);
    if (!existing || row.similarity > existing.similarity) merged.set(row.id, row);
  }

  const selectedRows = [...merged.values()].sort((left, right) => right.similarity - left.similarity).slice(0, limit);
  const mediaIds = [...new Set(selectedRows.map((row) => row.media_item_id).filter((id): id is string => Boolean(id)))];
  const { data: mediaTitles, error: titleError } = mediaIds.length
    ? await supabase
        .from("media_items")
        .select("id, image_title_en, image_title_es")
        .eq("user_id", userId)
        .is("deleted_at", null)
        .in("id", mediaIds)
    : { data: [], error: null };
  if (titleError) throw new Error(`Image title lookup failed: ${titleError.message}`);
  const titleByMediaId = new Map((mediaTitles ?? []).map((media) => [media.id, media]));

  return selectedRows.map((row) => ({
    id: row.id,
    sourceType: row.source_type,
    sourceId: row.source_id,
    sessionId: row.session_id,
    mediaItemId: row.media_item_id,
    filename: row.original_filename,
    snippet: makeSnippet(row.content, query),
    startMs: row.start_ms,
    endMs: row.end_ms,
    charStart: row.char_start,
    charEnd: row.char_end,
    titleEn: row.media_item_id ? titleByMediaId.get(row.media_item_id)?.image_title_en ?? null : null,
    titleEs: row.media_item_id ? titleByMediaId.get(row.media_item_id)?.image_title_es ?? null : null,
    score: row.similarity,
  }));
}

function makeSnippet(content: string, query: string) {
  const normalizedContent = content.toLocaleLowerCase();
  const terms = query.toLocaleLowerCase().split(/\s+/).filter(Boolean);
  const matchIndex = terms
    .map((term) => normalizedContent.indexOf(term))
    .filter((index) => index >= 0)
    .sort((left, right) => left - right)[0] ?? 0;
  const start = Math.max(0, matchIndex - 160);
  const end = Math.min(content.length, start + 600);
  return `${start > 0 ? "…" : ""}${content.slice(start, end).trim()}${end < content.length ? "…" : ""}`;
}

export function createMcpServer(userId: string) {
  const supabase = getServiceClient();
  const server = new McpServer(
    { name: "deacon-knowledge", version: "0.1.0" },
    {
      instructions:
        "Deacon is a private dermatology exam-study knowledge base. Use search_knowledge before answering questions about the user's material. Search results may come from transcripts, notes, or image OCR/visual descriptions. Cite the returned filename, source type, and character/time locator. Use get_media_item when an image's metadata or temporary preview URL is useful. Use get_transcript with the returned charStart and a bounded maxChars window instead of reading an entire document. Treat retrieved material as study evidence, not as a clinical diagnosis. If there are no results, say that the material does not contain enough evidence.",
    },
  );

  server.registerTool(
    "search_knowledge",
    {
      title: "Search Deacon knowledge",
      description:
        "Search the authenticated user's transcripts, notes, and image-derived text using hybrid lexical and semantic retrieval. This tool never searches another user's content.",
      inputSchema: {
        query: z.string().trim().min(2).max(300),
        limit: z.number().int().min(1).max(50).default(10),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async ({ query, limit = 10 }) => {
      const results = await searchKnowledge(supabase, userId, query, limit);
      return resultJson({ query, results });
    },
  );

  server.registerTool(
    "list_library",
    {
      title: "List Deacon library",
      description: "List the authenticated user's media items and their processing state.",
      inputSchema: { limit: z.number().int().min(1).max(100).default(25) },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async ({ limit = 25 }) => {
      const { data, error } = await supabase
        .from("media_items")
        .select(
          "id, session_id, kind, original_filename, mime_type, size_bytes, status, processing_stage, processing_progress, processing_error_code, processing_error_message, image_title_en, image_title_es, image_description, image_keywords, created_at",
        )
        .eq("user_id", userId)
        .is("deleted_at", null)
        .order("created_at", { ascending: false })
        .limit(limit);
      if (error) throw new Error(`Library query failed: ${error.message}`);
      return resultJson({ items: data ?? [] });
    },
  );

  server.registerTool(
    "get_media_item",
    {
      title: "Inspect a Deacon item",
      description:
        "Get metadata for one authenticated library item. For images, returns searchable OCR/visual description and a temporary private preview URL. Does not expose storage keys.",
      inputSchema: { mediaId: z.string().uuid() },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async ({ mediaId }) => {
      const { data: media, error } = await supabase
        .from("media_items")
        .select(
          "id, session_id, kind, original_filename, mime_type, size_bytes, storage_key, status, processing_stage, processing_progress, processing_error_code, processing_error_message, image_title_en, image_title_es, image_description, image_ocr_text, image_keywords, created_at",
        )
        .eq("id", mediaId)
        .eq("user_id", userId)
        .is("deleted_at", null)
        .maybeSingle();
      if (error) throw new Error(`Media query failed: ${error.message}`);
      if (!media) return resultJson({ mediaId, found: false, item: null });

      const { data: signedUrl } = await supabase.storage
        .from("media")
        .createSignedUrl(media.storage_key, 300);
      const safeMedia = { ...media };
      delete safeMedia.storage_key;
      return resultJson({
        mediaId,
        found: true,
        item: { ...safeMedia, previewUrl: signedUrl?.signedUrl ?? null },
      });
    },
  );

  server.registerTool(
    "get_transcript",
    {
      title: "Read a Deacon transcript",
      description: "Read a bounded section of one authenticated user's transcript. Use charStart from search_knowledge to open the relevant passage without loading the entire document.",
      inputSchema: {
        mediaId: z.string().uuid(),
        startChar: z.number().int().min(0).default(0),
        maxChars: z.number().int().min(500).max(12000).default(6000),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async ({ mediaId, startChar = 0, maxChars = 6000 }) => {
      const { data: transcript, error } = await supabase
        .from("transcripts")
        .select("media_item_id, full_text, language")
        .eq("media_item_id", mediaId)
        .eq("user_id", userId)
        .maybeSingle();
      if (error) throw new Error(`Transcript query failed: ${error.message}`);
      if (!transcript) return resultJson({ mediaId, found: false, transcript: null });

      const { data: media } = await supabase
        .from("media_items")
        .select("id, original_filename, status, session_id")
        .eq("id", mediaId)
        .eq("user_id", userId)
        .is("deleted_at", null)
        .maybeSingle();
      const fullText = transcript.full_text ?? "";
      const boundedStart = Math.min(startChar, fullText.length);
      const boundedEnd = Math.min(fullText.length, boundedStart + maxChars);
      return resultJson({
        found: Boolean(media),
        media,
        language: transcript.language,
        transcript: media ? fullText.slice(boundedStart, boundedEnd) : null,
        startChar: boundedStart,
        endChar: boundedEnd,
        totalChars: fullText.length,
        hasMoreBefore: boundedStart > 0,
        hasMoreAfter: boundedEnd < fullText.length,
      });
    },
  );

  return server;
}
