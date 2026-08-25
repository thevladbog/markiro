import type { ScanVerdict } from "@markiro/domain";

/** The result of judging and journalling one scan. */
export interface ScanOutcome {
  raw: string;
  verdict: ScanVerdict;
  /** When this code was first accepted — only set for a duplicate. */
  firstSeen: string | null;
  /** The accepted scan brought this shift exactly to its planned quantity. */
  planReached?: boolean;
}

export interface ScanQueueDeps<TOutcome = ScanOutcome> {
  /**
   * Re-checks floor admission when a buffered scan reaches the head of the
   * queue. A close can enter a blocking recovery state while later physical
   * scans are already buffered; those scans must not reach the journal.
   */
  shouldProcess?(raw: string): boolean;
  /** Validate + journal one scan. Runs with no other scan in flight. */
  process(raw: string): Promise<TOutcome>;
  onOutcome(outcome: TOutcome): void;
  /**
   * Called when `process` throws, so a lost write is never silent — the
   * operator scanned something and must see SOME signal, even a failure one.
   */
  onError?(raw: string, err: unknown): void;
  /** Called when an ordered correction/box action fails. */
  onJobError?(err: unknown): void;
}

export interface ScanQueue {
  /** Reopens intake after React StrictMode's simulated setup/cleanup cycle. */
  open(): void;
  /** Stops accepting new work and resolves after every already accepted entry finishes. */
  close(): Promise<void>;
  /** Returns false after close, when intake is no longer accepted. */
  enqueue(raw: string): boolean;
  /** Runs a side-channel write in strict order with scans. */
  enqueueJob(job: () => Promise<void>): boolean;
  /** Drops scans buffered before a newly-entered blocking floor state. */
  discardBufferedScans(): void;
  /** Resolves once the queue has drained (tests await this instead of sleeping). */
  idle(): Promise<void>;
  pending(): number;
}

type QueueEntry = { type: "scan"; raw: string } | { type: "job"; run: () => Promise<void> };

/**
 * Processes scans strictly one at a time.
 *
 * An operator scans several codes per second. Concurrent processing would let
 * two scans both pass the duplicate check before either is written — the
 * in-memory index and the `codes_mirror` insert would both still be racing,
 * so neither scan would see the other as a duplicate — and would let their
 * journal writes land out of scan order. Draining serially keeps duplicate
 * detection honest (one scan's write always completes before the next one's
 * check runs) and keeps outcomes in scan order, and makes the loop
 * deterministic in tests.
 *
 * A scan that arrives mid-flight is buffered, never dropped — dropping input
 * on a production line silently loses codes.
 */
export function createScanQueue<TOutcome = ScanOutcome>(deps: ScanQueueDeps<TOutcome>): ScanQueue {
  const buffer: QueueEntry[] = [];
  let draining = false;
  let accepting = true;
  let idleResolvers: (() => void)[] = [];

  function settleIdle() {
    const resolvers = idleResolvers;
    idleResolvers = [];
    for (const resolve of resolvers) resolve();
  }

  async function drain() {
    if (draining) return;
    draining = true;
    try {
      while (buffer.length > 0) {
        const entry = buffer.shift()!;
        if (entry.type === "job") {
          try {
            await entry.run();
          } catch (err) {
            console.error("station: scan-queue job failed", err);
            deps.onJobError?.(err);
          }
          continue;
        }
        const { raw } = entry;
        if (deps.shouldProcess && !deps.shouldProcess(raw)) {
          console.warn("station: scan discarded by floor admission");
          continue;
        }
        let outcome: TOutcome;
        try {
          outcome = await deps.process(raw);
        } catch (err) {
          // One bad scan must never stall the line: log, signal, take the
          // next. deps.onOutcome is deliberately called OUTSIDE this try —
          // a throw from the UI callback must never be misreported as a
          // processing (validate/journal) failure.
          console.error("station: scan processing failed", err);
          deps.onError?.(raw, err);
          continue;
        }
        deps.onOutcome(outcome);
      }
    } finally {
      draining = false;
      settleIdle();
    }
  }

  return {
    open() {
      accepting = true;
    },
    close() {
      accepting = false;
      if (!draining && buffer.length === 0) return Promise.resolve();
      return new Promise<void>((resolve) => idleResolvers.push(resolve));
    },
    enqueue(raw: string) {
      if (!accepting) return false;
      buffer.push({ type: "scan", raw });
      void drain();
      return true;
    },
    enqueueJob(job: () => Promise<void>) {
      if (!accepting) return false;
      buffer.push({ type: "job", run: job });
      void drain();
      return true;
    },
    discardBufferedScans() {
      for (let index = buffer.length - 1; index >= 0; index -= 1) {
        if (buffer[index]?.type === "scan") buffer.splice(index, 1);
      }
    },
    idle() {
      if (!draining && buffer.length === 0) return Promise.resolve();
      return new Promise<void>((resolve) => idleResolvers.push(resolve));
    },
    pending() {
      return buffer.length;
    },
  };
}
