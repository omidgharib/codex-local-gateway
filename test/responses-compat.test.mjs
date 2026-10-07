import test from "node:test";
import assert from "node:assert/strict";
import { eventTextDelta, normalizeResponseRequest, resolveToolDecision, responseEnvelope, streamEvents } from "../src/responses-compat.mjs";

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

test("normalizes function tools and returns function_call output items", () => {
  const normalized = normalizeResponseRequest({
    input: "What is the weather in Tehran?",
    tools: [{
      type: "function",
      name: "get_weather",
      description: "Get weather",
      strict: true,
      parameters: {
        type: "object",
        properties: { city: { type: "string" } },
        required: ["city"],
        additionalProperties: false,
      },
    }],
    tool_choice: "required",
    parallel_tool_calls: false,
  }, null);
  assert.equal(normalized.usesToolProtocol, true);
  assert.match(normalized.prompt, /caller-owned function-calling protocol/);

  const decision = resolveToolDecision(normalized, JSON.stringify({
    kind: "function_calls",
    message: "",
    calls: [{ name: "get_weather", arguments: "{\"city\":\"Tehran\"}" }],
  }));
  const response = responseEnvelope({
    id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    createdAt: 1_700_000_000_000,
    outputText: "ignored",
    events: [{ type: "turn.completed", usage: { input_tokens: 10, output_tokens: 3 } }],
    queueWaitMs: 1,
    executionMs: 2,
    toolDecision: decision,
    includeEvents: true,
  });
  assert.equal(response.output_text, "");
  assert.equal(response.output[0].type, "function_call");
  assert.equal(response.output[0].name, "get_weather");
  assert.equal(response.events.length, 1);
});

test("accepts replayed function calls and outputs and enforces strict arguments", () => {
  const tools = [{
    type: "function",
    name: "get_weather",
    strict: true,
    parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"], additionalProperties: false },
  }];
  const request = normalizeResponseRequest({
    tools,
    input: [
      { role: "user", content: "Weather?" },
      { type: "function_call", call_id: "call_1", name: "get_weather", arguments: "{\"city\":\"Tehran\"}" },
      { type: "function_call_output", call_id: "call_1", output: "{\"temperature_c\":25}" },
    ],
  }, null);
  assert.match(request.prompt, /temperature_c/);
  assert.throws(() => resolveToolDecision(request, JSON.stringify({
    kind: "function_calls", message: "", calls: [{ name: "get_weather", arguments: "{\"unknown\":1}" }],
  })), /strict schema/);
  assert.throws(() => normalizeResponseRequest({
    tools,
    input: [{ type: "function_call_output", call_id: "missing", output: "x" }],
  }, null), /unknown call_id/);
  assert.throws(() => normalizeResponseRequest({
    input: "x",
    tools: [{ type: "function", name: "bad", strict: true, parameters: { type: "object", properties: { x: { type: "string" } } } }],
  }, null), /additionalProperties/);
});


test("structured Windows path and patch arguments round-trip without nested JSON encoding", () => {
  const tools = [{ type: "function", name: "read", parameters: { type: "object", properties: {
    filePath: { type: "string" }, offset: { type: "integer", minimum: 0 }, note: { anyOf: [{ type: "string" }, { type: "null" }] }
  }, required: ["filePath"], additionalProperties: false } },
  { type: "function", name: "apply_patch", parameters: { type: "object", properties: { patchText: { type: "string" } }, required: ["patchText"], additionalProperties: false } }];
  const request = normalizeResponseRequest({ input: "Generate tests", tools });
  assert.equal(request.outputSchema.properties.calls.items.anyOf[0].properties.arguments.type, "object");
  const filePath = 'C:\Users\Dotin\نمونه\table.story.tsx';
  const patchText = '*** Begin Patch\n+const label = "نمونه";\n*** End Patch';
  const decision = resolveToolDecision(request, JSON.stringify({ kind: "function_calls", message: "", calls: [
    { name: "read", arguments: { filePath, offset: null, note: null } },
    { name: "apply_patch", arguments: { patchText } }
  ] }));
  assert.deepEqual(JSON.parse(decision.calls[0].arguments), { filePath, note: null });
  assert.equal(JSON.parse(decision.calls[1].arguments).patchText, patchText);
  assert.throws(() => resolveToolDecision(request, JSON.stringify({ kind: "function_calls", message: "", calls: [
    { name: "read", arguments: { filePath, offset: "invalid" } }
  ] })), /schema/);
});
