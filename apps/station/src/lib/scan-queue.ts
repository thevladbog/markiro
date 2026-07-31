import type { ScanVerdict } from "@markiro/domain";

/** The result of judging and journalling one scan. */
export interface ScanOutcome {
  raw: string;
  verdict: ScanVerdict;
  /** When this code was first accepted — only set for a duplicate. */
  firstSeen: string | null;
}

export interface ScanQueueDeps {
  /** Validate + journal one scan. Runs with no other scan in flight. */
  process(raw: string): Promise<ScanOutcome>;
  onOutcome(outcome: ScanOutcome): void;
  /**
   * Called when `process` throws, so a lost write is never silent — the
   * operator scanned something and must see SOME signal, even a failure one.
   */
  onError?(raw: string, err: unknown): void;
}

export interface ScanQueue {
  enqueue(raw: string): void;
  /** Runs a side-channel write in strict order with scans. */
  enqueueJob(job: () => Promise<void>): void;
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
export function createScanQueue(deps: ScanQueueDeps): ScanQueue {
  const buffer: QueueEntry[] = [];
  let draining = false;
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
          }
          continue;
        }
        const { raw } = entry;
        let outcome: ScanOutcome;
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
    enqueue(raw: string) {
      buffer.push({ type: "scan", raw });
      void drain();
    },
    enqueueJob(job: () => Promise<void>) {
      buffer.push({ type: "job", run: job });
      void drain();
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
