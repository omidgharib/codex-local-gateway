import { spawn } from "node:child_process";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadLocalEnv } from "../src/local-env.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
loadLocalEnv(path.join(root, ".env.local"));
const token = process.env.LOCAL_CODEX_GATEWAY_TOKEN;
if (!token) throw new Error("LOCAL_CODEX_GATEWAY_TOKEN is required");

const port = await freePort();
const child = spawn(process.execPath, ["src/server.mjs"], {
  cwd: root,
  windowsHide: true,
  stdio: ["ignore", "pipe", "pipe"],
  env: { ...process.env, PORT: String(port), CODEX_ALLOW_WRITES: "false" },
});

try {
  await waitForReady(child, port);
  const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
  const tools = [{
    type: "function",
    name: "lookup_temperature",
    description: "Return the current temperature for a city from the caller's private sensor service.",
    strict: true,
    parameters: {
      type: "object",
      properties: { city: { type: "string" } },
      required: ["city"],
      additionalProperties: false,
    },
  }];

  const first = await request(port, headers, {
    input: "Use lookup_temperature to find the temperature in Tehran. Do not guess it.",
    tools,
    tool_choice: { type: "function", name: "lookup_temperature" },
    parallel_tool_calls: false,
  });
  const call = first.output.find((item) => item.type === "function_call");
  if (!call) throw new Error(`Expected function_call, received: ${JSON.stringify(first.output)}`);
  const args = JSON.parse(call.arguments);
  if (args.city.toLowerCase() !== "tehran") throw new Error(`Unexpected arguments: ${call.arguments}`);

  const second = await request(port, headers, {
    input: [
      { role: "user", content: "Use lookup_temperature to find the temperature in Tehran. Do not guess it." },
      call,
      { type: "function_call_output", call_id: call.call_id, output: JSON.stringify({ city: "Tehran", temperature_c: 23, source: "smoke-test-sensor" }) },
    ],
    tools,
    tool_choice: "auto",
    parallel_tool_calls: false,
  });
  if (!second.output_text || !/23/.test(second.output_text)) {
    throw new Error(`Expected a final answer using the tool result, received: ${second.output_text}`);
  }
  const filePath = path.win32.normalize('C:/gateway-fixture/نمونه/table.tsx');
  const windowsTools = [
    { type: "function", name: "read", description: "Read a file using the caller, not your runtime.", parameters: { type: "object", properties: { filePath: { type: "string" }, offset: { type: "integer" }, limit: { type: "integer" } }, required: ["filePath"], additionalProperties: false } },
    { type: "function", name: "apply_patch", parameters: { type: "object", properties: { patchText: { type: "string" } }, required: ["patchText"], additionalProperties: false } }
  ];
  const windows = await request(port, headers, {
    input: "Return exactly one caller-owned read call with filePath=" + JSON.stringify(filePath) + ". Omit offset and limit. Do not access files yourself. This is a serialization check.",
    tools: windowsTools, tool_choice: "required", parallel_tool_calls: false,
  });
  const windowsCall = windows.output.find(item => item.type === "function_call");
  const windowsArgs = JSON.parse(windowsCall?.arguments || "{}");
  if (windowsCall?.name !== "read" || windowsArgs.filePath !== filePath || "offset" in windowsArgs || "limit" in windowsArgs) {
    throw new Error("Windows path or optional arguments failed to round-trip");
  }
  process.stdout.write(JSON.stringify({
    ok: true,
    windows_path_round_trip: true,
    optional_arguments_omitted: true,
    first_response_type: call.type,
    function_name: call.name,
    arguments: args,
    final_output: second.output_text,
  }, null, 2));
} finally {
  child.kill();
  await new Promise((resolve) => child.once("close", resolve));
}

async function request(port, headers, body) {
  const response = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(310_000),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(`${response.status}: ${result.error?.message} (${result.error?.request_id})`);
  return result;
}

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

function waitForReady(process, port) {
  return new Promise((resolve, reject) => {
    let output = "";
    const timer = setTimeout(() => reject(new Error(`Gateway did not start: ${output}`)), 10_000);
    process.stdout.on("data", async (chunk) => {
      output += chunk;
      if (!output.includes("listening on")) return;
      clearTimeout(timer);
      try {
        const response = await fetch(`http://127.0.0.1:${port}/health`);
        if (!response.ok) throw new Error(`health returned ${response.status}`);
        resolve();
      } catch (error) { reject(error); }
    });
    process.stderr.on("data", (chunk) => { output += chunk; });
    process.once("exit", (code) => reject(new Error(`Gateway exited with ${code}: ${output}`)));
  });
}
