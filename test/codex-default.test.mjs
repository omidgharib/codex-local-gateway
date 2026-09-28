import test from "node:test";
import assert from "node:assert/strict";
import { normalizeResponseRequest, responseEnvelope } from "../src/responses-compat.mjs";

test("does not pass a synthetic model override to Codex CLI", () => {
  const request = normalizeResponseRequest({ input: "Hello" }, null);
  assert.equal(request.model, null);
  const response = responseEnvelope({
    id: "id", createdAt: 0, model: request.model, outputText: "ok", events: [], queueWaitMs: 0, executionMs: 1,
  });
  assert.equal(response.model, "codex-default");
});
