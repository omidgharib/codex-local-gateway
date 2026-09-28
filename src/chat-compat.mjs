import { httpError } from "./codex.mjs";
import { normalizeResponseRequest } from "./responses-compat.mjs";

const supportedFields = new Set([
  "model", "messages", "stream", "reasoning_effort", "response_format", "metadata", "store",
  "mode", "working_directory", "include_events",
]);

export function normalizeChatRequest(body, defaultModel) {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw httpError(400, "request body must be a JSON object");
  const unsupported = Object.keys(body).filter((key) => !supportedFields.has(key));
  if (unsupported.length) throw httpError(400, `Unsupported Chat Completions parameter${unsupported.length > 1 ? "s" : ""}: ${unsupported.join(", ")}`, {
    unsupported_parameters: unsupported,
    supported_parameters: [...supportedFields],
  });
  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    throw httpError(400, "messages must be a non-empty array", { parameter: "messages" });
  }
  const input = body.messages.map((message, index) => normalizeMessage(message, index));
  return normalizeResponseRequest({
    input,
    model: body.model,
    stream: body.stream,
    reasoning: body.reasoning_effort ? { effort: body.reasoning_effort } : undefined,
    text: normalizeResponseFormat(body.response_format),
    metadata: body.metadata,
    store: body.store,
    mode: body.mode,
    working_directory: body.working_directory,
    include_events: body.include_events,
  }, defaultModel);
}

function normalizeMessage(message, index) {
  if (!message || typeof message !== "object" || Array.isArray(message)) throw httpError(400, `messages[${index}] must be an object`);
  if (!["developer", "system", "user", "assistant"].includes(message.role)) {
    throw httpError(400, `messages[${index}].role is not supported`, { parameter: "messages" });
  }
  const content = typeof message.content === "string"
    ? message.content
    : Array.isArray(message.content)
      ? message.content.map((part) => {
        if (part?.type !== "text" || typeof part.text !== "string") throw httpError(400, `messages[${index}] only supports text content parts`);
        return part.text;
      }).join("\n")
      : null;
  if (!content?.trim()) throw httpError(400, `messages[${index}].content must contain text`);
  return { role: message.role, content: [{ type: "input_text", text: content }] };
}

function normalizeResponseFormat(format) {
  if (format === undefined) return undefined;
  if (!format || typeof format !== "object" || Array.isArray(format)) throw httpError(400, "response_format must be an object");
  if (format.type === "text") return { format: { type: "text" } };
  if (format.type === "json_schema" && format.json_schema?.schema) {
    return { format: { type: "json_schema", ...format.json_schema } };
  }
  throw httpError(400, "response_format must be text or json_schema with a schema", { parameter: "response_format" });
}

export function chatEnvelope({ id, createdAt, model, outputText, usage, metadata = null }) {
  return {
    id: `chatcmpl-${id.replaceAll("-", "")}`,
    object: "chat.completion",
    created: Math.floor(createdAt / 1000),
    model: model || "codex-default",
    choices: [{ index: 0, message: { role: "assistant", content: outputText, refusal: null }, logprobs: null, finish_reason: "stop" }],
    usage: usage ? {
      prompt_tokens: usage.input_tokens,
      completion_tokens: usage.output_tokens,
      total_tokens: usage.total_tokens,
    } : null,
    metadata,
  };
}

export function chatChunk({ id, createdAt, model, delta, finishReason = null }) {
  return {
    id: `chatcmpl-${id.replaceAll("-", "")}`,
    object: "chat.completion.chunk",
    created: Math.floor(createdAt / 1000),
    model: model || "codex-default",
    choices: [{ index: 0, delta, logprobs: null, finish_reason: finishReason }],
  };
}
