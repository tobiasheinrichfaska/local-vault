// A read/write lock for async work: any number of `shared` holders at once, or one `exclusive` holder
// alone. First come, first served — a shared request behind a waiting exclusive one waits too, so the
// exclusive holder is never starved. The vault uses it around blob writes (shared) and the sweep of
// orphaned blocks (exclusive) where the browser has no Web Locks.

export type LockMode = 'shared' | 'exclusive';

interface Waiter {
  readonly mode: LockMode;
  readonly go: () => void;
}

export class RwLock {
  private shared = 0;
  private exclusive = false;
  private readonly queue: Waiter[] = [];

  /** Runs `work` once the lock is held in `mode`; releases it when `work` ends or throws. */
  async run<T>(mode: LockMode, work: () => Promise<T>): Promise<T> {
    await new Promise<void>((go) => {
      this.queue.push({ mode, go });
      this.pump();
    });
    try {
      return await work();
    } finally {
      if (mode === 'exclusive') this.exclusive = false;
      else this.shared--;
      this.pump();
    }
  }

  private pump(): void {
    for (let next = this.queue[0]; next; next = this.queue[0]) {
      if (this.exclusive) return;
      if (next.mode === 'exclusive') {
        if (this.shared > 0) return;
        this.exclusive = true;
      } else this.shared++;
      this.queue.shift();
      next.go();
    }
  }
}
