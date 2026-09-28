import test from "node:test";
import assert from "node:assert/strict";
import { eventTextDelta, normalizeResponseRequest, responseEnvelope, streamEvents } from "../src/responses-compat.mjs";

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
});

test("accepts streaming and translates Codex agent messages", () => {
  const request = normalizeResponseRequest({ input: "Hi", stream: true }, null);
  assert.equal(request.stream, true);
  assert.equal(eventTextDelta({ type: "item.completed", item: { type: "agent_message", text: "Hello" } }), "Hello");
  assert.equal(eventTextDelta({ type: "turn.started" }), null);
  assert.equal(streamEvents({ id: "id", createdAt: 1_700_000_000_000, model: "m" }).created.type, "response.created");
});

test("normalizes reasoning, structured output, metadata, and stateless storage", () => {
  const request = normalizeResponseRequest({
    input: "Return a result",
    reasoning: { effort: "high" },
    text: { format: { type: "json_schema", name: "result", strict: true, schema: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"], additionalProperties: false } } },
    metadata: { source: "test" },
    store: false,
  }, null);
  assert.equal(request.reasoningEffort, "high");
  assert.equal(request.outputSchema.type, "object");
  assert.deepEqual(request.metadata, { source: "test" });
});

test("rejects unsupported stateful storage and malformed compatibility fields", () => {
  assert.throws(() => normalizeResponseRequest({ input: "Hi", store: true }, null), /stateless/);
  assert.throws(() => normalizeResponseRequest({ input: "Hi", reasoning: { effort: "extreme" } }, null), /reasoning\.effort/);
  assert.throws(() => normalizeResponseRequest({ input: "Hi", text: { format: { type: "json_schema" } } }, null), /schema/);
});

test("extracts Responses image inputs without embedding them in the prompt", () => {
  const request = normalizeResponseRequest({
    input: [{ role: "user", content: [
      { type: "input_text", text: "Describe it" },
      { type: "input_image", image_url: "data:image/png;base64,iVBORw0KGgo=" },
    ] }],
  }, null);
  assert.equal(request.inputImages.length, 1);
  assert.match(request.prompt, /attached image/);
  assert.doesNotMatch(request.prompt, /iVBOR/);
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
