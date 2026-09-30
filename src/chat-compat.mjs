import { httpError } from "./codex.mjs";
import { normalizeResponseRequest } from "./responses-compat.mjs";

const supportedFields = new Set([
  "model", "messages", "stream", "reasoning_effort", "response_format", "metadata", "store",
  "tools", "tool_choice", "parallel_tool_calls",
  "max_tokens", "stream_options",
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
  const maxTokens = normalizeMaxTokens(body.max_tokens);
  const streamOptions = normalizeStreamOptions(body.stream_options, body.stream);
  const input = body.messages.flatMap((message, index) => normalizeMessage(message, index));
  const normalized = normalizeResponseRequest({
    input,
    model: body.model,
    stream: body.stream,
    reasoning: body.reasoning_effort ? { effort: body.reasoning_effort } : undefined,
    text: normalizeResponseFormat(body.response_format),
    metadata: body.metadata,
    store: body.store,
    tools: normalizeChatTools(body.tools),
    tool_choice: normalizeChatToolChoice(body.tool_choice),
    parallel_tool_calls: body.parallel_tool_calls,
    mode: body.mode,
    working_directory: body.working_directory,
    include_events: body.include_events,
  }, defaultModel);
  return { ...normalized, maxTokens, streamOptions };
}

function normalizeMaxTokens(value) {
  if (value === undefined) return null;
  if (!Number.isInteger(value) || value < 1) {
    throw httpError(400, "max_tokens must be a positive integer", { parameter: "max_tokens" });
  }
  // Codex CLI does not currently expose an exact output-token cap. Keep this
  // compatibility field so OpenAI Chat Completions clients can interoperate.
  return value;
}

function normalizeStreamOptions(value, stream) {
  if (value === undefined) return { include_usage: false };
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw httpError(400, "stream_options must be an object", { parameter: "stream_options" });
  }
  const unsupported = Object.keys(value).filter((key) => key !== "include_usage");
  if (unsupported.length) {
    throw httpError(400, `Unsupported stream_options parameter${unsupported.length > 1 ? "s" : ""}: ${unsupported.join(", ")}`, {
      parameter: "stream_options",
      unsupported_parameters: unsupported,
    });
  }
  if (value.include_usage !== undefined && typeof value.include_usage !== "boolean") {
    throw httpError(400, "stream_options.include_usage must be a boolean", { parameter: "stream_options.include_usage" });
  }
  if (stream !== true) {
    throw httpError(400, "stream_options requires stream to be true", { parameter: "stream_options" });
  }
  return { include_usage: value.include_usage === true };
}

function normalizeMessage(message, index) {
  if (!message || typeof message !== "object" || Array.isArray(message)) throw httpError(400, `messages[${index}] must be an object`);
  if (!["developer", "system", "user", "assistant", "tool"].includes(message.role)) {
    throw httpError(400, `messages[${index}].role is not supported`, { parameter: "messages" });
  }
  if (message.role === "tool") {
    if (typeof message.tool_call_id !== "string" || !message.tool_call_id) {
      throw httpError(400, `messages[${index}].tool_call_id is required for tool messages`, { parameter: "messages" });
    }
    if (typeof message.content !== "string") throw httpError(400, `messages[${index}].content must be text`, { parameter: "messages" });
    return [{ type: "function_call_output", call_id: message.tool_call_id, output: message.content }];
  }
  if (message.role === "assistant" && message.tool_calls !== undefined) {
    if (!Array.isArray(message.tool_calls) || message.tool_calls.length === 0) {
      throw httpError(400, `messages[${index}].tool_calls must be a non-empty array`, { parameter: "messages" });
    }
    const items = [];
    if (typeof message.content === "string" && message.content.trim()) {
      items.push({ role: "assistant", content: [{ type: "input_text", text: message.content.trim() }] });
    }
    for (const [callIndex, call] of message.tool_calls.entries()) {
      if (call?.type !== "function" || typeof call.id !== "string" || typeof call.function?.name !== "string" || typeof call.function?.arguments !== "string") {
        throw httpError(400, `messages[${index}].tool_calls[${callIndex}] is invalid`, { parameter: "messages" });
      }
      items.push({ type: "function_call", call_id: call.id, name: call.function.name, arguments: call.function.arguments });
    }
    return items;
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
  return [{ role: message.role, content: [{ type: "input_text", text: content }] }];
}

function normalizeChatTools(tools) {
  if (tools === undefined) return undefined;
  if (!Array.isArray(tools)) throw httpError(400, "tools must be an array", { parameter: "tools" });
  return tools.map((tool, index) => {
    if (tool?.type !== "function" || !tool.function || typeof tool.function !== "object") {
      throw httpError(400, `tools[${index}] must be a function tool`, { parameter: "tools" });
    }
    return { type: "function", ...tool.function };
  });
}

function normalizeChatToolChoice(choice) {
  if (choice === undefined || typeof choice === "string") return choice;
  if (choice?.type === "function" && typeof choice.function?.name === "string") {
    return { type: "function", name: choice.function.name };
  }
  throw httpError(400, "unsupported tool_choice object", { parameter: "tool_choice" });
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

export function chatEnvelope({ id, createdAt, model, outputText, output, usage, metadata = null, events, includeEvents = false }) {
  const calls = output?.filter((item) => item.type === "function_call") || [];
  const message = calls.length ? {
    role: "assistant",
    content: null,
    refusal: null,
    tool_calls: calls.map((call) => ({
      id: call.call_id,
      type: "function",
      function: { name: call.name, arguments: call.arguments },
    })),
  } : { role: "assistant", content: outputText, refusal: null };
  return {
    id: `chatcmpl-${id.replaceAll("-", "")}`,
    object: "chat.completion",
    created: Math.floor(createdAt / 1000),
    model: model || "codex-default",
    choices: [{ index: 0, message, logprobs: null, finish_reason: calls.length ? "tool_calls" : "stop" }],
    usage: usage ? {
      prompt_tokens: usage.input_tokens,
      completion_tokens: usage.output_tokens,
      total_tokens: usage.total_tokens,
    } : null,
    metadata,
    ...(includeEvents ? { events } : {}),
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

export function chatUsageChunk({ id, createdAt, model, usage }) {
  return {
    id: `chatcmpl-${id.replaceAll("-", "")}`,
    object: "chat.completion.chunk",
    created: Math.floor(createdAt / 1000),
    model: model || "codex-default",
    choices: [],
    usage: usage ? {
      prompt_tokens: usage.input_tokens,
      completion_tokens: usage.output_tokens,
      total_tokens: usage.total_tokens,
    } : null,
  };
}
