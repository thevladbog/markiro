/**
 * The work of a shift's screen in strict order, one job at a time (a port of
 * the cloud station's `scan-queue.ts`): two scans of one code never both pass
 * the check before either is written, a box closes between the scan that
 * filled it and the next one, and outcomes come in the order of the scans. A
 * scan that arrives meanwhile waits its turn; it is never dropped. A job that
 * fails does not stop the next.
 */
export interface WorkQueue {
  /** Runs `job` after every job queued before it; resolves or rejects as it does. */
  run: <T>(job: () => Promise<T>) => Promise<T>;
  /** Jobs queued or running. */
  pending: () => number;
}

export function createWorkQueue(): WorkQueue {
  let tail: Promise<void> = Promise.resolve();
  let pending = 0;
  return {
    run: <T>(job: () => Promise<T>) => {
      pending += 1;
      const result = tail.then(job);
      const settled = () => {
        pending -= 1;
      };
      tail = result.then(settled, settled);
      return result;
    },
    pending: () => pending,
  };
}
