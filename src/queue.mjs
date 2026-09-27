export class WorkQueue {
  #active = 0;
  #waiting = [];

  constructor(concurrency = 1) {
    this.concurrency = concurrency;
  }

  get stats() {
    return { active: this.#active, queued: this.#waiting.length, concurrency: this.concurrency };
  }

  add(work) {
    return new Promise((resolve, reject) => {
      this.#waiting.push({ work, resolve, reject });
      this.#drain();
    });
  }

  #drain() {
    while (this.#active < this.concurrency && this.#waiting.length) {
      const item = this.#waiting.shift();
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
