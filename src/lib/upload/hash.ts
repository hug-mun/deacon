// Files above this size are fingerprinted from samples instead of fully hashed:
// hashing requires the whole file as one ArrayBuffer, which can crash iPad
// Safari for multi-hundred-MB videos. The sampled fingerprint (size + first and
// last 8 MB) is still deterministic per file, which is all deduplication needs.
const FULL_HASH_LIMIT = 100 * 1024 * 1024;
const SAMPLE_BYTES = 8 * 1024 * 1024;

async function digestToHex(buffer: ArrayBuffer) {
  const digest = await crypto.subtle.digest("SHA-256", buffer);

  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export async function sha256File(file: File) {
  if (file.size <= FULL_HASH_LIMIT) {
    return digestToHex(await file.arrayBuffer());
  }

  const head = await file.slice(0, SAMPLE_BYTES).arrayBuffer();
  const tail = await file.slice(Math.max(0, file.size - SAMPLE_BYTES)).arrayBuffer();
  const size = new TextEncoder().encode(String(file.size));
  const combined = new Uint8Array(size.byteLength + head.byteLength + tail.byteLength);
  combined.set(size, 0);
  combined.set(new Uint8Array(head), size.byteLength);
  combined.set(new Uint8Array(tail), size.byteLength + head.byteLength);
  return digestToHex(combined.buffer);
}
