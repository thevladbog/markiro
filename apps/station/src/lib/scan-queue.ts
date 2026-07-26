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
}

export interface ScanQueue {
  enqueue(raw: string): void;
  /** Resolves once the queue has drained (tests await this instead of sleeping). */
  idle(): Promise<void>;
  pending(): number;
}

/**
 * Processes scans strictly one at a time.
 *
 * An operator scans several codes per second. Concurrent processing would let
 * two scans both pass the duplicate check before either is written, and would
 * make them contend for tauri-plugin-sql's connection pool (its BEGIN/COMMIT
 * can otherwise land on different connections). Draining serially removes
 * both problems by construction and makes the loop deterministic in tests.
 *
 * A scan that arrives mid-flight is buffered, never dropped — dropping input
 * on a production line silently loses codes.
 */
export function createScanQueue(deps: ScanQueueDeps): ScanQueue {
  const buffer: string[] = [];
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
        const raw = buffer.shift()!;
        try {
          deps.onOutcome(await deps.process(raw));
        } catch (err) {
          // One bad scan must never stall the line: log and take the next.
          console.error("station: scan processing failed", err);
        }
      }
    } finally {
      draining = false;
      settleIdle();
    }
  }

  return {
    enqueue(raw: string) {
      buffer.push(raw);
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
