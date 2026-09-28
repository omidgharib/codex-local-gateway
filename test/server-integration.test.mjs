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

    const normal = await fetch(`http://127.0.0.1:${port}/v1/responses`, { method: "POST", headers, body: JSON.stringify({ input: "TEST" }) });
    assert.equal(normal.status, 200);
    assert.equal((await normal.json()).output_text, "RESPONSE_OK");

    const chat = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, { method: "POST", headers, body: JSON.stringify({ messages: [{ role: "user", content: "CHAT_TEST" }], stream: true }) });
    const chatText = await chat.text();
    assert.match(chat.headers.get("content-type"), /text\/event-stream/);
    assert.match(chatText, /chat\.completion\.chunk/);
    assert.match(chatText, /CHAT_OK/);
    assert.match(chatText, /\[DONE\]/);

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
