import { spawn, spawnSync } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createClient } from "@supabase/supabase-js";
// Import the parser implementation directly. The package root runs its own
// fixture test when bundled as a serverless dependency.
import pdfParse from "pdf-parse/lib/pdf-parse.js";
import WebSocket from "ws";
import { imageChunks, normalizeImageAnalysis } from "./image-analysis.mjs";

const POLL_MS = 1500;
const EMBEDDING_MODEL = "text-embedding-3-small";
const TRANSCRIPTION_MODEL = "whisper-1";
// whisper-1 rejects uploads over 25 MB; 32 kbps mono covers ~100 min under that cap.
const TRANSCRIPTION_UPLOAD_LIMIT_BYTES = 24 * 1024 * 1024;
// Video transcript chunks stay small (~60-90s of speech) so search results can
// seek close to the spoken moment.
const VIDEO_CHUNK_TARGET_CHARS = 900;
const VISION_MODEL = process.env.OPENAI_VISION_MODEL || "gpt-5.6-luna";
const VISION_DETAIL = process.env.OPENAI_VISION_DETAIL || "low";
const EMBEDDING_BATCH_SIZE = 64;
const EMBEDDING_RETRY_MS = 60_000;
const EMBEDDING_BLOCKED_RETRY_MS = 15 * 60_000;
const WORKER_HEARTBEAT_MS = 15_000;
const WORKER_INSTANCE_ID = process.env.WORKER_INSTANCE_ID || `${hostname()}-${process.pid}`;
const MEDIA_RECOVERY_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
const STALE_UPLOAD_WINDOW_MS = 15 * 60 * 1000;
const SUPPORT_EMAIL = "hello@hugmun.ai";
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

// Video processing needs ffmpeg (Docker worker / local dev). The Vercel lane has
// no ffmpeg, so instances without it leave video items for a capable worker.
const ffmpegAvailable = (() => {
  try {
    return spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).status === 0;
  } catch {
    return false;
  }
})();

function providerDetailsFromError(error) {
  if (
    error instanceof Error &&
    ["VisionProviderError", "EmbeddingProviderError"].includes(error.name) &&
    error.cause &&
    typeof error.cause === "object"
  ) {
    return error.cause;
  }
  return null;
}

function processingFailureMessage(code) {
  switch (code) {
    case "embedding_quota_exhausted":
      return "No pudimos añadir este contenido porque el crédito de IA no está disponible. No se guardó en la búsqueda. Escríbenos a hello@hugmun.ai para que lo revisemos.";
    case "embedding_permission_denied":
    case "embedding_configuration_error":
      return "No pudimos añadir este contenido porque la configuración de IA necesita atención. No se guardó en la búsqueda. Escríbenos a hello@hugmun.ai para que lo revisemos.";
    case "image_vision_quota_exhausted":
      return "No pudimos analizar esta imagen porque el crédito de IA no está disponible. No se guardó en la búsqueda. Escríbenos a hello@hugmun.ai para que lo revisemos.";
    case "image_vision_permission_denied":
      return "No pudimos analizar esta imagen porque la configuración de IA necesita atención. No se guardó en la búsqueda. Escríbenos a hello@hugmun.ai para que lo revisemos.";
    case "transcription_quota_exhausted":
      return "No pudimos transcribir este video porque el crédito de IA no está disponible. No se guardó en la búsqueda. Escríbenos a hello@hugmun.ai para que lo revisemos.";
    case "transcription_permission_denied":
    case "transcription_configuration_error":
      return "No pudimos transcribir este video porque la configuración de IA necesita atención. No se guardó en la búsqueda. Escríbenos a hello@hugmun.ai para que lo revisemos.";
    case "video_too_long":
      return "Este video es demasiado largo para transcribirlo (máximo ~100 minutos). Divídelo en partes más cortas e inténtalo de nuevo.";
    default:
      return "Estamos teniendo problemas para añadir más información. No se guardó este contenido en la búsqueda. Escríbenos a hello@hugmun.ai para que lo revisemos.";
  }
}

async function rollbackMediaIndex(media) {
  const failures = [];
  const { error: chunksError } = await supabase
    .from("text_chunks")
    .delete()
    .eq("user_id", media.user_id)
    .eq("source_id", media.id);
  if (chunksError) failures.push(`chunks: ${chunksError.message}`);

  const { error: transcriptError } = await supabase
    .from("transcripts")
    .delete()
    .eq("user_id", media.user_id)
    .eq("media_item_id", media.id);
  if (transcriptError) failures.push(`transcript: ${transcriptError.message}`);

  const { error: metadataError } = await supabase
    .from("media_items")
    .update({
      image_title_en: null,
      image_title_es: null,
      image_description: null,
      image_ocr_text: null,
      image_keywords: [],
    })
    .eq("id", media.id)
    .eq("user_id", media.user_id);
  if (metadataError) failures.push(`metadata: ${metadataError.message}`);

  if (failures.length > 0) {
    console.error("[deacon][worker] rollback incomplete", { mediaId: media.id, failures });
  }
  return failures;
}

async function notifySupport(media, details) {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.RESEND_FROM_EMAIL;
  if (!apiKey || !from) {
    console.warn("[deacon][worker] support email not configured", {
      mediaId: media.id,
      missing: [!apiKey ? "RESEND_API_KEY" : null, !from ? "RESEND_FROM_EMAIL" : null].filter(Boolean),
    });
    return;
  }

  try {
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from,
        to: [SUPPORT_EMAIL],
        subject: `[Deacon] No se pudo añadir contenido (${details.code})`,
        text: [
          "Deacon detectó un error de procesamiento.",
          "",
          `Archivo: ${media.original_filename ?? "sin nombre"}`,
          `Media ID: ${media.id}`,
          `Usuario ID: ${media.user_id}`,
          `Código: ${details.code}`,
          `Servicio: ${details.service}`,
          `Request ID: ${details.requestId ?? "no disponible"}`,
          `Detalle técnico: ${details.technicalMessage}`,
          "",
          "La operación fue revertida y el archivo quedó disponible para reintentar.",
        ].join("\n"),
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      console.error("[deacon][worker] support email failed", {
        mediaId: media.id,
        status: response.status,
        response: await response.text().catch(() => ""),
      });
    }
  } catch (error) {
    console.error("[deacon][worker] support email request failed", {
      mediaId: media.id,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

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

// Group whisper segments into ~VIDEO_CHUNK_TARGET_CHARS chunks aligned to speech
// boundaries. Chunks keep char offsets into the joined transcript text plus the
// start/end timecodes that power seek-to-moment search results.
function chunkTranscriptSegments(segments) {
  const chunks = [];
  let group = [];
  let groupLength = 0;

  const flush = () => {
    if (group.length === 0) return;
    chunks.push({
      content: group.map((segment) => segment.text).join(" "),
      charStart: group[0].charStart,
      charEnd: group[group.length - 1].charEnd,
      startMs: group[0].start_ms,
      endMs: group[group.length - 1].end_ms,
    });
    // One-segment overlap keeps sentences that straddle a boundary searchable.
    group = group.slice(-1);
    groupLength = group.reduce((total, segment) => total + segment.text.length + 1, 0);
  };

  for (const segment of segments) {
    group.push(segment);
    groupLength += segment.text.length + 1;
    if (groupLength >= VIDEO_CHUNK_TARGET_CHARS) flush();
  }
  if (group.length > (chunks.length > 0 ? 1 : 0)) flush();

  return chunks;
}

// Normalize whisper verbose_json segments: trim text, compute char offsets over
// the joined transcript so chunk offsets and full_text stay consistent.
function normalizeWhisperSegments(rawSegments) {
  const segments = [];
  let cursor = 0;
  for (const segment of rawSegments ?? []) {
    const text = String(segment.text ?? "").trim();
    if (!text) continue;
    const charStart = cursor;
    cursor += text.length + 1;
    segments.push({
      start_ms: Math.max(0, Math.round(Number(segment.start) * 1000)),
      end_ms: Math.max(0, Math.round(Number(segment.end) * 1000)),
      text,
      charStart,
      charEnd: charStart + text.length,
    });
  }
  return segments;
}

function transcriptChunksFor(transcript) {
  const segments = Array.isArray(transcript.segments) ? transcript.segments : null;
  if (segments && segments.length > 0) {
    let normalized = segments;
    if (normalized.some((segment) => segment.charStart === undefined)) {
      // Segments loaded from the database lack char offsets; recompute them.
      normalized = normalizeWhisperSegments(
        normalized.map((segment) => ({
          start: (segment.start_ms ?? 0) / 1000,
          end: (segment.end_ms ?? 0) / 1000,
          text: segment.text,
        })),
      );
    }
    return chunkTranscriptSegments(normalized);
  }
  return chunkTranscript(transcript.full_text ?? "");
}

function runCommand(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (data) => {
      stdout += data;
    });
    child.stderr.on("data", (data) => {
      stderr = `${stderr}${data}`.slice(-4000);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(`${command} exited with code ${code}: ${stderr.slice(-500)}`));
    });
  });
}

async function transcribeAudio(audioPath, filename) {
  if (!openAiApiKey) {
    throw new Error("OPENAI_API_KEY is required to transcribe videos");
  }

  const audio = await readFile(audioPath);
  const form = new FormData();
  form.append("file", new Blob([audio], { type: "audio/mpeg" }), filename);
  form.append("model", TRANSCRIPTION_MODEL);
  form.append("response_format", "verbose_json");
  form.append("timestamp_granularities[]", "segment");

  const response = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: { Authorization: `Bearer ${openAiApiKey}` },
    body: form,
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
            : response.status === 403 || providerCode === "missing_scope" || providerCode === "insufficient_permissions"
              ? "permission_denied"
              : response.status >= 500
                ? "provider_unavailable"
                : "invalid_request";
    const error = new Error(`Transcription provider request failed: ${kind}`);
    error.name = "TranscriptionProviderError";
    error.cause = {
      kind,
      status: response.status,
      code: providerCode,
      requestId: response.headers.get("x-request-id"),
    };
    throw error;
  }

  return body;
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
    const providerCode = providerError.code ?? providerError.type ?? null;
    const providerMessage = String(providerError.message ?? "").toLowerCase();
    const kind =
      providerCode === "insufficient_quota" ||
      providerMessage.includes("exceeded your current quota") ||
      providerMessage.includes("run out of credits") ||
      providerMessage.includes("billing details")
        ? "quota_exhausted"
        : response.status === 429
          ? "rate_limited"
          : response.status === 403 || providerCode === "missing_scope" || providerCode === "insufficient_permissions"
            ? "permission_denied"
            : response.status === 401 || providerCode === "invalid_api_key"
              ? "authentication"
              : response.status >= 500
                ? "provider_unavailable"
                : "invalid_request";
    const error = new Error(`Vision provider request failed: ${providerError.message ?? response.status}`);
    error.name = "VisionProviderError";
    error.cause = {
      kind,
      status: response.status,
      code: providerCode,
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
            : response.status === 403 || providerCode === "missing_scope" || providerCode === "insufficient_permissions"
              ? "permission_denied"
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
  const chunks = transcriptChunksFor(transcript);
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
    start_ms: chunk.startMs ?? null,
    end_ms: chunk.endMs ?? null,
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
  const chunks = transcriptChunksFor(transcript);
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
    start_ms: chunk.startMs ?? null,
    end_ms: chunk.endMs ?? null,
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

async function processVideo(media) {
  const workDir = await mkdtemp(join(tmpdir(), "deacon-video-"));
  const videoPath = join(workDir, "original");
  const audioPath = join(workDir, "audio.mp3");

  try {
    console.info("[deacon][worker] downloading video", { mediaId: media.id });
    const { data: file, error: downloadError } = await supabase.storage
      .from("media")
      .download(media.storage_key);
    if (downloadError || !file) {
      throw new Error(downloadError?.message ?? "Storage returned no video");
    }
    // Stream to disk: videos can be hundreds of MB and must not be buffered in memory.
    await pipeline(Readable.fromWeb(file.stream()), createWriteStream(videoPath));

    await updateProgress(media.id, { processing_stage: "extracting", processing_progress: 25 });
    console.info("[deacon][worker] extracting audio", { mediaId: media.id });
    await runCommand("ffmpeg", [
      "-y", "-v", "error",
      "-i", videoPath,
      "-vn", "-ac", "1", "-ar", "16000", "-b:a", "32k",
      audioPath,
    ]);

    let durationMs = null;
    try {
      const probed = await runCommand("ffprobe", [
        "-v", "error",
        "-show_entries", "format=duration",
        "-of", "default=noprint_wrappers=1:nokey=1",
        videoPath,
      ]);
      const seconds = Number.parseFloat(probed.trim());
      if (Number.isFinite(seconds)) durationMs = Math.round(seconds * 1000);
    } catch (probeError) {
      console.warn("[deacon][worker] video duration probe failed", {
        mediaId: media.id,
        error: probeError instanceof Error ? probeError.message : String(probeError),
      });
    }

    const audioStat = await stat(audioPath);
    if (audioStat.size > TRANSCRIPTION_UPLOAD_LIMIT_BYTES) {
      const error = new Error(
        `Extracted audio is ${audioStat.size} bytes; the transcription provider limit is ${TRANSCRIPTION_UPLOAD_LIMIT_BYTES}`,
      );
      error.name = "VideoTooLongError";
      throw error;
    }

    await updateProgress(media.id, { processing_stage: "transcribing", processing_progress: 45 });
    console.info("[deacon][worker] transcribing audio", {
      mediaId: media.id,
      model: TRANSCRIPTION_MODEL,
      audioBytes: audioStat.size,
    });
    const result = await transcribeAudio(audioPath, "audio.mp3");
    const segments = normalizeWhisperSegments(result.segments);
    const fullText = segments.map((segment) => segment.text).join(" ");

    await updateProgress(media.id, { processing_stage: "saving", processing_progress: 80 });
    const { error: transcriptError } = await supabase
      .from("transcripts")
      .upsert(
        {
          user_id: media.user_id,
          media_item_id: media.id,
          full_text: fullText,
          language: result.language ?? null,
          segments: segments.map((segment) => ({
            start_ms: segment.start_ms,
            end_ms: segment.end_ms,
            text: segment.text,
          })),
        },
        { onConflict: "media_item_id" },
      );
    if (transcriptError) {
      throw new Error(`Transcript save failed (${transcriptError.code}): ${transcriptError.message}`);
    }

    await ensureTranscriptChunks(media, { full_text: fullText, segments });

    await updateProgress(media.id, {
      status: "ready",
      processing_stage: "ready",
      processing_progress: 100,
      ...(durationMs !== null ? { duration_ms: durationMs } : {}),
      processing_error_code: null,
      processing_error_service: null,
      processing_error_message: null,
      processing_error_request_id: null,
      processing_completed_at: new Date().toISOString(),
    });
    console.info("[deacon][worker] video ready", {
      mediaId: media.id,
      durationMs,
      segmentCount: segments.length,
      textLength: fullText.length,
    });
  } finally {
    await rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
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

    if (media.kind === "video") {
      await processVideo(media);
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
    const providerDetails = providerDetailsFromError(error);
    const isEmbeddingFailure = error instanceof Error && error.name === "EmbeddingProviderError";
    const isVisionFailure = error instanceof Error && error.name === "VisionProviderError";
    const isTranscriptionFailure = error instanceof Error && error.name === "TranscriptionProviderError";
    const processingErrorCode =
      error instanceof Error && error.name === "UnsupportedImageFormatError"
        ? "image_format_unsupported"
        : error instanceof Error && error.name === "VideoTooLongError"
          ? "video_too_long"
          : isTranscriptionFailure && providerDetails?.kind === "quota_exhausted"
            ? "transcription_quota_exhausted"
            : isTranscriptionFailure && providerDetails?.kind === "permission_denied"
              ? "transcription_permission_denied"
              : isTranscriptionFailure && providerDetails?.kind === "authentication"
                ? "transcription_configuration_error"
                : isTranscriptionFailure
                  ? "transcription_failed"
        : isEmbeddingFailure && providerDetails?.kind === "quota_exhausted"
          ? "embedding_quota_exhausted"
          : isEmbeddingFailure && providerDetails?.kind === "permission_denied"
            ? "embedding_permission_denied"
            : isEmbeddingFailure && providerDetails?.kind === "authentication"
              ? "embedding_configuration_error"
              : isVisionFailure && providerDetails?.kind === "quota_exhausted"
                ? "image_vision_quota_exhausted"
                : isVisionFailure && (providerDetails?.kind === "permission_denied" || providerDetails?.status === 401 || providerDetails?.status === 403)
                  ? "image_vision_permission_denied"
                  : "processing_failed";
    const processingErrorService =
      isEmbeddingFailure
        ? "openai_embeddings"
        : isVisionFailure
          ? "openai_vision"
          : isTranscriptionFailure
            ? "openai_transcription"
            : error instanceof Error && error.name === "UnsupportedImageFormatError"
              ? "image_processor"
              : "media_worker";
    const processingErrorMessage =
      processingErrorCode === "image_format_unsupported"
        ? "Este formato todavía no se puede convertir en el worker."
        : processingFailureMessage(processingErrorCode);
    await rollbackMediaIndex(media);
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
    await notifySupport(media, {
      code: processingErrorCode,
      service: processingErrorService,
      requestId: providerDetails?.requestId ?? null,
      technicalMessage: error instanceof Error ? error.message : String(error),
    });
  }
}

async function poll() {
  let query = supabase
    .from("media_items")
    .select("id, user_id, session_id, kind, mime_type, storage_key, original_filename, status, processing_attempts")
    .eq("status", "processing")
    .is("deleted_at", null)
    .order("created_at", { ascending: true })
    .limit(1);
  // Instances without ffmpeg (the Vercel lane) leave videos queued for the
  // Docker worker instead of blocking the rest of the queue behind them.
  if (!ffmpegAvailable) query = query.neq("kind", "video");
  const { data: mediaItems, error } = await query;

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
  await markStaleUploads();
  const processedMediaId = await poll();
  await pollPendingEmbeddings();
  await purgeExpiredDeletedMedia();
  await heartbeat(true);
  return { processedMediaId };
}

async function markStaleUploads() {
  const cutoff = new Date(Date.now() - STALE_UPLOAD_WINDOW_MS).toISOString();
  const { data: staleUploads, error } = await supabase
    .from("media_items")
    .select("id")
    .eq("status", "uploading")
    .is("deleted_at", null)
    .lt("created_at", cutoff)
    .limit(100);

  if (error) {
    console.error("[deacon][worker] stale upload query failed", {
      code: error.code,
      message: error.message,
    });
    return;
  }

  for (const media of staleUploads ?? []) {
    const { error: updateError } = await supabase
      .from("media_items")
      .update({
        status: "failed",
        processing_stage: "failed",
        processing_error_code: "upload_incomplete",
        processing_error_service: "upload",
        processing_error_message: "La carga no terminó. El archivo puede borrarse o volver a cargarse.",
        processing_completed_at: new Date().toISOString(),
      })
      .eq("id", media.id)
      .eq("status", "uploading")
      .is("deleted_at", null);
    if (updateError) {
      console.error("[deacon][worker] stale upload update failed", {
        mediaId: media.id,
        message: updateError.message,
      });
    } else {
      console.warn("[deacon][worker] stale upload marked failed", { mediaId: media.id });
    }
  }
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
    .select("media_item_id, full_text, segments")
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
      .select("id, user_id, session_id, original_filename, status, deleted_at")
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
      const providerDetails = providerDetailsFromError(embeddingError);
      if (
        providerDetails?.kind === "quota_exhausted" ||
        providerDetails?.kind === "authentication" ||
        providerDetails?.kind === "permission_denied"
      ) {
        embeddingBlockedUntil = Date.now() + EMBEDDING_BLOCKED_RETRY_MS;
      }
      console.error("[deacon][worker] transcript embedding failed", {
        mediaId: media.id,
        error: embeddingError instanceof Error ? embeddingError.message : String(embeddingError),
        provider: providerDetails,
      });
      const processingErrorCode =
        providerDetails?.kind === "quota_exhausted"
          ? "embedding_quota_exhausted"
          : providerDetails?.kind === "permission_denied"
            ? "embedding_permission_denied"
            : providerDetails?.kind === "authentication"
              ? "embedding_configuration_error"
              : "embedding_failed";
      const processingErrorMessage = processingFailureMessage(processingErrorCode);
      await rollbackMediaIndex(media);
      const { error: failedStatusError } = await supabase
        .from("media_items")
        .update({
          status: "failed",
          processing_stage: "failed",
          processing_progress: 100,
          processing_error_code: processingErrorCode,
          processing_error_service: "openai_embeddings",
          processing_error_message: processingErrorMessage,
          processing_error_request_id: providerDetails?.requestId ?? null,
          processing_completed_at: new Date().toISOString(),
        })
        .eq("id", media.id)
        .eq("status", "ready");
      if (failedStatusError) {
        console.error("[deacon][worker] could not mark embedding failure", {
          mediaId: media.id,
          error: failedStatusError.message,
        });
      }
      await notifySupport(media, {
        code: processingErrorCode,
        service: "openai_embeddings",
        requestId: providerDetails?.requestId ?? null,
        technicalMessage: embeddingError instanceof Error ? embeddingError.message : String(embeddingError),
      });
      await writeHealth("degraded", {
        last_error_at: new Date().toISOString(),
        last_error_code: processingErrorCode,
        last_error_message: processingErrorMessage,
      });
      if (["quota_exhausted", "authentication", "permission_denied"].includes(providerDetails?.kind)) {
        break;
      }
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
