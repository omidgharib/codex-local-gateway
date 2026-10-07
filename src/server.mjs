import http from "node:http";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { loadConfig, resolveWorkingDirectory } from "./config.mjs";
import { WorkQueue } from "./queue.mjs";
import { httpError, runCodex } from "./codex.mjs";
import { TraceStore } from "./trace-store.mjs";
import { loadLocalEnv } from "./local-env.mjs";
import { listModels } from "./models.mjs";
import { eventTextDelta, normalizeResponseRequest, resolveToolDecision, responseEnvelope, streamEvents } from "./responses-compat.mjs";
import { chatChunk, chatEnvelope, chatUsageChunk, normalizeChatRequest } from "./chat-compat.mjs";

loadLocalEnv();
const config = loadConfig();
const queue = new WorkQueue(config.concurrency, { maxQueued: config.maxQueued, queueTimeoutMs: config.queueTimeoutMs });
const traces = new TraceStore({
  retentionMs: config.logRetentionMs,
  maxEntries: config.logMaxEntries,
  captureContent: config.traceContent,
  persistPath: config.traceFile,
});
const activeRequests = new Map();
const dashboardHtml = await readFile(new URL("../public/dashboard.html", import.meta.url), "utf8");
const dashboardFont = await readFile(new URL("../public/fonts/Vazirmatn-Variable.woff2", import.meta.url));

const server = http.createServer(async (request, response) => {
  const requestId = randomUUID();
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.setHeader("x-request-id", requestId);

  let trace;
  try {
    if (request.method === "GET" && request.url === "/dashboard") {
      response.setHeader("content-type", "text/html; charset=utf-8");
      response.setHeader("cache-control", "no-store");
      response.statusCode = 200;
      return response.end(dashboardHtml);
    }
    if (request.method === "GET" && request.url === "/assets/Vazirmatn-Variable.woff2") {
      response.setHeader("content-type", "font/woff2");
      response.setHeader("cache-control", "public, max-age=31536000, immutable");
      response.statusCode = 200;
      return response.end(dashboardFont);
    }
    if (request.method === "GET" && request.url === "/health") {
      return json(response, 200, { status: "ok", queue: queue.stats });
    }
    authenticate(request, config.token);
    if (request.method === "GET" && request.url?.startsWith("/v1/models")) {
      const url = new URL(request.url, `http://${config.host}:${config.port}`);
      if (url.pathname !== "/v1/models") throw httpError(404, "Not found");
      const allowedParams = new Set(["include_hidden"]);
      for (const name of url.searchParams.keys()) {
        if (!allowedParams.has(name)) throw httpError(400, `Unsupported query parameter: ${name}`, { parameter: name });
      }
      const rawIncludeHidden = url.searchParams.get("include_hidden");
      if (rawIncludeHidden !== null && !["true", "false"].includes(rawIncludeHidden)) {
        throw httpError(400, "include_hidden must be true or false", { parameter: "include_hidden" });
      }
      return json(response, 200, await listModels(config, { includeHidden: rawIncludeHidden === "true" }));
    }
    const cancelMatch = request.method === "POST" && request.url?.match(/^\/v1\/responses\/([0-9a-f-]+)\/cancel$/i);
    if (cancelMatch) {
      const controller = activeRequests.get(cancelMatch[1]);
      if (!controller) throw httpError(404, "Active request not found");
      controller.abort();
      return json(response, 200, { id: cancelMatch[1], status: "cancelling" });
    }
    if (request.method === "GET" && request.url === "/v1/logs") {
      return json(response, 200, { data: traces.list(), summary: traces.summary(queue.stats) });
    }
    const traceMatch = request.method === "GET" && request.url?.match(/^\/v1\/logs\/([0-9a-f-]+)$/i);
    if (traceMatch) {
      const trace = traces.get(traceMatch[1]);
      if (!trace) throw httpError(404, "Trace not found or expired");
      return json(response, 200, { data: trace });
    }
    const apiKind = request.url === "/v1/responses" ? "responses" : request.url === "/v1/chat/completions" ? "chat" : null;
    if (request.method !== "POST" || !apiKind) {
      throw httpError(404, "Not found");
    }

    const body = await readJson(request, 1_000_000);
    const endpoint = apiKind === "chat" ? "/v1/chat/completions" : "/v1/responses";
    trace = traces.create({ id: requestId, mode: body?.mode || "read-only", workspace: "unresolved", input_chars: 0,
      endpoint, model: typeof body?.model === "string" ? body.model : "codex-default" },
      { method: request.method, endpoint, parameters: body });
    const normalized = apiKind === "chat" ? normalizeChatRequest(body, config.model) : normalizeResponseRequest(body, config.model);
    const prompt = normalized.prompt;
    trace.input_chars = prompt.length;
    if (prompt.length > config.maxPromptChars) {
      throw httpError(413, `input exceeds ${config.maxPromptChars} characters`, { code: "gateway_input_too_large", input_chars: prompt.length, max_prompt_chars: config.maxPromptChars });
    }
    if (body.mode && !["read-only", "workspace-write"].includes(body.mode)) {
      throw httpError(400, "mode must be read-only or workspace-write");
    }

    let workingDirectory;
    try {
      workingDirectory = resolveWorkingDirectory(body.working_directory, config);
    } catch (error) {
      throw httpError(400, error.message);
    }
    const directoryStat = await stat(workingDirectory).catch(() => null);
    if (!directoryStat?.isDirectory()) throw httpError(400, "working_directory does not exist");
    const inputImages = await validateInputImages(normalized.inputImages, config);

    trace.workspace = path.basename(workingDirectory);
    trace.model = normalized.model || "codex-default";
    if (trace.detail) trace.detail.request.resolved = {
      model: trace.model, working_directory: workingDirectory, mode: body.mode || "read-only",
    };
    const controller = new AbortController();
    activeRequests.set(requestId, controller);
    const abortOnDisconnect = () => {
      if (!response.writableEnded) controller.abort();
    };
    request.on("aborted", abortOnDisconnect);
    response.on("close", abortOnDisconnect);
    const streaming = normalized.stream === true;
    const streamCreatedAt = Date.now();
    if (streaming) {
      if (apiKind === "chat") {
        startSse(response);
        sendEvent(response, chatChunk({ id: requestId, createdAt: streamCreatedAt, model: normalized.model, delta: { role: "assistant", content: "" } }));
      } else startEventStream(response, normalized.model);
    }
    const queuedAt = Date.now();
    let startedAt;
    let result;
    let toolDecision;
    try {
      result = await queue.add(() => {
        startedAt = Date.now();
        trace.queue_wait_ms = startedAt - queuedAt;
        traces.markRunning(trace);
        return runCodex({
          prompt,
          workingDirectory,
          mode: body.mode || "read-only",
          model: normalized.model,
          reasoningEffort: normalized.reasoningEffort,
          outputSchema: normalized.outputSchema,
          inputImages,
          signal: controller.signal,
          onEvent: streaming && !normalized.usesToolProtocol ? (event) => {
            const delta = eventTextDelta(event);
            if (delta) sendEvent(response, apiKind === "chat"
              ? chatChunk({ id: requestId, createdAt: streamCreatedAt, model: normalized.model, delta: { content: delta } })
              : { type: "response.output_text.delta", delta });
          } : undefined,
        }, config);
      }, { signal: controller.signal });
      toolDecision = resolveToolDecision(normalized, result.outputText);
      traces.markCompleted(trace, result);
    } catch (error) {
      const status = Number.isInteger(error.status) ? error.status : 500;
      traces.markFailed(trace, status, error, result);
      if (streaming) {
        sendEvent(response, {
          type: "error",
          error: { message: error.message, type: error.name || "Error", request_id: requestId },
        });
        response.end("data: [DONE]\n\n");
        return;
      }
      throw error;
    } finally {
      activeRequests.delete(requestId);
      request.off("aborted", abortOnDisconnect);
      response.off("close", abortOnDisconnect);
    }
    const finishedAt = Date.now();
    const responsesEnvelope = responseEnvelope({
      id: requestId,
      createdAt: finishedAt,
      model: normalized.model,
      outputText: result.outputText,
      events: result.events,
      queueWaitMs: startedAt - queuedAt,
      executionMs: finishedAt - startedAt,
      metadata: normalized.metadata,
      toolDecision,
      includeEvents: body.include_events === true,
    });
    const envelope = apiKind === "chat" ? chatEnvelope({
      id: requestId,
      createdAt: finishedAt,
      model: normalized.model,
      outputText: responsesEnvelope.output_text,
      output: responsesEnvelope.output,
      usage: responsesEnvelope.usage,
      metadata: normalized.metadata,
      events: result.events,
      includeEvents: body.include_events === true,
    }) : responsesEnvelope;
    traces.setResponse(trace, envelope);
    if (streaming) {
      if (normalized.usesToolProtocol) sendToolProtocolStream(response, apiKind, responsesEnvelope, streamCreatedAt, normalized.model);
      sendEvent(response, apiKind === "chat"
        ? chatChunk({ id: requestId, createdAt: streamCreatedAt, model: normalized.model, delta: {}, finishReason: responsesEnvelope.output.some((item) => item.type === "function_call") ? "tool_calls" : "stop" })
        : { type: "response.completed", response: envelope });
      if (apiKind === "chat" && normalized.streamOptions.include_usage) {
        sendEvent(response, chatUsageChunk({
          id: requestId,
          createdAt: streamCreatedAt,
          model: normalized.model,
          usage: responsesEnvelope.usage,
        }));
      }
      return response.end("data: [DONE]\n\n");
    }
    return json(response, 200, envelope);
  } catch (error) {
    const status = Number.isInteger(error.status) ? error.status : 500;
    if (trace && trace.status !== "failed") traces.markFailed(trace, status, error);
    return json(response, status, {
      error: {
        message: status === 500 ? "Internal server error" : error.message,
        type: error.name || "Error",
        details: error.details,
        request_id: requestId,
      },
    });
  }
});

server.listen(config.port, config.host, () => {
  console.log(`Codex local gateway listening on http://${config.host}:${config.port}`);
  console.log(`Allowed roots: ${config.allowedRoots.join(", ")}`);
  console.log(`Writes: ${config.allowWrites ? "enabled" : "disabled"}; concurrency: ${config.concurrency}`);
  console.log(`Trace retention: ${config.logRetentionMs}ms; max entries: ${config.logMaxEntries}`);
  console.log(`Trace content: ${config.traceContent ? "enabled" : "disabled"}`);
  console.log(`Trace persistence: ${config.traceFile || "disabled"}`);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => gracefulShutdown(signal));
}

function sendToolProtocolStream(response, apiKind, envelope, createdAt, model) {
  const calls = envelope.output.filter((item) => item.type === "function_call");
  if (apiKind === "chat") {
    if (calls.length) {
      sendEvent(response, chatChunk({
        id: envelope.id,
        createdAt,
        model,
        delta: {
          tool_calls: calls.map((call, index) => ({
            index,
            id: call.call_id,
            type: "function",
            function: { name: call.name, arguments: call.arguments },
          })),
        },
      }));
    } else if (envelope.output_text) {
      sendEvent(response, chatChunk({ id: envelope.id, createdAt, model, delta: { content: envelope.output_text } }));
    }
    return;
  }
  if (!calls.length) {
    if (envelope.output_text) sendEvent(response, { type: "response.output_text.delta", delta: envelope.output_text });
    return;
  }
  let sequenceNumber = 2;
  for (const [outputIndex, call] of calls.entries()) {
    sendEvent(response, { type: "response.output_item.added", sequence_number: sequenceNumber++, output_index: outputIndex, item: { ...call, status: "in_progress", arguments: "" } });
    sendEvent(response, { type: "response.function_call_arguments.delta", sequence_number: sequenceNumber++, item_id: call.id, output_index: outputIndex, delta: call.arguments });
    sendEvent(response, { type: "response.function_call_arguments.done", sequence_number: sequenceNumber++, item_id: call.id, output_index: outputIndex, arguments: call.arguments });
    sendEvent(response, { type: "response.output_item.done", sequence_number: sequenceNumber++, output_index: outputIndex, item: call });
  }
}

function gracefulShutdown(signal) {
  console.log(`Received ${signal}; stopping new work and cancelling active requests.`);
  queue.close();
  for (const controller of activeRequests.values()) controller.abort();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), config.shutdownTimeoutMs).unref();
}

function authenticate(request, expectedToken) {
  const value = request.headers.authorization || "";
  const supplied = value.startsWith("Bearer ") ? value.slice(7) : "";
  const suppliedBuffer = Buffer.from(supplied);
  const expectedBuffer = Buffer.from(expectedToken);
  if (suppliedBuffer.length !== expectedBuffer.length || !timingSafeEqual(suppliedBuffer, expectedBuffer)) {
    throw httpError(401, "Invalid or missing bearer token");
  }
}

async function readJson(request, maxBytes) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxBytes) throw httpError(413, "Request body is too large");
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw httpError(400, "Request body must be valid JSON");
  }
}

function json(response, status, body) {
  response.statusCode = status;
  response.end(JSON.stringify(body));
}

function startEventStream(response, model) {
  startSse(response);
  const events = streamEvents({
    id: response.getHeader("x-request-id"),
    createdAt: Date.now(),
    model,
  });
  sendEvent(response, events.created);
  sendEvent(response, events.inProgress);
}

function startSse(response) {
  response.statusCode = 200;
  response.setHeader("content-type", "text/event-stream; charset=utf-8");
  response.setHeader("cache-control", "no-cache, no-transform");
  response.setHeader("connection", "keep-alive");
  response.flushHeaders();
}

function sendEvent(response, event) {
  if (!response.destroyed && !response.writableEnded) response.write(`data: ${JSON.stringify(event)}\n\n`);
}

async function validateInputImages(images = [], gatewayConfig) {
  const validated = [];
  for (const image of images) {
    if (image.startsWith("data:")) {
      validated.push(image);
      continue;
    }
    if (!path.isAbsolute(image)) throw httpError(400, "input_image paths must be absolute or base64 data URLs");
    const resolved = resolveWorkingDirectory(image, gatewayConfig);
    const imageStat = await stat(resolved).catch(() => null);
    if (!imageStat?.isFile()) throw httpError(400, "input_image file does not exist");
    validated.push(resolved);
  }
  return validated;
}
