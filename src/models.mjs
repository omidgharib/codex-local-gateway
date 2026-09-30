import { spawn } from "node:child_process";
import { httpError } from "./codex.mjs";

let cachedCatalog = null;
let refreshPromise = null;

export async function listModels(config, { includeHidden = false } = {}) {
  const now = Date.now();
  if (!cachedCatalog || now - cachedCatalog.fetchedAt >= config.modelsCacheMs) {
    refreshPromise ||= fetchModelCatalog(config).finally(() => { refreshPromise = null; });
    cachedCatalog = { models: await refreshPromise, fetchedAt: Date.now() };
  }

  const models = includeHidden ? cachedCatalog.models : cachedCatalog.models.filter((model) => !model.hidden);
  return {
    object: "list",
    data: models.map(toHttpModel),
  };
}

export function clearModelsCache() {
  cachedCatalog = null;
  refreshPromise = null;
}

async function fetchModelCatalog(config) {
  const client = startAppServer(config);
  try {
    await client.request("initialize", {
      clientInfo: {
        name: "codex_local_gateway",
        title: "Codex Local Gateway",
        version: "0.3.0",
      },
    });
    client.notify("initialized", {});

    const models = [];
    let cursor = null;
    do {
      const result = await client.request("model/list", { cursor, includeHidden: true, limit: 100 });
      if (!Array.isArray(result?.data)) throw httpError(502, "Codex returned an invalid model catalog");
      models.push(...result.data);
      cursor = result.nextCursor || null;
    } while (cursor);
    return models;
  } finally {
    client.close();
  }
}

function startAppServer(config) {
  const child = spawn(config.codexBin, [...config.codexBinArgs, "app-server", "--listen", "stdio://"], {
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...process.env,
      HOME: process.env.HOME || process.env.USERPROFILE,
      CODEX_HOME: config.codexHome,
    },
  });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");

  let nextId = 1;
  let pendingText = "";
  let stderr = "";
  let closed = false;
  const pending = new Map();

  child.stdout.on("data", (chunk) => {
    pendingText += chunk;
    const lines = pendingText.split(/\r?\n/);
    pendingText = lines.pop() || "";
    for (const line of lines) {
      if (!line.trim()) continue;
      let message;
      try { message = JSON.parse(line); } catch { continue; }
      if (message.id === undefined) continue;
      const request = pending.get(message.id);
      if (!request) continue;
      pending.delete(message.id);
      clearTimeout(request.timer);
      if (message.error) request.reject(httpError(502, "Codex model discovery failed", { rpc_error: message.error }));
      else request.resolve(message.result);
    }
  });
  child.stderr.on("data", (chunk) => { stderr = boundedAppend(stderr, chunk, 4000); });
  child.on("error", (error) => failAll(httpError(503, `Unable to start Codex app-server: ${error.message}`)));
  child.on("close", (code) => {
    closed = true;
    if (pending.size) failAll(httpError(502, "Codex app-server exited during model discovery", { exit_code: code, stderr }));
  });

  return {
    request(method, params) {
      if (closed) return Promise.reject(httpError(502, "Codex app-server is not running", { stderr }));
      const id = nextId++;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(httpError(504, `Codex model discovery timed out after ${config.modelsTimeoutMs}ms`));
          child.kill();
        }, config.modelsTimeoutMs);
        pending.set(id, { resolve, reject, timer });
        child.stdin.write(`${JSON.stringify({ method, id, params })}\n`);
      });
    },
    notify(method, params) {
      if (!closed) child.stdin.write(`${JSON.stringify({ method, params })}\n`);
    },
    close() {
      if (!closed) child.kill();
    },
  };

  function failAll(error) {
    for (const request of pending.values()) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    pending.clear();
  }
}

function toHttpModel(model) {
  return {
    id: model.model || model.id,
    object: "model",
    created: 0,
    owned_by: "codex",
    display_name: model.displayName,
    description: model.description,
    hidden: model.hidden === true,
    is_default: model.isDefault === true,
    default_reasoning_effort: model.defaultReasoningEffort,
    supported_reasoning_efforts: (model.supportedReasoningEfforts || []).map((option) => ({
      effort: option.reasoningEffort,
      description: option.description,
    })),
    input_modalities: model.inputModalities || ["text", "image"],
    service_tiers: model.serviceTiers || [],
  };
}

function boundedAppend(current, chunk, max) {
  const combined = current + chunk;
  return combined.length <= max ? combined : combined.slice(-max);
}
