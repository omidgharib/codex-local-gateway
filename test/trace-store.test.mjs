import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { TraceStore } from "../src/trace-store.mjs";

test("tracks a successful request without prompt or response content", () => {
  let now = Date.parse("2026-01-01T00:00:00Z");
  const store = new TraceStore({ retentionMs: 60_000, maxEntries: 10, now: () => now });
  const trace = store.create({ id: "request-1", mode: "read-only", input_chars: 20 });
  now += 100;
  store.markRunning(trace);
  now += 500;
  store.markCompleted(trace, 42);

  assert.deepEqual(store.list()[0], {
    id: "request-1",
    mode: "read-only",
    input_chars: 20,
    status: "completed",
    queued_at: "2026-01-01T00:00:00.000Z",
    started_at: "2026-01-01T00:00:00.100Z",
    completed_at: "2026-01-01T00:00:00.600Z",
    execution_ms: 500,
    output_chars: 42,
  });
  assert.equal("input" in store.list()[0], false);
  assert.equal("output_text" in store.list()[0], false);
});

test("persists public trace metadata and restores it", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "gateway-traces-"));
  const persistPath = path.join(directory, "traces.json");
  try {
    const options = { retentionMs: 60_000, maxEntries: 10, captureContent: true, persistPath };
    const first = new TraceStore(options);
    const trace = first.create({ id: "persisted", mode: "read-only", workspace: "test", input_chars: 3 }, { input: "secret" });
    first.markRunning(trace);
    first.markCompleted(trace, { outputText: "secret output", events: [], stderr: "" });
    const onDisk = readFileSync(persistPath, "utf8");
    assert.doesNotMatch(onDisk, /secret/);
    const restored = new TraceStore(options);
    assert.equal(restored.get("persisted").status, "completed");
    assert.equal(restored.get("persisted").detail, undefined);
    assert.equal(restored.summary({ active: 0, queued: 0, concurrency: 1 }).success_rate, 1);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("captures the request, API response, and diagnostics only when enabled", () => {
  const store = new TraceStore({ retentionMs: 60_000, maxEntries: 10, captureContent: true });
  const request = { method: "POST", endpoint: "/v1/chat/completions", parameters: { messages: [{ role: "user", content: "hello" }] } };
  const trace = store.create({ id: "captured", mode: "read-only", input_chars: 5 }, request);
  store.markRunning(trace);
  store.markCompleted(trace, { outputText: "hello back", events: [{ type: "done" }], stderr: "warning" });
  const response = { id: "captured", object: "chat.completion", choices: [{ message: { content: "hello back" } }] };
  store.setResponse(trace, response);

  assert.deepEqual(store.get("captured").detail, {
    request,
    response,
    diagnostics: { events: [{ type: "done" }], stderr: "warning" },
  });
  assert.equal(store.get("captured").details_available, true);
});

test("prunes expired entries and enforces the maximum", () => {
  let now = 1_000_000;
  const store = new TraceStore({ retentionMs: 1_000, maxEntries: 2, now: () => now });
  store.create({ id: "one" });
  now += 100;
  store.create({ id: "two" });
  now += 100;
  store.create({ id: "three" });
  assert.deepEqual(store.list().map((item) => item.id), ["three", "two"]);
  now += 2_000;
  assert.deepEqual(store.list(), []);
});


test("failed tool parsing retains raw output only when content capture is enabled", () => {
  for (const captureContent of [false, true]) {
    const store = new TraceStore({ retentionMs: 60000, maxEntries: 10, captureContent });
    const trace = store.create({ id: "failed" }, { input: "request" });
    store.markFailed(trace, 502, new Error("invalid arguments"), { outputText: "raw invalid output", events: [], stderr: "" });
    const saved = store.get("failed");
    assert.equal(saved.status, "failed");
    if (captureContent) assert.equal(saved.detail.response.output_text, "raw invalid output");
    else assert.equal(saved.detail, undefined);
  }
});
