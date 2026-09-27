import http from "node:http";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { loadConfig, resolveWorkingDirectory } from "./config.mjs";
import { WorkQueue } from "./queue.mjs";
import { httpError, runCodex } from "./codex.mjs";
import { TraceStore } from "./trace-store.mjs";

const config = loadConfig();
const queue = new WorkQueue(config.concurrency);
const traces = new TraceStore({ retentionMs: config.logRetentionMs, maxEntries: config.logMaxEntries });
const dashboardHtml = await readFile(new URL("../public/dashboard.html", import.meta.url), "utf8");
const dashboardFont = await readFile(new URL("../public/fonts/Vazirmatn-Variable.woff2", import.meta.url));

const server = http.createServer(async (request, response) => {
  const requestId = randomUUID();
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.setHeader("x-request-id", requestId);

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
    if (request.method === "GET" && request.url === "/v1/logs") {
      return json(response, 200, { data: traces.list(), summary: traces.summary(queue.stats) });
    }
    if (request.method !== "POST" || request.url !== "/v1/responses") {
      throw httpError(404, "Not found");
    }

    const body = await readJson(request, 1_000_000);
    const prompt = typeof body.input === "string" ? body.input.trim() : "";
    if (!prompt) throw httpError(400, "input must be a non-empty string");
    if (prompt.length > config.maxPromptChars) {
      throw httpError(413, `input exceeds ${config.maxPromptChars} characters`);
    }
    if (body.mode && !["read-only", "workspace-write"].includes(body.mode)) {
      throw httpError(400, "mode must be read-only or workspace-write");
    }

    const workingDirectory = resolveWorkingDirectory(body.working_directory, config);
    const directoryStat = await stat(workingDirectory).catch(() => null);
    if (!directoryStat?.isDirectory()) throw httpError(400, "working_directory does not exist");

    const trace = traces.create({
      id: requestId,
      mode: body.mode || "read-only",
      workspace: path.basename(workingDirectory),
      input_chars: prompt.length,
    });
    const queuedAt = Date.now();
    let startedAt;
    let result;
    try {
      result = await queue.add(() => {
        startedAt = Date.now();
        trace.queue_wait_ms = startedAt - queuedAt;
        traces.markRunning(trace);
        return runCodex({
          prompt,
          workingDirectory,
          mode: body.mode || "read-only",
        }, config);
      });
      traces.markCompleted(trace, result.outputText.length);
    } catch (error) {
      const status = Number.isInteger(error.status) ? error.status : 500;
      traces.markFailed(trace, status, error.name || "Error");
      throw error;
    }
    const finishedAt = Date.now();

    return json(response, 200, {
      id: requestId,
      object: "codex.local_response",
      created_at: Math.floor(Date.now() / 1000),
      output_text: result.outputText,
      queue_wait_ms: startedAt - queuedAt,
      execution_ms: finishedAt - startedAt,
      events: body.include_events === true ? result.events : undefined,
    });
  } catch (error) {
    const status = Number.isInteger(error.status) ? error.status : 500;
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
});

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
