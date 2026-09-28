import { httpError } from "./codex.mjs";

const supportedFields = new Set([
  "input",
  "instructions",
  "model",
  "stream",
  // Local gateway extensions retained for backwards compatibility.
  "mode",
  "working_directory",
  "include_events",
]);

export function normalizeResponseRequest(body, defaultModel) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw httpError(400, "request body must be a JSON object");
  }

  const unsupported = Object.keys(body).filter((key) => !supportedFields.has(key));
  if (unsupported.length) {
    throw httpError(400, `Unsupported Responses API parameter${unsupported.length > 1 ? "s" : ""}: ${unsupported.join(", ")}`, {
      unsupported_parameters: unsupported,
      supported_parameters: [...supportedFields],
    });
  }
  if (body.stream === true) {
    throw httpError(400, "stream=true is not supported by this Codex CLI gateway", { parameter: "stream" });
  }
  if (body.stream !== undefined && typeof body.stream !== "boolean") {
    throw httpError(400, "stream must be a boolean", { parameter: "stream" });
  }
  if (body.instructions !== undefined && typeof body.instructions !== "string") {
    throw httpError(400, "instructions must be a string", { parameter: "instructions" });
  }
  if (body.model !== undefined && (typeof body.model !== "string" || !body.model.trim())) {
    throw httpError(400, "model must be a non-empty string", { parameter: "model" });
  }

  const input = normalizeInput(body.input);
  const instructions = body.instructions?.trim();
  return {
    ...body,
    model: body.model?.trim() || defaultModel || "codex-default",
    prompt: instructions ? `Instructions:\n${instructions}\n\nInput:\n${input}` : input,
  };
}

function normalizeInput(input) {
  if (typeof input === "string" && input.trim()) return input.trim();
  if (!Array.isArray(input) || input.length === 0) {
    throw httpError(400, "input must be a non-empty string or supported message array", { parameter: "input" });
  }

  const messages = input.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw inputError(index, "must be an object");
    }
    const role = typeof item.role === "string" ? item.role : "user";
    const text = contentToText(item.content, index);
    return `${role}: ${text}`;
  });
  const joined = messages.join("\n\n").trim();
  if (!joined) throw httpError(400, "input must contain at least one text item", { parameter: "input" });
  return joined;
}

function contentToText(content, index) {
  if (typeof content === "string" && content.trim()) return content.trim();
  if (!Array.isArray(content) || content.length === 0) {
    throw inputError(index, "content must be text or an array of input_text items");
  }
  return content.map((part) => {
    if (part?.type !== "input_text" || typeof part.text !== "string") {
      throw inputError(index, "only content items of type input_text are supported");
    }
    return part.text;
  }).join("\n").trim();
}

function inputError(index, message) {
  return httpError(400, `input[${index}] ${message}`, { parameter: "input" });
}

export function responseEnvelope({ id, createdAt, model, outputText, events, queueWaitMs, executionMs }) {
  return {
    id,
    object: "response",
    created_at: Math.floor(createdAt / 1000),
    status: "completed",
    model,
    output: [{
      id: `msg_${id.replaceAll("-", "")}`,
      type: "message",
      status: "completed",
      role: "assistant",
      content: [{ type: "output_text", text: outputText, annotations: [] }],
    }],
    output_text: outputText,
    error: null,
    incomplete_details: null,
    usage: extractUsage(events),
    // Local gateway timing extensions.
    queue_wait_ms: queueWaitMs,
    execution_ms: executionMs,
  };
}

function extractUsage(events) {
  const usage = events.find((event) => event.type === "turn.completed")?.usage;
  if (!usage) return null;
  const inputTokens = usage.input_tokens || 0;
  const outputTokens = usage.output_tokens || 0;
  return {
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    total_tokens: inputTokens + outputTokens,
    input_tokens_details: { cached_tokens: usage.cached_input_tokens || 0 },
    output_tokens_details: { reasoning_tokens: usage.reasoning_output_tokens || 0 },
  };
}
