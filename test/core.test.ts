import test from "node:test";
import assert from "node:assert/strict";
import { chunkText } from "../src/lib/retrieval/chunk-text.ts";
import { classifyOpenAiFailure } from "../src/lib/openai/provider-error.ts";
import { getProcessingProgress } from "../src/lib/media/processing-progress.ts";
import { verifyPkce, safeRedirectUri } from "../src/lib/mcp/oauth.ts";
import { createHash } from "node:crypto";
import { imageChunks, normalizeImageAnalysis } from "../scripts/image-analysis.mjs";

test("chunkText creates bounded overlapping chunks with stable locators", () => {
  const input = Array.from({ length: 5000 }, (_, index) => `word${index}`).join(" ");
  const chunks = chunkText(input);

  assert.ok(chunks.length >= 3);
  assert.ok(chunks.every((chunk) => chunk.content.length <= 1800));
  assert.equal(chunks[0].charStart, 0);
  assert.ok(chunks[1].charStart < chunks[0].charEnd);
  assert.equal(chunks.at(-1)?.charEnd, input.length);
});

test("OpenAI missing_scope errors are classified as a permission failure", () => {
  const failure = classifyOpenAiFailure(
    401,
    { error: { code: "missing_scope", message: "Missing scopes: model.request" } },
    new Headers({ "x-request-id": "req_test" }),
  );

  assert.equal(failure.kind, "permission_denied");
  assert.equal(failure.code, "missing_scope");
  assert.equal(failure.requestId, "req_test");
});

test("OpenAI quota and rate-limit failures remain distinguishable", () => {
  assert.equal(
    classifyOpenAiFailure(429, { error: { code: "insufficient_quota" } }).kind,
    "quota_exhausted",
  );
  assert.equal(
    classifyOpenAiFailure(429, { error: { code: "rate_limit_exceeded" } }).kind,
    "rate_limited",
  );
});

test("processing progress never pretends a queued file is complete", () => {
  const queued = getProcessingProgress({
    status: "processing",
    actualProgress: 0,
    startedAt: 0,
    now: 45_000,
  });
  assert.equal(queued.progress, 53);
  assert.equal(queued.estimated, true);

  const longRunning = getProcessingProgress({
    status: "processing",
    actualProgress: 0,
    startedAt: 0,
    now: 300_000,
  });
  assert.equal(longRunning.progress, 90);
  assert.equal(longRunning.estimated, true);

  const ready = getProcessingProgress({
    status: "ready",
    actualProgress: 100,
    startedAt: 0,
    now: 300_000,
  });
  assert.deepEqual(ready, { progress: 100, estimated: false });
});

test("MCP PKCE validation accepts S256 and rejects a different verifier", () => {
  const verifier = "test-verifier-with-enough-entropy";
  const challenge = createHash("sha256").update(verifier).digest("base64url");

  assert.equal(verifyPkce(verifier, challenge), true);
  assert.equal(verifyPkce("wrong-verifier", challenge), false);
});

test("MCP redirect validation only accepts the configured ChatGPT prefix", () => {
  const previous = process.env.MCP_OAUTH_REDIRECT_PREFIX;
  process.env.MCP_OAUTH_REDIRECT_PREFIX = "https://chatgpt.com/connector/oauth/";
  assert.equal(safeRedirectUri("https://chatgpt.com/connector/oauth/callback"), true);
  assert.equal(safeRedirectUri("https://evil.example/callback"), false);
  assert.equal(safeRedirectUri("https://chatgpt.com/connector/oauth/callback\nattack"), false);
  if (previous === undefined) delete process.env.MCP_OAUTH_REDIRECT_PREFIX;
  else process.env.MCP_OAUTH_REDIRECT_PREFIX = previous;
});

test("image analysis keeps bilingual titles in the searchable vision chunk", () => {
  const analysis = normalizeImageAnalysis({
    titleEn: "Atopic dermatitis: flexural pattern",
    titleEs: "Dermatitis atópica: patrón flexural",
    description: "A dermatology teaching image showing an erythematous flexural pattern.",
    concepts: ["atopic dermatitis"],
  });

  const visionChunk = imageChunks(analysis).find((chunk) => chunk.sourceType === "image_vision");
  assert.ok(visionChunk);
  assert.match(visionChunk.content, /Atopic dermatitis/);
  assert.match(visionChunk.content, /Dermatitis atópica/);
  assert.match(visionChunk.content, /erythematous flexural pattern/);
});

test("image analysis bounds generated titles and ignores invalid title values", () => {
  const analysis = normalizeImageAnalysis({
    titleEn: "x".repeat(200),
    titleEs: 42,
  });

  assert.equal(analysis.titleEn.length, 140);
  assert.equal(analysis.titleEs, "");
});
