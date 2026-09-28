import path from "node:path";
import os from "node:os";

export function loadConfig(env = process.env, cwd = process.cwd()) {
  const token = env.LOCAL_CODEX_GATEWAY_TOKEN?.trim();
  if (!token || token.length < 32) {
    throw new Error("LOCAL_CODEX_GATEWAY_TOKEN must contain at least 32 characters");
  }

  const allowedRoots = (env.CODEX_ALLOWED_ROOTS || cwd)
    .split(path.delimiter)
    .map((value) => value.trim())
    .filter(Boolean)
    .map((value) => path.resolve(value));

  return {
    host: env.HOST || "127.0.0.1",
    port: integer(env.PORT, 4317, 1, 65535),
    token,
    codexBin: env.CODEX_BIN || "codex",
    codexBinArgs: stringArray(env.CODEX_BIN_ARGS),
    codexHome: path.resolve(env.CODEX_HOME || path.join(os.homedir(), ".codex")),
    allowedRoots,
    timeoutMs: integer(env.CODEX_TIMEOUT_MS, 300_000, 1_000, 3_600_000),
    maxPromptChars: integer(env.CODEX_MAX_PROMPT_CHARS, 50_000, 1, 500_000),
    concurrency: integer(env.CODEX_CONCURRENCY, 1, 1, 4),
    maxQueued: integer(env.CODEX_MAX_QUEUED, 32, 1, 1_000),
    queueTimeoutMs: integer(env.CODEX_QUEUE_TIMEOUT_MS, 60_000, 1_000, 3_600_000),
    shutdownTimeoutMs: integer(env.CODEX_SHUTDOWN_TIMEOUT_MS, 15_000, 1_000, 120_000),
    logRetentionMs: integer(env.CODEX_LOG_RETENTION_MS, 86_400_000, 60_000, 604_800_000),
    logMaxEntries: integer(env.CODEX_LOG_MAX_ENTRIES, 1_000, 10, 10_000),
    traceContent: env.CODEX_TRACE_CONTENT === "true",
    traceFile: env.CODEX_TRACE_FILE?.trim() ? path.resolve(env.CODEX_TRACE_FILE.trim()) : null,
    allowWrites: env.CODEX_ALLOW_WRITES === "true",
    model: env.CODEX_MODEL?.trim() || null,
  };
}

function stringArray(value) {
  if (!value) return [];
  let parsed;
  try { parsed = JSON.parse(value); } catch { throw new Error("CODEX_BIN_ARGS must be a JSON array of strings"); }
  if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== "string")) {
    throw new Error("CODEX_BIN_ARGS must be a JSON array of strings");
  }
  return parsed;
}

function integer(value, fallback, min, max) {
  const parsed = value === undefined || value === "" ? fallback : Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`Expected an integer between ${min} and ${max}; received ${value}`);
  }
  return parsed;
}

export function resolveWorkingDirectory(requested, config, cwd = process.cwd()) {
  const candidate = path.resolve(requested || cwd);
  const allowed = config.allowedRoots.some((root) => {
    const relative = path.relative(root, candidate);
    return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
  });
  if (!allowed) throw new Error("working_directory is outside CODEX_ALLOWED_ROOTS");
  return candidate;
}
