export class WorkQueue {
  #active = 0;
  #waiting = [];
  #accepting = true;

  constructor(concurrency = 1, { maxQueued = 32, queueTimeoutMs = 60_000 } = {}) {
    this.concurrency = concurrency;
    this.maxQueued = maxQueued;
    this.queueTimeoutMs = queueTimeoutMs;
  }

  get stats() {
    return { active: this.#active, queued: this.#waiting.length, concurrency: this.concurrency, max_queued: this.maxQueued, accepting: this.#accepting };
  }

  add(work, { signal } = {}) {
    return new Promise((resolve, reject) => {
      if (!this.#accepting) return reject(queueError(503, "Gateway is shutting down"));
      if (this.#waiting.length >= this.maxQueued) return reject(queueError(429, "Request queue is full"));
      if (signal?.aborted) return reject(abortError(signal.reason));
      const item = { work, resolve, reject, signal, onAbort: null, timer: null };
      item.onAbort = () => {
        const index = this.#waiting.indexOf(item);
        if (index !== -1) {
          this.#waiting.splice(index, 1);
          clearTimeout(item.timer);
          reject(abortError(signal.reason));
        }
      };
      signal?.addEventListener("abort", item.onAbort, { once: true });
      item.timer = setTimeout(() => {
        const index = this.#waiting.indexOf(item);
        if (index !== -1) {
          this.#waiting.splice(index, 1);
          signal?.removeEventListener("abort", item.onAbort);
          reject(queueError(504, `Request exceeded queue timeout of ${this.queueTimeoutMs}ms`));
        }
      }, this.queueTimeoutMs);
      this.#waiting.push(item);
      this.#drain();
    });
  }

  close() {
    this.#accepting = false;
    for (const item of this.#waiting.splice(0)) {
      clearTimeout(item.timer);
      item.signal?.removeEventListener("abort", item.onAbort);
      item.reject(queueError(503, "Gateway is shutting down"));
    }
  }

  #drain() {
    while (this.#active < this.concurrency && this.#waiting.length) {
      const item = this.#waiting.shift();
      clearTimeout(item.timer);
      item.signal?.removeEventListener("abort", item.onAbort);
      this.#active++;
      Promise.resolve()
        .then(item.work)
        .then(item.resolve, item.reject)
        .finally(() => {
          this.#active--;
          this.#drain();
        });
    }
  }
}

function queueError(status, message) {
  const error = new Error(message);
  error.name = "QueueError";
  error.status = status;
  return error;
}

function abortError(reason) {
  const error = new Error(reason instanceof Error && reason.message !== "This operation was aborted"
    ? reason.message
    : "Request cancelled");
  error.name = "AbortError";
  error.status = 499;
  return error;
}
