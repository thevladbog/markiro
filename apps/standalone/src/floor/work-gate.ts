/**
 * The work of the shift's screen that must end before the operator leaves it
 * (stage 2a spec §5.1; `apps/station/AGENTS.md`, «Task closure»: unmounting
 * proves nothing stopped). The work screen hands every such piece of work to
 * `track` — a scan on its way through the pipeline, a box closing, a label
 * being sent — and the floor leaves the shift only after `drain`.
 */
export interface WorkGate {
  /** Holds every later `drain` until `work` settles; returns `work` itself. */
  track: <T>(work: Promise<T>) => Promise<T>;
  /**
   * Resolves once every tracked piece of work has settled, a rejected one
   * included, and work tracked while it waits as well.
   */
  drain: () => Promise<void>;
  /** How many pieces of work are still running. */
  pending: () => number;
}

export function createWorkGate(): WorkGate {
  const running = new Set<Promise<void>>();
  return {
    track: (work) => {
      // Removed when it settles, before anything awaiting it runs on.
      const settled: Promise<void> = work.then(
        () => {
          running.delete(settled);
        },
        () => {
          running.delete(settled);
        },
      );
      running.add(settled);
      return work;
    },
    drain: async () => {
      // Each round waits for what runs now and forgets it; work tracked
      // meanwhile makes another round.
      while (running.size > 0) {
        const round = [...running];
        await Promise.all(round);
        for (const done of round) running.delete(done);
      }
    },
    pending: () => running.size,
  };
}
