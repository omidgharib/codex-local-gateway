import { writeFile } from "node:fs/promises";

const args = process.argv.slice(2);
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
