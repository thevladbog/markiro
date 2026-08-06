export interface ConfigTransitionGeneration {
  readonly value: number;
}

export interface ConfigTransition<T> {
  generation: ConfigTransitionGeneration;
  /** Rechecks the exact React config snapshot immediately around the durable mutation. */
  isOriginCurrent: () => boolean;
  transition: () => Promise<T>;
  /** Runs synchronously before the serialized boundary is released. */
  publish: (value: T) => void;
}

export type ConfigTransitionResult = "committed" | "stale";

/**
 * Serializes every station-config mutation behind a monotonic generation.
 * `begin()` invalidates older work synchronously, including a response that
 * is still in flight. A generation is checked before the durable mutation
 * and again before its React state is published. If a newer transition
 * starts during an awaited write, it queues behind that write and therefore
 * owns the final durable state.
 */
export class ConfigTransitionCoordinator {
  private currentGeneration = 0;
  private tail: Promise<void> = Promise.resolve();

  begin(): ConfigTransitionGeneration {
    return { value: ++this.currentGeneration };
  }

  seal(): void {
    this.currentGeneration += 1;
  }

  isCurrent(generation: ConfigTransitionGeneration): boolean {
    return generation.value === this.currentGeneration;
  }

  commit<T>({
    generation,
    isOriginCurrent,
    transition,
    publish,
  }: ConfigTransition<T>): Promise<ConfigTransitionResult> {
    const run = this.tail.then(async (): Promise<ConfigTransitionResult> => {
      if (!this.isCurrent(generation) || !isOriginCurrent()) return "stale";
      const value = await transition();
      if (!this.isCurrent(generation) || !isOriginCurrent()) return "stale";
      publish(value);
      return "committed";
    });
    this.tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }
}
