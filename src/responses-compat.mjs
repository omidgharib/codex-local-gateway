import { httpError } from "./codex.mjs";
import { buildToolPrompt, normalizeToolChoice, normalizeTools, parseToolDecision, toolOutputSchema } from "./tool-calling.mjs";

const supportedFields = new Set([
  "input",
  "instructions",
  "model",
  "stream",
  "reasoning",
  "text",
  "metadata",
  "store",
  "tools",
  "tool_choice",
  "parallel_tool_calls",
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
  if (body.stream !== undefined && typeof body.stream !== "boolean") {
    throw httpError(400, "stream must be a boolean", { parameter: "stream" });
  }
  if (body.instructions !== undefined && typeof body.instructions !== "string") {
    throw httpError(400, "instructions must be a string", { parameter: "instructions" });
  }
  if (body.model !== undefined && (typeof body.model !== "string" || !body.model.trim())) {
    throw httpError(400, "model must be a non-empty string", { parameter: "model" });
  }
  if (body.store !== undefined && body.store !== false) {
    throw httpError(400, "store must be false because this gateway is stateless", { parameter: "store" });
  }

  const input = normalizeInput(body.input);
  const instructions = body.instructions?.trim();
  const reasoningEffort = normalizeReasoning(body.reasoning);
  const requestedOutputSchema = normalizeText(body.text);
  const metadata = normalizeMetadata(body.metadata);
  const tools = normalizeTools(body.tools);
  for (const call of input.transcript.filter((item) => item.type === "function_call")) {
    if (!tools.some((tool) => tool.name === call.name)) {
      throw httpError(400, `input function_call references undefined tool: ${call.name}`, { parameter: "tools" });
    }
  }
  const toolChoice = normalizeToolChoice(body.tool_choice, tools);
  if (body.parallel_tool_calls !== undefined && typeof body.parallel_tool_calls !== "boolean") {
    throw httpError(400, "parallel_tool_calls must be a boolean", { parameter: "parallel_tool_calls" });
  }
  const parallelToolCalls = body.parallel_tool_calls ?? true;
  const usesToolProtocol = tools.length > 0 && toolChoice !== "none";
  const outputSchema = usesToolProtocol ? toolOutputSchema(tools, toolChoice, parallelToolCalls) : requestedOutputSchema;
  const prompt = usesToolProtocol
    ? buildToolPrompt({ transcript: input.transcript, tools, toolChoice, parallelToolCalls, instructions, finalOutputSchema: requestedOutputSchema })
    : instructions ? `Instructions:\n${instructions}\n\nInput:\n${input.text}` : input.text;
  return {
    ...body,
    model: body.model?.trim() || defaultModel || null,
    reasoningEffort,
    outputSchema,
    metadata,
    tools,
    toolChoice,
    parallelToolCalls,
    usesToolProtocol,
    requestedOutputSchema,
    inputImages: input.images,
    transcript: input.transcript,
    prompt,
  };
}

function normalizeReasoning(reasoning) {
  if (reasoning === undefined) return null;
  if (!reasoning || typeof reasoning !== "object" || Array.isArray(reasoning)) {
    throw httpError(400, "reasoning must be an object", { parameter: "reasoning" });
  }
  const unsupported = Object.keys(reasoning).filter((key) => key !== "effort");
  if (unsupported.length) throw httpError(400, `Unsupported reasoning parameter: ${unsupported.join(", ")}`, { parameter: "reasoning" });
  const allowed = ["none", "minimal", "low", "medium", "high", "xhigh"];
  if (!allowed.includes(reasoning.effort)) {
    throw httpError(400, `reasoning.effort must be one of: ${allowed.join(", ")}`, { parameter: "reasoning.effort" });
  }
  return reasoning.effort;
}

function normalizeText(text) {
  if (text === undefined) return null;
  if (!text || typeof text !== "object" || Array.isArray(text)) {
    throw httpError(400, "text must be an object", { parameter: "text" });
  }
  const unsupported = Object.keys(text).filter((key) => key !== "format");
  if (unsupported.length) throw httpError(400, `Unsupported text parameter: ${unsupported.join(", ")}`, { parameter: "text" });
  const format = text.format;
  if (!format || typeof format !== "object" || Array.isArray(format)) {
    throw httpError(400, "text.format must be an object", { parameter: "text.format" });
  }
  if (format.type === "text") return null;
  if (format.type !== "json_schema") {
    throw httpError(400, "text.format.type must be text or json_schema", { parameter: "text.format.type" });
  }
  if (!format.schema || typeof format.schema !== "object" || Array.isArray(format.schema)) {
    throw httpError(400, "text.format.schema must be a JSON Schema object", { parameter: "text.format.schema" });
  }
  return format.schema;
}

function normalizeMetadata(metadata) {
  if (metadata === undefined) return null;
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    throw httpError(400, "metadata must be an object", { parameter: "metadata" });
  }
  const entries = Object.entries(metadata);
  if (entries.length > 16 || entries.some(([key, value]) => !key || typeof value !== "string")) {
    throw httpError(400, "metadata must contain at most 16 non-empty keys with string values", { parameter: "metadata" });
  }
  return structuredClone(metadata);
}

export function streamEvents({ id, createdAt, model }) {
  const base = { id, object: "response", created_at: Math.floor(createdAt / 1000), model: model || "codex-default" };
  return {
    created: { type: "response.created", response: { ...base, status: "in_progress", output: [] } },
    inProgress: { type: "response.in_progress", response: { ...base, status: "in_progress", output: [] } },
  };
}

export function eventTextDelta(event) {
  if (event?.type === "item.completed" && event.item?.type === "agent_message") {
    return typeof event.item.text === "string" ? event.item.text : null;
  }
  return null;
}

function normalizeInput(input) {
  if (typeof input === "string" && input.trim()) {
    return { text: input.trim(), images: [], transcript: [{ type: "message", role: "user", text: input.trim() }] };
  }
  if (!Array.isArray(input) || input.length === 0) {
    throw httpError(400, "input must be a non-empty string or supported message array", { parameter: "input" });
  }

  const images = [];
  const transcript = [];
  const messages = input.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw inputError(index, "must be an object");
    }
    if (item.type === "function_call") {
      const call = normalizeFunctionCall(item, index);
      transcript.push(call);
      return `assistant function_call ${call.name} call_id=${call.call_id} arguments=${call.arguments}`;
    }
    if (item.type === "function_call_output") {
      const output = normalizeFunctionOutput(item, index);
      transcript.push(output);
      return `function_call_output call_id=${output.call_id}: ${output.output}`;
    }
    const role = typeof item.role === "string" ? item.role : "user";
    if (!["developer", "system", "user", "assistant"].includes(role)) throw inputError(index, `unsupported role: ${role}`);
    const normalized = contentToText(item.content, index);
    images.push(...normalized.images);
    transcript.push({ type: "message", role, text: normalized.text });
    return `${role}: ${normalized.text}`;
  });
  const joined = messages.join("\n\n").trim();
  if (!joined) throw httpError(400, "input must contain at least one text item", { parameter: "input" });
  validateFunctionHistory(transcript);
  return { text: joined, images, transcript };
}

function contentToText(content, index) {
  if (typeof content === "string" && content.trim()) return { text: content.trim(), images: [] };
  if (!Array.isArray(content) || content.length === 0) {
    throw inputError(index, "content must be text or an array of input_text items");
  }
  const images = [];
  const text = content.map((part) => {
    if (part?.type === "input_image" && typeof part.image_url === "string") {
      images.push(part.image_url);
      return "[attached image]";
    }
    if (!["input_text", "output_text"].includes(part?.type) || typeof part.text !== "string") {
      throw inputError(index, "only input_text, output_text, and input_image content items are supported");
    }
    return part.text;
  }).join("\n").trim();
  return { text, images };
}

function inputError(index, message) {
  return httpError(400, `input[${index}] ${message}`, { parameter: "input" });
}

function normalizeFunctionCall(item, index) {
  if (typeof item.call_id !== "string" || !item.call_id.trim()) throw inputError(index, "function_call requires call_id");
  if (typeof item.name !== "string" || !item.name.trim()) throw inputError(index, "function_call requires name");
  if (typeof item.arguments !== "string") throw inputError(index, "function_call arguments must be a JSON string");
  try {
    const value = JSON.parse(item.arguments);
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
  } catch {
    throw inputError(index, "function_call arguments must encode a JSON object");
  }
  return { type: "function_call", call_id: item.call_id, name: item.name, arguments: item.arguments };
}

function normalizeFunctionOutput(item, index) {
  if (typeof item.call_id !== "string" || !item.call_id.trim()) throw inputError(index, "function_call_output requires call_id");
  if (typeof item.output !== "string") throw inputError(index, "function_call_output output must be a string");
  return { type: "function_call_output", call_id: item.call_id, output: item.output };
}

function validateFunctionHistory(transcript) {
  const calls = new Set(transcript.filter((item) => item.type === "function_call").map((item) => item.call_id));
  for (const item of transcript) {
    if (item.type === "function_call_output" && !calls.has(item.call_id)) {
      throw httpError(400, `function_call_output references unknown call_id: ${item.call_id}`, { parameter: "input" });
    }
  }
}

export function responseEnvelope({ id, createdAt, model, outputText, events, queueWaitMs, executionMs, metadata = null, toolDecision = null, includeEvents = false }) {
  const output = toolDecision?.type === "function_calls"
    ? toolDecision.calls.map((call, index) => functionCallItem(id, call, index))
    : [{
      id: `msg_${id.replaceAll("-", "")}`,
      type: "message",
      status: "completed",
      role: "assistant",
      content: [{ type: "output_text", text: toolDecision?.text ?? outputText, annotations: [] }],
    }];
  const finalText = toolDecision?.type === "function_calls" ? "" : toolDecision?.text ?? outputText;
  return {
    id,
    object: "response",
    created_at: Math.floor(createdAt / 1000),
    status: "completed",
    model: model || "codex-default",
    output,
    output_text: finalText,
    error: null,
    incomplete_details: null,
    metadata,
    usage: extractUsage(events),
    // Local gateway timing extensions.
    queue_wait_ms: queueWaitMs,
    execution_ms: executionMs,
    ...(includeEvents ? { events } : {}),
  };
}

export function resolveToolDecision(normalized, outputText) {
  if (!normalized.usesToolProtocol) return null;
  return parseToolDecision(outputText, normalized.tools, normalized.toolChoice, normalized.parallelToolCalls, normalized.requestedOutputSchema);
}

function functionCallItem(id, call, index) {
  const suffix = `${id.replaceAll("-", "")}_${index}`;
  return {
    id: `fc_${suffix}`,
    type: "function_call",
    status: "completed",
    call_id: `call_${suffix}`,
    name: call.name,
    arguments: call.arguments,
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
