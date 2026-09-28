import test from "node:test";
import assert from "node:assert/strict";
import { WorkQueue } from "../src/queue.mjs";

test("removes a cancelled request while it is queued", async () => {
  const queue = new WorkQueue(1);
  let release;
  const first = queue.add(() => new Promise((resolve) => { release = resolve; }));
  const controller = new AbortController();
  const second = queue.add(() => Promise.resolve("unexpected"), { signal: controller.signal });
  controller.abort();
  await assert.rejects(second, /cancelled/);
  assert.equal(queue.stats.queued, 0);
  release("done");
  await first;
});

test("applies queue capacity and wait timeout", async () => {
  const queue = new WorkQueue(1, { maxQueued: 1, queueTimeoutMs: 20 });
  let release;
  const first = queue.add(() => new Promise((resolve) => { release = resolve; }));
  const timedOut = queue.add(() => Promise.resolve());
  await assert.rejects(queue.add(() => Promise.resolve()), (error) => error.status === 429);
  await assert.rejects(timedOut, (error) => error.status === 504);
  release();
  await first;
});

test("rejects queued and future work after close", async () => {
  const queue = new WorkQueue(1);
  let release;
  const first = queue.add(() => new Promise((resolve) => { release = resolve; }));
  const queued = queue.add(() => Promise.resolve());
  queue.close();
  await assert.rejects(queued, (error) => error.status === 503);
  await assert.rejects(queue.add(() => Promise.resolve()), (error) => error.status === 503);
  release();
  await first;
});
