import test from "node:test";
import assert from "node:assert/strict";

test("appPath preserves root deployments", async () => {
  delete process.env.NEXT_PUBLIC_BASE_PATH;
  const loaded = await import(`../src/lib/app-path.ts?root=${Date.now()}`);
  assert.equal(loaded.appPath("/api/diagnostics"), "/api/diagnostics");
});

test("appPath prefixes a path-mounted deployment exactly once", async () => {
  process.env.NEXT_PUBLIC_BASE_PATH = "/deacon";
  const loaded = await import(`../src/lib/app-path.ts?mounted=${Date.now()}`);
  assert.equal(loaded.appPath("/api/diagnostics"), "/deacon/api/diagnostics");
  assert.equal(loaded.appPath("/deacon/api/diagnostics"), "/deacon/api/diagnostics");
  delete process.env.NEXT_PUBLIC_BASE_PATH;
});
