export class TraceStore {
  #items = [];

  constructor({ retentionMs, maxEntries, now = () => Date.now() }) {
    this.retentionMs = retentionMs;
    this.maxEntries = maxEntries;
    this.now = now;
  }

  create(trace) {
    this.#prune();
    const item = {
      ...trace,
      status: "queued",
      queued_at: new Date(this.now()).toISOString(),
    };
    this.#items.unshift(item);
    if (this.#items.length > this.maxEntries) this.#items.length = this.maxEntries;
    return item;
  }

  markRunning(item) {
    item.status = "running";
    item.started_at = new Date(this.now()).toISOString();
  }

  markCompleted(item, outputChars) {
    item.status = "completed";
    item.completed_at = new Date(this.now()).toISOString();
    item.execution_ms = elapsed(item.started_at, item.completed_at);
    item.output_chars = outputChars;
  }

  markFailed(item, statusCode, errorType) {
    item.status = "failed";
    item.completed_at = new Date(this.now()).toISOString();
    item.execution_ms = item.started_at ? elapsed(item.started_at, item.completed_at) : 0;
    item.http_status = statusCode;
    item.error_type = errorType;
  }

  list() {
    this.#prune();
    return this.#items.map((item) => ({ ...item }));
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
    };
  }

  #prune() {
    const cutoff = this.now() - this.retentionMs;
    this.#items = this.#items.filter((item) => Date.parse(item.queued_at) >= cutoff);
  }
}

function elapsed(start, end) {
  return Math.max(0, Date.parse(end) - Date.parse(start));
}
