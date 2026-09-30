import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const token = "integration-test-token-that-is-long-enough";

test("serves Responses and Chat Completions with streaming and cancellation", { timeout: 20_000 }, async () => {
  const port = await freePort();
  const child = spawn(process.execPath, ["src/server.mjs"], {
    cwd: root,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      PORT: String(port),
      LOCAL_CODEX_GATEWAY_TOKEN: token,
      CODEX_ALLOWED_ROOTS: root,
      CODEX_BIN: process.execPath,
      CODEX_BIN_ARGS: JSON.stringify([path.join(root, "fixtures", "fake-codex.mjs")]),
      CODEX_HOME: root,
      CODEX_TRACE_CONTENT: "false",
    },
  });
  try {
    await waitForReady(child, port);
    const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };

    const modelsResponse = await fetch(`http://127.0.0.1:${port}/v1/models`, { headers });
    assert.equal(modelsResponse.status, 200);
    const models = await modelsResponse.json();
    assert.deepEqual(models.data.map((model) => model.id), ["fake-model"]);
    assert.equal(models.data[0].is_default, true);
    assert.deepEqual(models.data[0].supported_reasoning_efforts.map((item) => item.effort), ["medium"]);

    const hiddenModelsResponse = await fetch(`http://127.0.0.1:${port}/v1/models?include_hidden=true`, { headers });
    assert.deepEqual((await hiddenModelsResponse.json()).data.map((model) => model.id), ["fake-model", "hidden-model"]);

    const unauthenticatedModels = await fetch(`http://127.0.0.1:${port}/v1/models`);
    assert.equal(unauthenticatedModels.status, 401);

    const normal = await fetch(`http://127.0.0.1:${port}/v1/responses`, { method: "POST", headers, body: JSON.stringify({ input: "TEST" }) });
    assert.equal(normal.status, 200);
    assert.equal((await normal.json()).output_text, "RESPONSE_OK");

    const tools = [{
      type: "function",
      name: "get_weather",
      strict: true,
      parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"], additionalProperties: false },
    }];
    const toolResponse = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
      method: "POST",
      headers,
      body: JSON.stringify({ input: "Weather in Tehran?", tools, tool_choice: "required", include_events: true }),
    });
    assert.equal(toolResponse.status, 200);
    const toolBody = await toolResponse.json();
    assert.equal(toolBody.output[0].type, "function_call");
    assert.equal(toolBody.output[0].name, "get_weather");
    assert.ok(Array.isArray(toolBody.events));

    const finalResponse = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        tools,
        input: [
          { role: "user", content: "Weather in Tehran?" },
          toolBody.output[0],
          { type: "function_call_output", call_id: toolBody.output[0].call_id, output: "{\"temperature_c\":25}" },
        ],
      }),
    });
    assert.equal(finalResponse.status, 200);
    assert.equal((await finalResponse.json()).output_text, "The weather is 25 C.");

    const toolStream = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
      method: "POST",
      headers,
      body: JSON.stringify({ input: "Weather?", tools, tool_choice: "required", stream: true }),
    });
    const toolStreamText = await toolStream.text();
    assert.match(toolStreamText, /response\.function_call_arguments\.done/);
    assert.match(toolStreamText, /get_weather/);

    const chat = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, { method: "POST", headers, body: JSON.stringify({ messages: [{ role: "user", content: "CHAT_TEST" }], stream: true }) });
    const chatText = await chat.text();
    assert.match(chat.headers.get("content-type"), /text\/event-stream/);
    assert.match(chatText, /chat\.completion\.chunk/);
    assert.match(chatText, /CHAT_OK/);
    assert.match(chatText, /\[DONE\]/);

    const { type: ignoredToolType, ...chatFunction } = tools[0];
    const chatTools = [{ type: "function", function: chatFunction }];
    const chatToolResponse = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify({ messages: [{ role: "user", content: "Weather?" }], tools: chatTools, tool_choice: "required" }),
    });
    assert.equal(chatToolResponse.status, 200);
    const chatToolBody = await chatToolResponse.json();
    assert.equal(chatToolBody.choices[0].finish_reason, "tool_calls");
    const chatCall = chatToolBody.choices[0].message.tool_calls[0];
    assert.equal(chatCall.function.name, "get_weather");

    const chatFinalResponse = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        messages: [
          { role: "user", content: "Weather?" },
          chatToolBody.choices[0].message,
          { role: "tool", tool_call_id: chatCall.id, content: "{\"temperature_c\":25}" },
        ],
        tools: chatTools,
      }),
    });
    assert.equal(chatFinalResponse.status, 200);
    assert.equal((await chatFinalResponse.json()).choices[0].message.content, "The weather is 25 C.");

    const waiting = await fetch(`http://127.0.0.1:${port}/v1/responses`, { method: "POST", headers, body: JSON.stringify({ input: "WAIT_FOR_CANCEL", stream: true }) });
    const requestId = waiting.headers.get("x-request-id");
    const cancelled = await fetch(`http://127.0.0.1:${port}/v1/responses/${requestId}/cancel`, { method: "POST", headers: { authorization: `Bearer ${token}` } });
    assert.equal(cancelled.status, 200);
    assert.match(await waiting.text(), /Request cancelled/);
  } finally {
    child.kill();
    await new Promise((resolve) => child.once("close", resolve));
  }
});

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

function waitForReady(child, port) {
  return new Promise((resolve, reject) => {
    let output = "";
    const timer = setTimeout(() => reject(new Error(`Gateway did not start: ${output}`)), 5_000);
    child.stdout.on("data", async (chunk) => {
      output += chunk;
      if (!output.includes("listening on")) return;
      clearTimeout(timer);
      try {
        const response = await fetch(`http://127.0.0.1:${port}/health`);
        if (!response.ok) throw new Error(`health returned ${response.status}`);
        resolve();
      } catch (error) { reject(error); }
    });
    child.stderr.on("data", (chunk) => { output += chunk; });
    child.once("exit", (code) => reject(new Error(`Gateway exited with ${code}: ${output}`)));
  });
}
