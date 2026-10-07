import { httpError } from "./codex.mjs";

const TOOL_NAME = /^[A-Za-z0-9_-]{1,64}$/;

export function normalizeTools(tools) {
  if (tools === undefined) return [];
  if (!Array.isArray(tools) || tools.length === 0) {
    throw httpError(400, "tools must be a non-empty array", { parameter: "tools" });
  }
  if (tools.length > 32) throw httpError(400, "tools may contain at most 32 functions", { parameter: "tools" });

  const names = new Set();
  return tools.map((tool, index) => {
    if (!tool || typeof tool !== "object" || Array.isArray(tool) || tool.type !== "function") {
      throw toolError(index, "only function tools are supported");
    }
    const allowed = new Set(["type", "name", "description", "parameters", "strict"]);
    const unsupported = Object.keys(tool).filter((key) => !allowed.has(key));
    if (unsupported.length) throw toolError(index, `unsupported fields: ${unsupported.join(", ")}`);
    if (typeof tool.name !== "string" || !TOOL_NAME.test(tool.name)) {
      throw toolError(index, "name must match ^[A-Za-z0-9_-]{1,64}$");
    }
    if (names.has(tool.name)) throw toolError(index, `duplicate function name: ${tool.name}`);
    names.add(tool.name);
    if (tool.description !== undefined && typeof tool.description !== "string") {
      throw toolError(index, "description must be a string");
    }
    if (!tool.parameters || typeof tool.parameters !== "object" || Array.isArray(tool.parameters)) {
      throw toolError(index, "parameters must be a JSON Schema object");
    }
    if (tool.strict !== undefined && typeof tool.strict !== "boolean") {
      throw toolError(index, "strict must be a boolean");
    }
    if (tool.strict === true) {
      const strictError = validateStrictSchemaDefinition(tool.parameters, "parameters");
      if (strictError) throw toolError(index, `strict schema ${strictError}`);
    }
    return {
      type: "function",
      name: tool.name,
      description: tool.description || "",
      parameters: structuredClone(tool.parameters),
      strict: tool.strict ?? false,
    };
  });
}

export function normalizeToolChoice(choice, tools) {
  if (!tools.length) {
    if (choice !== undefined) throw httpError(400, "tool_choice requires tools", { parameter: "tool_choice" });
    return "none";
  }
  if (choice === undefined) return "auto";
  if (["auto", "none", "required"].includes(choice)) return choice;
  if (!choice || typeof choice !== "object" || Array.isArray(choice)) {
    throw httpError(400, "tool_choice must be auto, none, required, or a function selector", { parameter: "tool_choice" });
  }
  if (choice.type === "function" && typeof choice.name === "string") {
    requireKnownTool(choice.name, tools, "tool_choice");
    return { type: "function", name: choice.name };
  }
  if (choice.type === "allowed_tools" && ["auto", "required"].includes(choice.mode) && Array.isArray(choice.tools) && choice.tools.length) {
    const names = choice.tools.map((tool, index) => {
      if (tool?.type !== "function" || typeof tool.name !== "string") {
        throw httpError(400, `tool_choice.tools[${index}] must select a function`, { parameter: "tool_choice" });
      }
      requireKnownTool(tool.name, tools, "tool_choice");
      return tool.name;
    });
    return { type: "allowed_tools", mode: choice.mode, names: [...new Set(names)] };
  }
  throw httpError(400, "unsupported tool_choice object", { parameter: "tool_choice" });
}

export function toolOutputSchema(tools, toolChoice, parallelToolCalls) {
  const callable = callableToolNames(tools, toolChoice);
  const required = requiresCall(toolChoice);
  const callsSchema = {
    type: "array",
    items: { anyOf: tools.filter(tool => callable.includes(tool.name)).map(tool => ({
      type: "object",
      properties: {
        name: { type: "string", enum: [tool.name] },
        arguments: structuredArgumentsSchema(tool.parameters),
      },
      required: ["name", "arguments"],
      additionalProperties: false,
    })) },
  };
  if (required) callsSchema.minItems = 1;
  if (!parallelToolCalls) callsSchema.maxItems = 1;
  return {
    type: "object",
    properties: {
      kind: { type: "string", enum: required ? ["function_calls"] : ["message", "function_calls"] },
      message: required ? { type: "string", const: "" } : { type: "string" },
      calls: callsSchema,
    },
    required: ["kind", "message", "calls"],
    additionalProperties: false,
  };
}

export function buildToolPrompt({ transcript, tools, toolChoice, parallelToolCalls, instructions, finalOutputSchema }) {
  const callable = new Set(callableToolNames(tools, toolChoice));
  const exposedTools = tools.filter((tool) => callable.has(tool.name));
  const policy = choicePolicy(toolChoice);
  return [
    "You are participating in a caller-owned function-calling protocol.",
    "The listed functions are NOT available inside your runtime. Never use shell commands, filesystem access, web access, MCP, or other internal tools to imitate or pre-execute them.",
    "Choose functions only when the conversation requires caller-owned external data or actions.",
    "Return exactly the object required by the output schema.",
    'For a final answer return: {"kind":"message","message":"...","calls":[]}.',
    'For function calls return an arguments OBJECT, not a JSON string: {"kind":"function_calls","message":"","calls":[{"name":"...","arguments":{"arg":"value"}}]}.',
    "Every arguments value must be an object satisfying the function parameters. Use null for omitted optional fields in the output schema; the gateway removes those placeholders.",
    parallelToolCalls ? "You may return multiple independent function calls." : "Return at most one function call.",
    policy,
    finalOutputSchema ? `When returning kind=message, message must be a JSON-encoded value satisfying this final output schema:\n${JSON.stringify(finalOutputSchema)}` : "",
    instructions ? `Application instructions:\n${instructions}` : "",
    `Available caller-owned functions:\n${JSON.stringify(exposedTools)}`,
    `Conversation transcript:\n${serializeTranscript(transcript)}`,
  ].filter(Boolean).join("\n\n");
}

export function parseToolDecision(outputText, tools, toolChoice, parallelToolCalls, finalOutputSchema = null) {
  let value;
  try {
    value = JSON.parse(outputText);
  } catch {
    throw httpError(502, "Codex returned invalid tool-calling JSON", { output: outputText.slice(0, 1000) });
  }
  if (!value || typeof value !== "object" || Array.isArray(value) || !["message", "function_calls"].includes(value.kind)) {
    throw httpError(502, "Codex returned an invalid tool-calling decision");
  }
  if (value.kind === "message") {
    if (typeof value.message !== "string" || !Array.isArray(value.calls) || value.calls.length !== 0) {
      throw httpError(502, "Codex returned a malformed final message decision");
    }
    if (requiresCall(toolChoice)) throw httpError(502, "Codex did not call a required function");
    let message = value.message;
    if (finalOutputSchema) {
      let structured;
      try { structured = JSON.parse(message); } catch {
        throw httpError(502, "Codex final message is not valid JSON for text.format");
      }
      const schemaError = validateSchemaValue(structured, finalOutputSchema, "output");
      if (schemaError) throw httpError(502, `Codex final message violates text.format: ${schemaError}`);
      message = JSON.stringify(structured);
    }
    return { type: "message", text: message };
  }
  if (!Array.isArray(value.calls) || value.calls.length === 0 || value.message !== "") {
    throw httpError(502, "Codex returned malformed function calls");
  }
  if (!parallelToolCalls && value.calls.length > 1) {
    throw httpError(502, "Codex returned parallel calls while parallel_tool_calls is false");
  }
  const callable = new Set(callableToolNames(tools, toolChoice));
  const calls = value.calls.map((call, index) => {
    if (!call || typeof call !== "object" || !callable.has(call.name)) {
      throw httpError(502, `Codex returned an invalid function call at index ${index}`);
    }
    let args;
    try { args = typeof call.arguments === "string" ? JSON.parse(call.arguments) : call.arguments; } catch {
      throw httpError(502, `Codex returned invalid JSON arguments for ${call.name}`);
    }
    if (!args || typeof args !== "object" || Array.isArray(args)) {
      throw httpError(502, `Codex arguments for ${call.name} must encode an object`);
    }
    const definition = tools.find((tool) => tool.name === call.name);
    args = omitOptionalNulls(args, definition.parameters);
    {
      const schemaError = validateSchemaValue(args, definition.parameters, "arguments");
      if (schemaError) throw httpError(502, `Codex returned arguments that violate the strict schema for ${call.name}: ${schemaError}`);
    }
    return { name: call.name, arguments: JSON.stringify(args) };
  });
  return { type: "function_calls", calls };
}

export function serializeTranscript(transcript) {
  return transcript.map((item) => {
    if (item.type === "message") return `${item.role}: ${item.text}`;
    if (item.type === "function_call") return `assistant function_call ${item.name} call_id=${item.call_id} arguments=${item.arguments}`;
    return `function_call_output call_id=${item.call_id}: ${item.output}`;
  }).join("\n\n");
}

function callableToolNames(tools, choice) {
  if (choice === "none") return [];
  if (choice?.type === "function") return [choice.name];
  if (choice?.type === "allowed_tools") return choice.names;
  return tools.map((tool) => tool.name);
}

function choicePolicy(choice) {
  if (choice === "required") return "You MUST return one or more function calls; do not return a final message.";
  if (choice === "none") return "Do not call any function; return a final message.";
  if (choice?.type === "function") return `You MUST call the function ${choice.name}; do not return a final message.`;
  if (choice?.type === "allowed_tools" && choice.mode === "required") return "You MUST call one or more of the allowed functions; do not return a final message.";
  return "Choose automatically between a final message and one or more function calls.";
}

function requiresCall(choice) {
  return choice === "required" || choice?.type === "function" || (choice?.type === "allowed_tools" && choice.mode === "required");
}

function requireKnownTool(name, tools, parameter) {
  if (!tools.some((tool) => tool.name === name)) {
    throw httpError(400, `Unknown function in ${parameter}: ${name}`, { parameter });
  }
}

function toolError(index, message) {
  return httpError(400, `tools[${index}] ${message}`, { parameter: "tools" });
}

function validateStrictSchemaDefinition(schema, path) {
  if (schema.type !== "object") return `${path}.type must be object`;
  if (schema.additionalProperties !== false) return `${path}.additionalProperties must be false`;
  const properties = schema.properties || {};
  const required = new Set(schema.required || []);
  for (const key of Object.keys(properties)) if (!required.has(key)) return `${path}.required must include ${key}`;
  for (const [key, child] of Object.entries(properties)) {
    const types = Array.isArray(child?.type) ? child.type : [child?.type];
    if (types.includes("object")) {
      const error = validateStrictSchemaDefinition(child, `${path}.properties.${key}`);
      if (error) return error;
    }
    if (types.includes("array") && child.items?.type === "object") {
      const error = validateStrictSchemaDefinition(child.items, `${path}.properties.${key}.items`);
      if (error) return error;
    }
    if (typeof child?.pattern === "string") {
      try { new RegExp(child.pattern); } catch { return `${path}.properties.${key}.pattern is invalid`; }
    }
  }
  return null;
}

function validateSchemaValue(value, schema, path) {
  if (!schema || typeof schema !== "object") return null;
  if (Array.isArray(schema.anyOf) && !schema.anyOf.some(child => !validateSchemaValue(value, child, path))) return path + " does not match anyOf";
  if (Array.isArray(schema.oneOf) && schema.oneOf.filter(child => !validateSchemaValue(value, child, path)).length !== 1) return path + " does not match oneOf";
  if (Array.isArray(schema.allOf)) for (const child of schema.allOf) { const error = validateSchemaValue(value, child, path); if (error) return error; }
  if (Array.isArray(schema.enum) && !schema.enum.some((candidate) => JSON.stringify(candidate) === JSON.stringify(value))) return `${path} is not in enum`;
  if (Object.hasOwn(schema, "const") && JSON.stringify(schema.const) !== JSON.stringify(value)) return `${path} does not equal const`;
  const types = Array.isArray(schema.type) ? schema.type : schema.type ? [schema.type] : [];
  if (types.length && !types.some((type) => matchesType(value, type))) return `${path} must be ${types.join(" or ")}`;
  if (value && typeof value === "object" && !Array.isArray(value)) {
    for (const key of schema.required || []) if (!Object.hasOwn(value, key)) return `${path}.${key} is required`;
    const properties = schema.properties || {};
    if (schema.additionalProperties === false) {
      const extra = Object.keys(value).find((key) => !Object.hasOwn(properties, key));
      if (extra) return `${path}.${extra} is not allowed`;
    }
    for (const [key, child] of Object.entries(properties)) {
      if (!Object.hasOwn(value, key)) continue;
      const error = validateSchemaValue(value[key], child, `${path}.${key}`);
      if (error) return error;
    }
  }
  if (Array.isArray(value)) {
    if (Number.isInteger(schema.minItems) && value.length < schema.minItems) return `${path} has too few items`;
    if (Number.isInteger(schema.maxItems) && value.length > schema.maxItems) return `${path} has too many items`;
    if (schema.items) {
      for (const [index, item] of value.entries()) {
        const error = validateSchemaValue(item, schema.items, `${path}[${index}]`);
        if (error) return error;
      }
    }
  }
  if (typeof value === "string") {
    if (Number.isInteger(schema.minLength) && value.length < schema.minLength) return `${path} is too short`;
    if (Number.isInteger(schema.maxLength) && value.length > schema.maxLength) return `${path} is too long`;
    if (typeof schema.pattern === "string" && !new RegExp(schema.pattern).test(value)) return `${path} does not match pattern`;
  }
  if (typeof value === "number") {
    if (typeof schema.minimum === "number" && value < schema.minimum) return `${path} is below minimum`;
    if (typeof schema.maximum === "number" && value > schema.maximum) return `${path} is above maximum`;
  }
  return null;
}

function matchesType(value, type) {
  if (type === "null") return value === null;
  if (type === "object") return Boolean(value) && typeof value === "object" && !Array.isArray(value);
  if (type === "array") return Array.isArray(value);
  if (type === "integer") return Number.isInteger(value);
  if (type === "number") return typeof value === "number" && Number.isFinite(value);
  if (type === "string") return typeof value === "string";
  if (type === "boolean") return typeof value === "boolean";
  return true;
}

// Codex structured output requires all declared fields. Optional fields use null
// placeholders, removed before returning the caller's original arguments.
function structuredArgumentsSchema(schema) {
  if (!schema || typeof schema !== "object") return schema;
  const result = structuredClone(schema);
  if (result.properties) {
    const required = new Set(result.required || []);
    for (const [key, child] of Object.entries(result.properties)) {
      const normalized = structuredArgumentsSchema(child);
      result.properties[key] = required.has(key) ? normalized : { anyOf: [normalized, { type: "null" }] };
    }
    result.required = Object.keys(result.properties);
    result.additionalProperties = false;
  }
  if (result.items) result.items = structuredArgumentsSchema(result.items);
  for (const key of ["anyOf", "oneOf", "allOf"]) if (Array.isArray(result[key])) result[key] = result[key].map(structuredArgumentsSchema);
  return result;
}

function omitOptionalNulls(value, schema) {
  if (Array.isArray(value)) return value.map(item => omitOptionalNulls(item, schema?.items));
  if (!value || typeof value !== "object") return value;
  const result = { ...value };
  for (const [key, child] of Object.entries(schema?.properties || {})) {
    if (!Object.hasOwn(result, key)) continue;
    if (result[key] === null && !(schema.required || []).includes(key) && validateSchemaValue(null, child)) delete result[key];
    else result[key] = omitOptionalNulls(result[key], child);
  }
  return result;
}
