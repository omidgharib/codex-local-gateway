import test from "node:test";
import assert from "node:assert/strict";
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
