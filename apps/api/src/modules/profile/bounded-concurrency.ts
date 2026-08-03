export class BoundedConcurrencyLimiter {
  #active = 0;
  readonly #waiting: Array<() => void> = [];

  constructor(
    private readonly concurrency: number,
    private readonly maxQueueDepth: number,
  ) {
    if (!Number.isInteger(concurrency) || concurrency < 1) {
      throw new Error("Concurrency must be a positive integer");
    }
    if (!Number.isInteger(maxQueueDepth) || maxQueueDepth < 0) {
      throw new Error("Queue depth must be a non-negative integer");
    }
  }

  async run<T>(action: () => Promise<T>): Promise<T> {
    if (this.#active < this.concurrency) {
      this.#active += 1;
    } else {
      if (this.#waiting.length >= this.maxQueueDepth) {
        throw new Error("Concurrency queue is full");
      }
      await new Promise<void>((resolve) => this.#waiting.push(resolve));
    }
    try {
      return await action();
    } finally {
      const next = this.#waiting.shift();
      if (next) next();
      else this.#active -= 1;
    }
  }
}
