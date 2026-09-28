import test from "node:test";
import assert from "node:assert/strict";
import { normalizeResponseRequest, responseEnvelope } from "../src/responses-compat.mjs";

test("normalizes supported Responses-style input and model", () => {
  const request = normalizeResponseRequest({
    model: "gpt-5.6-terra",
    instructions: "Be concise.",
    input: [{ role: "user", content: [{ type: "input_text", text: "Hello" }] }],
    stream: false,
  }, null);

  assert.equal(request.model, "gpt-5.6-terra");
  assert.equal(request.prompt, "Instructions:\nBe concise.\n\nInput:\nuser: Hello");
});

test("rejects unsupported Responses parameters explicitly", () => {
  assert.throws(
    () => normalizeResponseRequest({ input: "Hi", temperature: 0.2 }, null),
    /Unsupported Responses API parameter: temperature/,
  );
  assert.throws(
    () => normalizeResponseRequest({ input: "Hi", stream: true }, null),
    /stream=true is not supported/,
  );
});

test("returns a Responses-shaped completion envelope", () => {
  const response = responseEnvelope({
    id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    createdAt: 1_700_000_000_000,
    model: "gpt-5.6-terra",
    outputText: "Hello",
    events: [{ type: "turn.completed", usage: { input_tokens: 10, output_tokens: 3 } }],
    queueWaitMs: 5,
    executionMs: 10,
  });

  assert.equal(response.object, "response");
  assert.equal(response.status, "completed");
  assert.equal(response.output[0].content[0].text, "Hello");
  assert.equal(response.usage.total_tokens, 13);
});
