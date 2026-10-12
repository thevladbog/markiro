import type { UsRequestWorkerResult } from "../modules/traceability/requests/us-request-worker";

export type UsWorkerProcessEvent = Readonly<{
  event: "started" | "result" | "iteration_failed" | "stopping" | "stopped";
  kind?: UsRequestWorkerResult["kind"];
  completedIterations: number;
}>;
export type UsWorkerDrainResult = Readonly<{ kind: "graceful" | "force_exit" }>;
export type UsRequestWorkerLoopOptions = Readonly<{
  runOne: () => Promise<UsRequestWorkerResult>;
  emit: (event: UsWorkerProcessEvent) => void;
  wait?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
}>;

function waitForPoll(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const finish = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, milliseconds);
    signal.addEventListener("abort", finish, { once: true });
  });
}

function resultKind(result: UsRequestWorkerResult): UsRequestWorkerResult["kind"] {
  const kind = result.kind;
  switch (kind) {
    case "storage_unavailable":
    case "idle":
    case "ready":
    case "retry_scheduled":
    case "failed":
    case "lease_lost":
    case "outcome_unresolved":
      return kind;
    default:
      throw new Error("us_request_worker_result_invalid");
  }
}

/** Process scheduling only: invocation leases, persistence and resource closure
 * remain with their existing owners. A drain deadline never settles the core run. */
export class UsRequestWorkerLoop {
  private started = false;
  private stopping = false;
  private finished = false;
  private completedIterations = 0;
  private readonly idleWait = new AbortController();
  private readonly lifetime: Promise<void>;
  private finishLifetime: () => void = () => {};
  private drain: Promise<UsWorkerDrainResult> | undefined;

  constructor(private readonly options: UsRequestWorkerLoopOptions) {
    this.lifetime = new Promise((resolve) => {
      this.finishLifetime = resolve;
    });
  }

  run(): Promise<void> {
    if (!this.started) {
      this.started = true;
      if (this.stopping) {
        this.finish();
      } else {
        this.emit("started");
        // The shared lifetime already exists before any callback can reenter run/stop.
        void this.poll().then(
          () => this.finish(),
          () => {
            this.emit("iteration_failed");
            this.finish();
          },
        );
      }
    }
    return this.lifetime;
  }

  stop(): Promise<UsWorkerDrainResult> {
    if (this.drain) return this.drain;
    // Inhibit claims before invoking a callback, aborting idle wait or awaiting work.
    this.stopping = true;
    this.drain = new Promise((resolve) => {
      const timer = setTimeout(() => resolve({ kind: "force_exit" }), 30_000);
      void this.lifetime.then(() => {
        clearTimeout(timer);
        resolve({ kind: "graceful" });
      });
    });
    this.emit("stopping");
    this.idleWait.abort();
    if (!this.started) {
      this.started = true;
      this.finish();
    }
    return this.drain;
  }

  private async poll(): Promise<void> {
    while (!this.stopping) {
      let milliseconds = 1000;
      try {
        const kind = resultKind(await this.options.runOne());
        this.completedIterations++;
        this.emit("result", kind);
      } catch {
        this.completedIterations++;
        this.emit("iteration_failed");
        milliseconds = 5000;
      }
      if (this.stopping) break;
      try {
        await (this.options.wait ?? waitForPoll)(milliseconds, this.idleWait.signal);
      } catch {
        // An aborting wait may reject. Other scheduler failures stay sanitized
        // and use the built-in delay rather than spinning a failing injected wait.
        if (!this.stopping) {
          this.emit("iteration_failed");
          await waitForPoll(5000, this.idleWait.signal);
        }
      }
    }
  }

  private emit(event: UsWorkerProcessEvent["event"], kind?: UsRequestWorkerResult["kind"]): void {
    try {
      this.options.emit({
        event,
        ...(kind === undefined ? {} : { kind }),
        completedIterations: this.completedIterations,
      });
    } catch {
      // Diagnostics cannot change worker outcomes or expose a caught exception.
    }
  }

  private finish(): void {
    if (this.finished) return;
    this.finished = true;
    this.emit("stopped");
    this.finishLifetime();
  }
}
