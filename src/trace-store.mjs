export class TraceStore {
  #items = [];

  constructor({ retentionMs, maxEntries, captureContent = false, now = () => Date.now() }) {
    this.retentionMs = retentionMs;
    this.maxEntries = maxEntries;
    this.captureContent = captureContent;
    this.now = now;
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
    return item;
  }

  markRunning(item) {
    item.status = "running";
    item.started_at = new Date(this.now()).toISOString();
  }

  markCompleted(item, result) {
    item.status = "completed";
    item.completed_at = new Date(this.now()).toISOString();
    item.execution_ms = elapsed(item.started_at, item.completed_at);
    if (typeof result === "number") {
      item.output_chars = result;
      return;
    }
    item.output_chars = result.outputText.length;
    if (item.detail) item.detail.response = { output_text: result.outputText, events: result.events, stderr: result.stderr };
  }

  markFailed(item, statusCode, error) {
    item.status = "failed";
    item.completed_at = new Date(this.now()).toISOString();
    item.execution_ms = item.started_at ? elapsed(item.started_at, item.completed_at) : 0;
    item.http_status = statusCode;
    item.error_type = error.name || "Error";
    if (item.detail) item.detail.error = { message: error.message, type: error.name || "Error", details: error.details };
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
    return {
      total_retained: items.length,
      completed: items.filter((item) => item.status === "completed").length,
      failed: items.filter((item) => item.status === "failed").length,
      running: items.filter((item) => item.status === "running").length,
      queue: queueStats,
      retention_ms: this.retentionMs,
      max_entries: this.maxEntries,
      content_capture_enabled: this.captureContent,
    };
  }

  #prune() {
    const cutoff = this.now() - this.retentionMs;
    this.#items = this.#items.filter((item) => Date.parse(item.queued_at) >= cutoff);
  }
}

function publicTrace({ detail, ...item }) {
  return { ...item, ...(detail ? { details_available: true } : {}) };
}

function elapsed(start, end) {
  return Math.max(0, Date.parse(end) - Date.parse(start));
}
