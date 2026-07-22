import { hostname } from "node:os";
import { createClient } from "@supabase/supabase-js";
// Import the parser implementation directly. The package root runs its own
// fixture test when bundled as a serverless dependency.
import pdfParse from "pdf-parse/lib/pdf-parse.js";
import WebSocket from "ws";
import { imageChunks, normalizeImageAnalysis } from "./image-analysis.mjs";

const POLL_MS = 1500;
const EMBEDDING_MODEL = "text-embedding-3-small";
const VISION_MODEL = process.env.OPENAI_VISION_MODEL || "gpt-5.6-luna";
const VISION_DETAIL = process.env.OPENAI_VISION_DETAIL || "low";
const EMBEDDING_BATCH_SIZE = 64;
const EMBEDDING_RETRY_MS = 60_000;
const EMBEDDING_BLOCKED_RETRY_MS = 15 * 60_000;
const WORKER_HEARTBEAT_MS = 15_000;
const WORKER_INSTANCE_ID = process.env.WORKER_INSTANCE_ID || `${hostname()}-${process.pid}`;
const MEDIA_RECOVERY_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const openAiApiKey = process.env.OPENAI_API_KEY;
let lastEmbeddingAttemptAt = 0;
let embeddingBlockedUntil = 0;
let missingEmbeddingKeyLogged = false;
let lastHealthWriteAt = 0;
let workerDegraded = false;

if (!supabaseUrl || !serviceRoleKey) {
  console.error("[deacon][worker] Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  process.exit(1);
}

const supabase = createClient(supabaseUrl, serviceRoleKey, {
  auth: { autoRefreshToken: false, persistSession: false },
  realtime: { transport: WebSocket },
});

async function writeHealth(status, values = {}) {
  const { error } = await supabase.from("service_health").upsert({
    service_name: "media_worker",
    status,
    instance_id: WORKER_INSTANCE_ID,
    last_heartbeat_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...values,
  });
  if (error) {
    console.error("[deacon][worker] health update failed", {
      code: error.code,
      message: error.message,
    });
  }
  lastHealthWriteAt = Date.now();
}

async function heartbeat(force = false) {
  if (!force && Date.now() - lastHealthWriteAt < WORKER_HEARTBEAT_MS) return;
  await writeHealth(workerDegraded ? "degraded" : "ok", workerDegraded ? {} : {
    last_success_at: new Date().toISOString(),
  });
}

async function updateProgress(mediaId, values, currentStatus = "processing") {
  const { error } = await supabase
    .from("media_items")
    .update(values)
    .eq("id", mediaId)
    .eq("status", currentStatus);

  if (error) {
    throw new Error(`Progress update failed (${error.code}): ${error.message}`);
  }
}

function chunkTranscript(text) {
  const targetLength = 1800;
  const overlap = 200;
  const chunks = [];
  let start = 0;

  while (start < text.length) {
    let end = Math.min(start + targetLength, text.length);
    if (end < text.length) {
      const whitespace = text.lastIndexOf(" ", end);
      if (whitespace > start + 900) end = whitespace;
    }

    const content = text.slice(start, end).trim();
    if (content) {
      chunks.push({
        content,
        charStart: start,
        charEnd: end,
      });
    }

    if (end >= text.length) break;
    start = Math.max(end - overlap, start + 1);
  }

  return chunks;
}

async function analyzeImage(file, mimeType) {
  if (!openAiApiKey) {
    throw new Error("OPENAI_API_KEY is required to analyze images");
  }

  const imageBase64 = Buffer.from(await file.arrayBuffer()).toString("base64");
  const requestBody = {
    model: VISION_MODEL,
    max_completion_tokens: 1024,
    messages: [
      {
        role: "system",
        content:
          "You analyze images uploaded for a dermatologist's private exam-study library. Describe only what is visibly present or legibly written. Do not identify people, infer a patient's identity, or make a clinical diagnosis. Return valid JSON with exactly these keys: titleEn (short English title), titleEs (short Spanish title), description (string), visibleText (string), concepts (array of strings), keywords (array of strings), bodyRegion (string), imageType (string). Make both titles concise, useful for a library card and search, and based only on visible study content. Do not put a diagnosis in a title unless it is explicitly printed in the image or clearly framed as a study topic. Include useful dermatology study terms, lesion morphology, anatomical region, slide headings, and labels when visible.",
      },
      {
        role: "user",
        content: [
          {
            type: "text",
            text: "Analyze this study image for later semantic search. Create a short title in English and Spanish. If it is a slide or screenshot, transcribe the readable text. If it is a clinical teaching image, describe observable visual features without diagnosing it. Return only the JSON object.",
          },
          {
            type: "image_url",
            image_url: { url: `data:${mimeType};base64,${imageBase64}`, detail: VISION_DETAIL },
          },
        ],
      },
    ],
  };
  let response;
  let body;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${openAiApiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(requestBody),
      signal: AbortSignal.timeout(90_000),
    });
    body = await response.json().catch(() => null);
    if (response.ok) break;
    const retryable = response.status === 401 || response.status === 403 || response.status === 429 || response.status >= 500;
    if (!retryable || attempt === 2) break;
    await new Promise((resolve) => setTimeout(resolve, 750 * (attempt + 1)));
  }

  if (!response.ok) {
    const providerError = body?.error ?? {};
    const error = new Error(`Vision provider request failed: ${providerError.message ?? response.status}`);
    error.name = "VisionProviderError";
    error.cause = {
      status: response.status,
      code: providerError.code ?? providerError.type ?? null,
      requestId: response.headers.get("x-request-id"),
    };
    throw error;
  }

  const content = body?.choices?.[0]?.message?.content;
  if (typeof content !== "string") throw new Error("Vision response did not contain analysis text");

  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new Error("Vision response was not valid JSON");
  }

  const analysis = normalizeImageAnalysis(parsed);
  if (!analysis.description && !analysis.visibleText && analysis.concepts.length === 0) {
    throw new Error("Vision response did not contain searchable image content");
  }
  return analysis;
}

async function saveImageAnalysis(media, analysis) {
  const chunks = imageChunks(analysis);
  const vectors = await createEmbeddings(chunks.map((chunk) => chunk.content));
  if (!vectors || vectors.length !== chunks.length) {
    throw new Error("Image chunks could not be embedded");
  }

  const { error: deleteError } = await supabase
    .from("text_chunks")
    .delete()
    .eq("user_id", media.user_id)
    .in("source_type", ["image_ocr", "image_vision"])
    .eq("source_id", media.id);
  if (deleteError) {
    throw new Error(`Existing image chunks could not be cleared (${deleteError.code}): ${deleteError.message}`);
  }

  const rows = chunks.map((chunk, index) => ({
    user_id: media.user_id,
    session_id: media.session_id,
    source_type: chunk.sourceType,
    source_id: media.id,
    chunk_index: index,
    content: chunk.content,
    embedding: `[${vectors[index].join(",")}]`,
  }));
  const { error: insertError } = await supabase.from("text_chunks").insert(rows);
  if (insertError) {
    throw new Error(`Image chunks could not be saved (${insertError.code}): ${insertError.message}`);
  }

  const { error: mediaError } = await supabase
    .from("media_items")
    .update({
      image_title_en: analysis.titleEn || null,
      image_title_es: analysis.titleEs || null,
      image_description: analysis.description || null,
      image_ocr_text: analysis.visibleText || null,
      image_keywords: [...new Set([...analysis.concepts, ...analysis.keywords])],
    })
    .eq("id", media.id)
    .eq("status", "processing");
  if (mediaError) {
    throw new Error(`Image analysis metadata could not be saved (${mediaError.code}): ${mediaError.message}`);
  }

  return rows.length;
}

async function createEmbeddings(texts) {
  if (!openAiApiKey) {
    if (!missingEmbeddingKeyLogged) {
      console.warn("[deacon][worker] OPENAI_API_KEY is not configured; transcripts will remain unembedded");
      missingEmbeddingKeyLogged = true;
    }
    return null;
  }

  const response = await fetch("https://api.openai.com/v1/embeddings", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${openAiApiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ model: EMBEDDING_MODEL, input: texts }),
  });

  const body = await response.json().catch(() => null);
  if (!response.ok) {
    const providerError = body?.error ?? {};
    const providerCode = providerError.code ?? providerError.type ?? null;
    const providerMessage = String(providerError.message ?? "").toLowerCase();
    const kind =
      providerCode === "insufficient_quota" ||
      providerMessage.includes("exceeded your current quota") ||
      providerMessage.includes("run out of credits") ||
      providerMessage.includes("billing details")
        ? "quota_exhausted"
        : response.status === 429 || providerCode === "rate_limit_exceeded"
          ? "rate_limited"
          : response.status === 401 || providerCode === "invalid_api_key"
            ? "authentication"
            : response.status >= 500
              ? "provider_unavailable"
              : "invalid_request";
    const error = new Error(`Embedding provider request failed: ${kind}`);
    error.name = "EmbeddingProviderError";
    error.cause = {
      kind,
      status: response.status,
      code: providerCode,
      requestId: response.headers.get("x-request-id"),
    };
    throw error;
  }

  const embeddings = body.data
    ?.sort((left, right) => left.index - right.index)
    .map((item) => item.embedding);

  if (!Array.isArray(embeddings) || embeddings.length !== texts.length) {
    throw new Error("Embedding response did not contain every requested vector");
  }

  return embeddings;
}

async function ensureTranscriptChunks(media, transcript) {
  const chunks = chunkTranscript(transcript.full_text ?? "");
  if (chunks.length === 0) {
    console.info("[deacon][worker] transcript has no text to index", { mediaId: media.id });
    return chunks;
  }

  const { error: deleteError } = await supabase
    .from("text_chunks")
    .delete()
    .eq("user_id", media.user_id)
    .eq("source_type", "transcript")
    .eq("source_id", media.id);

  if (deleteError) {
    throw new Error(`Existing chunks could not be cleared (${deleteError.code}): ${deleteError.message}`);
  }

  const rows = chunks.map((chunk, index) => ({
    user_id: media.user_id,
    session_id: media.session_id,
    source_type: "transcript",
    source_id: media.id,
    chunk_index: index,
    char_start: chunk.charStart,
    char_end: chunk.charEnd,
    content: chunk.content,
    embedding: null,
  }));

  const { error: insertError } = await supabase.from("text_chunks").insert(rows);
  if (insertError) {
    throw new Error(`Text chunks could not be saved (${insertError.code}): ${insertError.message}`);
  }

  console.info("[deacon][worker] transcript chunks indexed", {
    mediaId: media.id,
    chunkCount: rows.length,
    embeddingConfigured: Boolean(openAiApiKey),
  });
  return chunks;
}

async function embedTranscript(media, transcript) {
  const chunks = chunkTranscript(transcript.full_text ?? "");
  if (chunks.length === 0) {
    await updateProgress(
      media.id,
      { processing_stage: "ready", processing_progress: 100, processing_error_code: null },
      "ready",
    );
    return;
  }

  const vectors = [];
  for (let index = 0; index < chunks.length; index += EMBEDDING_BATCH_SIZE) {
    const batch = chunks.slice(index, index + EMBEDDING_BATCH_SIZE);
    const batchVectors = await createEmbeddings(batch.map((chunk) => chunk.content));
    if (!batchVectors) {
      await updateProgress(
        media.id,
        { processing_stage: "ready", processing_progress: 100, processing_error_code: null },
        "ready",
      );
      return;
    }
    vectors.push(...batchVectors);
    const progress = Math.min(90, 10 + Math.round(((index + batch.length) / chunks.length) * 80));
    await updateProgress(media.id, { processing_stage: "embedding", processing_progress: progress }, "ready");
  }

  const { error: deleteError } = await supabase
    .from("text_chunks")
    .delete()
    .eq("user_id", media.user_id)
    .eq("source_type", "transcript")
    .eq("source_id", media.id);

  if (deleteError) {
    throw new Error(`Existing chunks could not be cleared (${deleteError.code}): ${deleteError.message}`);
  }

  const rows = chunks.map((chunk, index) => ({
    user_id: media.user_id,
    session_id: media.session_id,
    source_type: "transcript",
    source_id: media.id,
    chunk_index: index,
    char_start: chunk.charStart,
    char_end: chunk.charEnd,
    content: chunk.content,
    embedding: `[${vectors[index].join(",")}]`,
  }));

  const { error: insertError } = await supabase.from("text_chunks").insert(rows);
  if (insertError) {
    throw new Error(`Chunks could not be saved (${insertError.code}): ${insertError.message}`);
  }

  await updateProgress(
    media.id,
    { processing_stage: "ready", processing_progress: 100, processing_error_code: null },
    "ready",
  );
  console.info("[deacon][worker] transcript embedded", {
    mediaId: media.id,
    chunkCount: rows.length,
  });
}

async function processPdf(media) {
  console.info("[deacon][worker] downloading PDF", { mediaId: media.id });
  const { data: file, error: downloadError } = await supabase.storage
    .from("media")
    .download(media.storage_key);

  if (downloadError || !file) {
    throw new Error(downloadError?.message ?? "Storage returned no file");
  }

  await updateProgress(media.id, {
    processing_stage: "reading",
    processing_progress: 35,
  });

  console.info("[deacon][worker] extracting PDF text", { mediaId: media.id });
  const parsed = await pdfParse(Buffer.from(await file.arrayBuffer()));
  const text = parsed.text.trim();

  await updateProgress(media.id, {
    processing_stage: "saving",
    processing_progress: 80,
  });

  const { error: transcriptError } = await supabase
    .from("transcripts")
    .upsert(
      {
        user_id: media.user_id,
        media_item_id: media.id,
        full_text: text,
        language: null,
      },
      { onConflict: "media_item_id" },
    );

  if (transcriptError) {
    throw new Error(`Transcript save failed (${transcriptError.code}): ${transcriptError.message}`);
  }

  await ensureTranscriptChunks(media, { full_text: text });

  await updateProgress(media.id, {
    status: "ready",
    processing_stage: "ready",
    processing_progress: 100,
    processing_error_code: null,
    processing_error_service: null,
    processing_error_message: null,
    processing_error_request_id: null,
    processing_completed_at: new Date().toISOString(),
  });
  console.info("[deacon][worker] PDF ready", { mediaId: media.id, textLength: text.length });
}

async function processImage(media) {
  if (!["image/jpeg", "image/png"].includes(media.mime_type)) {
    const error = new Error(`Image format is not supported by the vision lane: ${media.mime_type}`);
    error.name = "UnsupportedImageFormatError";
    throw error;
  }

  console.info("[deacon][worker] downloading image", { mediaId: media.id });
  const { data: file, error: downloadError } = await supabase.storage
    .from("media")
    .download(media.storage_key);
  if (downloadError || !file) {
    throw new Error(downloadError?.message ?? "Storage returned no image");
  }

  await updateProgress(media.id, { processing_stage: "reading", processing_progress: 25 });
  console.info("[deacon][worker] analyzing image", { mediaId: media.id, model: VISION_MODEL });
  const analysis = await analyzeImage(file, media.mime_type);

  await updateProgress(media.id, { processing_stage: "saving", processing_progress: 70 });
  const chunkCount = await saveImageAnalysis(media, analysis);

  await updateProgress(media.id, {
    status: "ready",
    processing_stage: "ready",
    processing_progress: 100,
    processing_error_code: null,
    processing_error_service: null,
    processing_error_message: null,
    processing_error_request_id: null,
    processing_completed_at: new Date().toISOString(),
  });
  console.info("[deacon][worker] image ready", { mediaId: media.id, chunkCount });
}

async function processOne(media) {
  try {
    await updateProgress(media.id, {
      processing_stage: "queued",
      processing_progress: 10,
      processing_attempts: (media.processing_attempts ?? 0) + 1,
      processing_started_at: new Date().toISOString(),
      processing_error_code: null,
      processing_error_service: null,
      processing_error_message: null,
      processing_error_request_id: null,
    });
    if (media.kind === "document" && media.mime_type === "application/pdf") {
      await processPdf(media);
      workerDegraded = false;
      return;
    }

    if (media.kind === "image") {
      await processImage(media);
      workerDegraded = false;
      return;
    }

    console.info("[deacon][worker] no processor for media kind yet", {
      mediaId: media.id,
      kind: media.kind,
      mimeType: media.mime_type,
    });
  } catch (error) {
    workerDegraded = true;
    console.error("[deacon][worker] processing failed", {
      mediaId: media.id,
      error: error instanceof Error ? error.message : String(error),
    });
    const providerDetails =
      error instanceof Error &&
      error.name === "VisionProviderError" &&
      error.cause &&
      typeof error.cause === "object"
        ? error.cause
        : null;
    const processingErrorCode =
      error instanceof Error && error.name === "UnsupportedImageFormatError"
        ? "image_format_unsupported"
        : providerDetails?.status === 401 || providerDetails?.status === 403
          ? "image_vision_permission_denied"
          : "processing_failed";
    const processingErrorService =
      error instanceof Error && error.name === "UnsupportedImageFormatError"
        ? "image_processor"
        : providerDetails
          ? "openai_vision"
          : "media_worker";
    const processingErrorMessage =
      processingErrorCode === "image_vision_permission_denied"
        ? providerDetails?.code === "missing_scope"
          ? "La clave de OpenAI necesita el permiso model.request."
          : "La clave de OpenAI no puede usar el modelo de visión."
        : processingErrorCode === "image_format_unsupported"
          ? "Este formato todavía no se puede convertir en el worker."
          : "El worker no pudo terminar el procesamiento.";
    await writeHealth("degraded", {
      last_error_at: new Date().toISOString(),
      last_error_code: processingErrorCode,
      last_error_message: processingErrorMessage,
    });
    const { error: updateError } = await supabase
      .from("media_items")
      .update({
        status: "failed",
        processing_stage: "failed",
        processing_error_code: processingErrorCode,
        processing_error_service: processingErrorService,
        processing_error_message: processingErrorMessage,
        processing_error_request_id: providerDetails?.requestId ?? null,
        processing_completed_at: new Date().toISOString(),
      })
      .eq("id", media.id);
    if (updateError) {
      console.error("[deacon][worker] failed status update", {
        mediaId: media.id,
        code: updateError.code,
        message: updateError.message,
      });
    }
  }
}

async function poll() {
  const { data: mediaItems, error } = await supabase
    .from("media_items")
    .select("id, user_id, session_id, kind, mime_type, storage_key, status, processing_attempts")
    .eq("status", "processing")
    .is("deleted_at", null)
    .order("created_at", { ascending: true })
    .limit(1);

  if (error) {
    console.error("[deacon][worker] queue poll failed", {
      code: error.code,
      message: error.message,
    });
    return;
  }

  const media = mediaItems?.[0];
  if (!media) return null;
  await processOne(media);
  return media.id;
}

export async function runWorkerOnce() {
  const processedMediaId = await poll();
  await pollPendingEmbeddings();
  await purgeExpiredDeletedMedia();
  await heartbeat(true);
  return { processedMediaId };
}

async function purgeExpiredDeletedMedia() {
  const cutoff = new Date(Date.now() - MEDIA_RECOVERY_WINDOW_MS).toISOString();
  const { data: expiredMedia, error } = await supabase
    .from("media_items")
    .select("id, user_id, storage_key, playback_key, thumbnail_key")
    .lt("deleted_at", cutoff)
    .order("deleted_at", { ascending: true })
    .limit(100);

  if (error) {
    console.error("[deacon][worker] expired media query failed", {
      code: error.code,
      message: error.message,
    });
    return;
  }

  for (const media of expiredMedia ?? []) {
    const storageKeys = [media.storage_key, media.playback_key, media.thumbnail_key].filter(Boolean);
    if (storageKeys.length > 0) {
      const { error: storageError } = await supabase.storage.from("media").remove(storageKeys);
      if (storageError) {
        console.error("[deacon][worker] expired media storage cleanup failed", {
          mediaId: media.id,
          message: storageError.message,
        });
        continue;
      }
    }

    const { error: chunksError } = await supabase
      .from("text_chunks")
      .delete()
      .eq("user_id", media.user_id)
      .eq("source_id", media.id);
    if (chunksError) {
      console.error("[deacon][worker] expired media chunk cleanup failed", {
        mediaId: media.id,
        message: chunksError.message,
      });
      continue;
    }

    const { error: mediaError } = await supabase
      .from("media_items")
      .delete()
      .eq("id", media.id)
      .eq("user_id", media.user_id);
    if (mediaError) {
      console.error("[deacon][worker] expired media row cleanup failed", {
        mediaId: media.id,
        message: mediaError.message,
      });
    } else {
      console.info("[deacon][worker] expired media purged", { mediaId: media.id });
    }
  }
}

async function pollPendingEmbeddings() {
  if (embeddingBlockedUntil > Date.now()) return;
  if (Date.now() - lastEmbeddingAttemptAt < (openAiApiKey ? EMBEDDING_RETRY_MS : 5_000)) return;
  lastEmbeddingAttemptAt = Date.now();

  if (!openAiApiKey && !missingEmbeddingKeyLogged) {
    console.warn(
      "[deacon][worker] OPENAI_API_KEY is not configured; lexical transcript search remains available",
    );
    missingEmbeddingKeyLogged = true;
  }

  const { data: transcripts, error } = await supabase
    .from("transcripts")
    .select("media_item_id, full_text")
    .limit(20);

  if (error) {
    console.error("[deacon][worker] transcript poll failed", {
      code: error.code,
      message: error.message,
    });
    return;
  }

  for (const transcript of transcripts ?? []) {
    const { data: media, error: mediaError } = await supabase
      .from("media_items")
      .select("id, user_id, session_id, status, deleted_at")
      .eq("id", transcript.media_item_id)
      .eq("status", "ready")
      .is("deleted_at", null)
      .maybeSingle();

    if (mediaError || !media) continue;

    const { data: pendingChunk, error: pendingChunkError } = await supabase
      .from("text_chunks")
      .select("id")
      .eq("source_type", "transcript")
      .eq("source_id", media.id)
      .is("embedding", "null")
      .limit(1)
      .maybeSingle();

    if (pendingChunkError) continue;

    const { data: anyChunk, error: anyChunkError } = await supabase
      .from("text_chunks")
      .select("id")
      .eq("source_type", "transcript")
      .eq("source_id", media.id)
      .limit(1)
      .maybeSingle();

    if (anyChunkError) continue;
    if (!anyChunk) {
      await ensureTranscriptChunks(media, transcript);
      if (!openAiApiKey) continue;
    }
    if (!pendingChunk) continue;

    try {
      await updateProgress(media.id, { processing_stage: "embedding", processing_progress: 10 }, "ready");
      await embedTranscript(media, transcript);
      lastEmbeddingAttemptAt = 0;
    } catch (embeddingError) {
      workerDegraded = true;
      const providerDetails =
        embeddingError instanceof Error &&
        embeddingError.name === "EmbeddingProviderError" &&
        embeddingError.cause &&
        typeof embeddingError.cause === "object"
          ? embeddingError.cause
          : null;
      if (providerDetails?.kind === "quota_exhausted" || providerDetails?.kind === "authentication") {
        embeddingBlockedUntil = Date.now() + EMBEDDING_BLOCKED_RETRY_MS;
      }
      console.error("[deacon][worker] transcript embedding failed", {
        mediaId: media.id,
        error: embeddingError instanceof Error ? embeddingError.message : String(embeddingError),
        provider: providerDetails,
      });
      await updateProgress(
        media.id,
        {
          processing_stage: "ready",
          processing_progress: 100,
          processing_error_code:
            providerDetails?.kind === "quota_exhausted" ? "embedding_quota_exhausted" : "embedding_failed",
          processing_error_service: "openai_embeddings",
          processing_error_message:
            providerDetails?.kind === "quota_exhausted"
              ? "Se agotó el crédito de embeddings; la búsqueda por palabras sigue disponible."
              : providerDetails?.kind === "permission_denied"
                ? "La clave de OpenAI no tiene permiso para embeddings."
                : "No se pudo completar la indexación semántica; la búsqueda por palabras sigue disponible.",
          processing_error_request_id: providerDetails?.requestId ?? null,
        },
        "ready",
      ).catch((statusError) => {
        console.error("[deacon][worker] could not restore ready status after embedding failure", {
          mediaId: media.id,
          error: statusError instanceof Error ? statusError.message : String(statusError),
        });
      });
      await writeHealth("degraded", {
        last_error_at: new Date().toISOString(),
        last_error_code: providerDetails?.kind === "quota_exhausted" ? "embedding_quota_exhausted" : "embedding_failed",
        last_error_message: "La indexación semántica falló; la búsqueda léxica sigue disponible.",
      });
    }
  }
}

if (process.argv[1]?.endsWith("scripts/process-media.mjs")) {
  console.info("[deacon][worker] started", { pollMs: POLL_MS });
  await writeHealth("ok", { last_success_at: new Date().toISOString() });
  while (true) {
    await runWorkerOnce();
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
}
