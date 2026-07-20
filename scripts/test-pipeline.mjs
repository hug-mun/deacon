import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { execFileSync } from "node:child_process";
import path from "node:path";

function loadLocalEnv() {
  const values = {};
  try {
    const source = readFileSync(".env.local", "utf8");
    for (const line of source.split(/\r?\n/)) {
      const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
      if (match) values[match[1]] = match[2];
    }
  } catch {}
  return values;
}

const localEnv = loadLocalEnv();
try {
  const statusEnv = execFileSync("supabase", ["status", "-o", "env"], { encoding: "utf8" });
  for (const line of statusEnv.split(/\r?\n/)) {
    const match = line.match(/^([A-Z0-9_]+)="?(.*?)"?$/);
    if (match && ["API_URL", "ANON_KEY", "SERVICE_ROLE_KEY"].includes(match[1])) {
      if (match[1] === "API_URL") localEnv.NEXT_PUBLIC_SUPABASE_URL = match[2];
      if (match[1] === "ANON_KEY") localEnv.NEXT_PUBLIC_SUPABASE_ANON_KEY = match[2];
      if (match[1] === "SERVICE_ROLE_KEY") localEnv.SUPABASE_SERVICE_ROLE_KEY = match[2];
    }
  }
} catch {}
const endpoint = (process.env.DEACON_TEST_URL ?? "http://127.0.0.1:3100").replace(/\/$/, "");
const imagePath = process.env.DEACON_TEST_IMAGE_PATH;
if (!imagePath) {
  throw new Error("DEACON_TEST_IMAGE_PATH is required; point it at a real PNG or JPEG study image.");
}

const image = await readFile(imagePath);
const extension = path.extname(imagePath).toLowerCase();
const mimeType = extension === ".jpg" || extension === ".jpeg" ? "image/jpeg" : "image/png";
const originalFilename = path.basename(imagePath);
const fileHash = createHash("sha256").update(image).digest("hex");

async function appRequest(pathname, init = {}, cookie = "") {
  const headers = new Headers(init.headers);
  if (cookie) headers.set("cookie", cookie);
  const response = await fetch(`${endpoint}${pathname}`, { ...init, headers });
  const text = await response.text();
  let body = null;
  try { body = JSON.parse(text); } catch {}
  return { response, body };
}

const email = `codex-pipeline-${Date.now()}@example.test`;
const password = "TestPassword123!";
let userId;
let storageKey;
let worker;

try {
  const auth = await appRequest("/api/auth/password", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ mode: "signup", email, password, redirect_to: "/library" }),
  });
  if (!auth.response.ok || !auth.body?.user?.id) throw new Error(`auth failed (${auth.response.status})`);
  userId = auth.body.user.id;
  const setCookie = auth.response.headers.get("set-cookie") ?? "";
  const tokenCookie = setCookie.match(/(sb-[^=]+-auth-token=[^;]+)/)?.[1];
  if (!tokenCookie) throw new Error("Supabase session cookie missing");

  const prepared = await appRequest("/api/uploads/prepare", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      session_date: "2026-07-20",
      filename: originalFilename,
      mime_type: mimeType,
      size_bytes: image.byteLength,
      file_hash: fileHash,
    }),
  }, tokenCookie);
  if (!prepared.response.ok || prepared.body?.duplicate) throw new Error(`prepare failed (${prepared.response.status})`);
  storageKey = prepared.body.media.storage_key;

  const accessPayload = tokenCookie.split("=", 2)[1].replace(/^base64-/, "");
  const session = JSON.parse(Buffer.from(accessPayload, "base64").toString("utf8"));
  const storageUrl = `${localEnv.NEXT_PUBLIC_SUPABASE_URL}/storage/v1/object/media/${storageKey.split("/").map(encodeURIComponent).join("/")}`;
  const upload = await fetch(storageUrl, {
    method: "POST",
    headers: {
      apikey: localEnv.NEXT_PUBLIC_SUPABASE_ANON_KEY,
      Authorization: `Bearer ${session.access_token}`,
      "Content-Type": mimeType,
      "x-upsert": "false",
    },
    body: image,
  });
  if (!upload.ok) throw new Error(`storage upload failed (${upload.status})`);

  const completed = await appRequest("/api/uploads/complete", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ media_id: prepared.body.media.id }),
  }, tokenCookie);
  if (!completed.response.ok) throw new Error(`complete failed (${completed.response.status})`);

  worker = spawn(process.execPath, ["scripts/process-media.mjs"], {
    env: { ...process.env, ...localEnv, NEXT_PUBLIC_SUPABASE_URL: localEnv.NEXT_PUBLIC_SUPABASE_URL },
    stdio: "ignore",
  });

  let status;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 1500));
    const result = await appRequest(`/api/media/${prepared.body.media.id}/status`, {}, tokenCookie);
    status = result.body;
    if (status?.status === "ready" || status?.status === "failed") break;
  }
  if (!status || !["ready", "failed"].includes(status.status)) throw new Error("worker did not finish within 60 seconds");

  const expectedFailure = status.status === "failed" && status.processing_error_code === "image_vision_permission_denied";
  if (status.status === "failed" && !expectedFailure) {
    throw new Error(`pipeline failed at ${status.processing_error_service}: ${status.processing_error_code}`);
  }
  let searchMatched = null;
  if (status.status === "ready") {
    const search = await appRequest("/api/search?q=Credit%20balance", {}, tokenCookie);
    searchMatched = search.response.ok && (search.body?.results ?? []).some(
      (result) => result.media_item_id === prepared.body.media.id,
    );
    if (!searchMatched) throw new Error("processed image was ready but did not appear in search results");
  }
  console.log(JSON.stringify({
    mediaId: prepared.body.media.id,
    status: status.status,
    processingStage: status.processing_stage,
    processingErrorCode: status.processing_error_code ?? null,
    processingErrorService: status.processing_error_service ?? null,
    requestIdPresent: Boolean(status.processing_error_request_id),
    searchMatched,
    note: expectedFailure ? "Vision permission is still missing; the failure was classified correctly." : "Image processing completed.",
  }, null, 2));
} finally {
  if (worker) worker.kill("SIGTERM");
  if (storageKey && localEnv.NEXT_PUBLIC_SUPABASE_URL && localEnv.SUPABASE_SERVICE_ROLE_KEY) {
    await fetch(`${localEnv.NEXT_PUBLIC_SUPABASE_URL}/storage/v1/object/media/${storageKey.split("/").map(encodeURIComponent).join("/")}`, {
      method: "DELETE",
      headers: { apikey: localEnv.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${localEnv.SUPABASE_SERVICE_ROLE_KEY}` },
    }).catch(() => {});
  }
  if (userId && localEnv.NEXT_PUBLIC_SUPABASE_URL && localEnv.SUPABASE_SERVICE_ROLE_KEY) {
    await fetch(`${localEnv.NEXT_PUBLIC_SUPABASE_URL}/auth/v1/admin/users/${userId}`, {
      method: "DELETE",
      headers: { apikey: localEnv.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${localEnv.SUPABASE_SERVICE_ROLE_KEY}` },
    }).catch(() => {});
  }
}
