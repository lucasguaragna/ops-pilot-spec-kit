import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { BackgroundTasks } from "./background-tasks.ts";

/** A promise with its resolve and reject exposed, so a test settles it by hand. */
function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Lets every pending promise callback run. */
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

describe("BackgroundTasks", () => {
  it("settles at once when nothing is tracked", async () => {
    const tasks = new BackgroundTasks();
    assert.equal(tasks.pending, 0);
    await tasks.settled();
  });

  it("counts tracked tasks and drops each one when it resolves or rejects", async () => {
    const tasks = new BackgroundTasks();
    const first = deferred();
    const second = deferred();
    tasks.track(first.promise);
    tasks.track(second.promise);
    assert.equal(tasks.pending, 2);

    first.resolve();
    await flush();
    assert.equal(tasks.pending, 1);

    second.reject(new Error("boom"));
    await flush();
    assert.equal(tasks.pending, 0);
  });

  it("waits for a task that resolves later", async () => {
    const tasks = new BackgroundTasks();
    const task = deferred();
    tasks.track(task.promise);
    let done = false;
    const waiting = tasks.settled().then(() => {
      done = true;
    });
    await flush();
    assert.equal(done, false);

    task.resolve();
    await waiting;
    assert.equal(done, true);
  });

  it("also waits for a task tracked while it was already waiting", async () => {
    const tasks = new BackgroundTasks();
    const first = deferred();
    const second = deferred();
    tasks.track(first.promise);
    let done = false;
    const waiting = tasks.settled().then(() => {
      done = true;
    });

    tasks.track(second.promise);
    first.resolve();
    await flush();
    assert.equal(done, false);

    second.resolve();
    await waiting;
    assert.equal(done, true);
  });

  it("never rejects when a tracked task rejects", async () => {
    const tasks = new BackgroundTasks();
    const task = deferred();
    tasks.track(task.promise);
    task.reject(new Error("boom"));
    await tasks.settled();
    assert.equal(tasks.pending, 0);
  });
});
