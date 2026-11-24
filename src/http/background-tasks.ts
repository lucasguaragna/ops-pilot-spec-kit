/**
 * Holds work that runs after a reply was sent, such as the learning step. Nothing awaits a tracked
 * task in the request path; tests (and a later shutdown) await `settled()` instead.
 */
export class BackgroundTasks {
  private readonly tasks = new Set<Promise<unknown>>();

  /** Adds a task and drops it once it settles. A rejection is swallowed here, never unhandled. */
  track(task: Promise<unknown>): void {
    this.tasks.add(task);
    const remove = () => {
      this.tasks.delete(task);
    };
    task.then(remove, remove);
  }

  /** How many tracked tasks have not settled yet. */
  get pending(): number {
    return this.tasks.size;
  }

  /** Resolves once no task is pending, including tasks tracked while waiting. Never rejects. */
  async settled(): Promise<void> {
    while (this.tasks.size > 0) await Promise.allSettled([...this.tasks]);
  }
}
