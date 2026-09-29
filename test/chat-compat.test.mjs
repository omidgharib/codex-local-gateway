import test from "node:test";
import assert from "node:assert/strict";
import { chatChunk, chatEnvelope, normalizeChatRequest } from "../src/chat-compat.mjs";

test("normalizes text-only chat messages", () => {
  const request = normalizeChatRequest({ model: "m", messages: [{ role: "user", content: "Hello" }] }, null);
  assert.equal(request.model, "m");
  assert.match(request.prompt, /user: Hello/);
});

test("maps Chat Completions structured output", () => {
  const request = normalizeChatRequest({
    messages: [{ role: "user", content: "Return JSON" }],
    response_format: { type: "json_schema", json_schema: { name: "x", schema: { type: "object" } } },
  }, null);
  assert.equal(request.outputSchema.type, "object");
});

test("creates chat completion and streaming chunk envelopes", () => {
  const completion = chatEnvelope({ id: "a-b", createdAt: 1000, model: null, outputText: "Hi", usage: { input_tokens: 2, output_tokens: 1, total_tokens: 3 } });
  assert.equal(completion.object, "chat.completion");
  assert.equal(completion.choices[0].message.content, "Hi");
  assert.equal(completion.usage.total_tokens, 3);
  const chunk = chatChunk({ id: "a-b", createdAt: 1000, model: null, delta: { content: "H" } });
  assert.equal(chunk.object, "chat.completion.chunk");
});

test("rejects unsupported Chat Completions fields and malformed tool messages", () => {
  assert.throws(() => normalizeChatRequest({ messages: [{ role: "user", content: "Hi" }], temperature: 1 }, null), /temperature/);
  assert.throws(() => normalizeChatRequest({ messages: [{ role: "tool", content: "Hi" }] }, null), /tool_call_id/);
});

test("normalizes Chat Completions tools and tool result messages", () => {
  const request = normalizeChatRequest({
    messages: [
      { role: "user", content: "Weather?" },
      { role: "assistant", content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: "get_weather", arguments: "{\"city\":\"Tehran\"}" } }] },
      { role: "tool", tool_call_id: "call_1", content: "25 C" },
    ],
    tools: [{ type: "function", function: { name: "get_weather", parameters: { type: "object" } } }],
  }, null);
  assert.equal(request.tools[0].name, "get_weather");
  assert.match(request.prompt, /25 C/);

  const completion = chatEnvelope({
    id: "a-b",
    createdAt: 1000,
    outputText: "",
    output: [{ type: "function_call", call_id: "call_1", name: "get_weather", arguments: "{}" }],
  });
  assert.equal(completion.choices[0].finish_reason, "tool_calls");
  assert.equal(completion.choices[0].message.tool_calls[0].function.name, "get_weather");
});
