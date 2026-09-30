import { writeFile } from "node:fs/promises";

const args = process.argv.slice(2);
if (args.includes("app-server")) {
  let pending = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    pending += chunk;
    const lines = pending.split(/\r?\n/);
    pending = lines.pop() || "";
    for (const line of lines) {
      if (!line) continue;
      const request = JSON.parse(line);
      if (request.id === undefined) continue;
      if (request.method === "initialize") respond(request.id, { userAgent: "fake-codex" });
      if (request.method === "model/list") respond(request.id, {
        data: [
          {
            id: "fake-model",
            model: "fake-model",
            displayName: "Fake Model",
            description: "Model used by integration tests",
            hidden: false,
            isDefault: true,
            defaultReasoningEffort: "medium",
            supportedReasoningEfforts: [{ reasoningEffort: "medium", description: "Balanced" }],
            inputModalities: ["text", "image"],
          },
          {
            id: "hidden-model",
            model: "hidden-model",
            displayName: "Hidden Model",
            description: "Hidden test model",
            hidden: true,
            isDefault: false,
            defaultReasoningEffort: "low",
            supportedReasoningEfforts: [],
            inputModalities: ["text"],
          },
        ],
        nextCursor: null,
      });
    }
  });
  await new Promise(() => {});
}

const outputIndex = args.indexOf("--output-last-message");
const outputFile = outputIndex === -1 ? null : args[outputIndex + 1];
let prompt = "";
for await (const chunk of process.stdin) prompt += chunk;

if (prompt.includes("WAIT_FOR_CANCEL")) await new Promise(() => {});

let outputText;
if (prompt.includes("caller-owned function-calling protocol")) {
  outputText = prompt.includes("function_call_output")
    ? JSON.stringify({ kind: "message", message: "The weather is 25 C.", calls: [] })
    : JSON.stringify({ kind: "function_calls", message: "", calls: [{ name: "get_weather", arguments: JSON.stringify({ city: "Tehran" }) }] });
} else {
  outputText = prompt.includes("CHAT_TEST") ? "CHAT_OK" : "RESPONSE_OK";
}
process.stdout.write(`${JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: outputText } })}\n`);
process.stdout.write(`${JSON.stringify({ type: "turn.completed", usage: { input_tokens: 4, output_tokens: 2 } })}\n`);
if (outputFile) await writeFile(outputFile, outputText, "utf8");

function respond(id, result) {
  process.stdout.write(`${JSON.stringify({ id, result })}\n`);
}
