import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

export class TraceStore {
  #items = [];

  constructor({ retentionMs, maxEntries, captureContent = false, persistPath = null, now = () => Date.now() }) {
    this.retentionMs = retentionMs;
    this.maxEntries = maxEntries;
    this.captureContent = captureContent;
    this.persistPath = persistPath;
    this.now = now;
    this.#items = this.#load();
    this.#prune();
  }

  create(trace, request) {
    this.#prune();
    const item = {
      ...trace,
      status: "queued",
      queued_at: new Date(this.now()).toISOString(),
      ...(this.captureContent ? { detail: { request } } : {}),
    };
    this.#items.unshift(item);
    if (this.#items.length > this.maxEntries) this.#items.length = this.maxEntries;
    this.#persist();
    return item;
  }

  markRunning(item) {
    item.status = "running";
    item.started_at = new Date(this.now()).toISOString();
    this.#persist();
  }

  markCompleted(item, result) {
    item.status = "completed";
    item.completed_at = new Date(this.now()).toISOString();
    item.execution_ms = elapsed(item.started_at, item.completed_at);
    if (typeof result === "number") {
      item.output_chars = result;
      this.#persist();
      return;
    }
    item.output_chars = result.outputText.length;
    if (item.detail) item.detail.response = { output_text: result.outputText, events: result.events, stderr: result.stderr };
    this.#persist();
  }

  markFailed(item, statusCode, error) {
    item.status = "failed";
    item.completed_at = new Date(this.now()).toISOString();
    item.execution_ms = item.started_at ? elapsed(item.started_at, item.completed_at) : 0;
    item.http_status = statusCode;
    item.error_type = error.name || "Error";
    if (item.detail) item.detail.error = { message: error.message, type: error.name || "Error", details: error.details };
    this.#persist();
  }

  list() {
    this.#prune();
    return this.#items.map(publicTrace);
  }

  get(id) {
    this.#prune();
    const item = this.#items.find((candidate) => candidate.id === id);
    if (!item) return null;
    return { ...publicTrace(item), ...(item.detail ? { detail: structuredClone(item.detail) } : {}) };
  }

  summary(queueStats) {
    const items = this.list();
    const finished = items.filter((item) => item.status === "completed" || item.status === "failed");
    const durations = finished.map((item) => item.execution_ms).filter(Number.isFinite).sort((a, b) => a - b);
    const completed = items.filter((item) => item.status === "completed").length;
    return {
      total_retained: items.length,
      completed,
      failed: items.filter((item) => item.status === "failed").length,
      running: items.filter((item) => item.status === "running").length,
      queue: queueStats,
      retention_ms: this.retentionMs,
      max_entries: this.maxEntries,
      content_capture_enabled: this.captureContent,
      persistence_enabled: Boolean(this.persistPath),
      success_rate: finished.length ? completed / finished.length : null,
      latency_ms: {
        average: durations.length ? Math.round(durations.reduce((sum, value) => sum + value, 0) / durations.length) : null,
        p50: percentile(durations, 0.5),
        p95: percentile(durations, 0.95),
      },
    };
  }

  #prune() {
    const cutoff = this.now() - this.retentionMs;
    const before = this.#items.length;
    this.#items = this.#items.filter((item) => Date.parse(item.queued_at) >= cutoff).slice(0, this.maxEntries);
    if (this.#items.length !== before) this.#persist();
  }

  #load() {
    if (!this.persistPath) return [];
    try {
      const value = JSON.parse(readFileSync(this.persistPath, "utf8"));
      return Array.isArray(value) ? value.map(({ detail, ...item }) => item) : [];
    } catch {
      return [];
    }
  }

  #persist() {
    if (!this.persistPath) return;
    try {
      mkdirSync(path.dirname(this.persistPath), { recursive: true });
      const tempPath = `${this.persistPath}.tmp`;
      writeFileSync(tempPath, JSON.stringify(this.#items.map(publicTrace)), "utf8");
      renameSync(tempPath, this.persistPath);
    } catch {
      // Observability must never make request execution fail.
    }
  }
}

function publicTrace({ detail, ...item }) {
  return { ...item, ...(detail ? { details_available: true } : {}) };
}

function elapsed(start, end) {
  return Math.max(0, Date.parse(end) - Date.parse(start));
}

function percentile(sorted, fraction) {
  if (!sorted.length) return null;
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)];
}
