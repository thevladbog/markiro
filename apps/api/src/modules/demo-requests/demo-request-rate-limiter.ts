import { Injectable } from "@nestjs/common";
import { rateLimitedError } from "./demo-request.errors";

export interface DemoRequestRateLimiterOptions {
  windowMs: number;
  sourceBudget: number;
  globalBudget: number;
  maxTrackedWindows: number;
}

interface WindowCounter {
  startedAt: number;
  count: number;
}

const GLOBAL_KEY = "global";
const SOURCE_OVERFLOW_KEY = "overflow:source";

@Injectable()
export class DemoRequestRateLimiter {
  readonly #counters = new Map<string, WindowCounter>();
  readonly #options: DemoRequestRateLimiterOptions;

  constructor(options: DemoRequestRateLimiterOptions) {
    if (options.maxTrackedWindows < 2) {
      throw new RangeError("maxTrackedWindows must reserve global and overflow windows");
    }
    this.#options = options;
  }

  assertAllowed(source: string, now = Date.now()): void {
    const normalizedSource = source.trim().slice(0, 128) || "unknown";
    const globalExceeded = this.#charge(GLOBAL_KEY, this.#options.globalBudget, now);
    const sourceKey = this.#boundedSourceKey(`source:${normalizedSource}`, now);
    const sourceExceeded = this.#charge(sourceKey, this.#options.sourceBudget, now);

    if (sourceExceeded || globalExceeded) throw rateLimitedError();
  }

  #charge(key: string, budget: number, now: number): boolean {
    const current = this.#counters.get(key);
    const window =
      !current || now - current.startedAt >= this.#options.windowMs
        ? { startedAt: now, count: 0 }
        : current;
    window.count += 1;
    this.#counters.set(key, window);
    return window.count > budget;
  }

  #boundedSourceKey(rawKey: string, now: number): string {
    if (this.#counters.has(rawKey)) return rawKey;
    if (this.#counters.size >= this.#options.maxTrackedWindows - 1) {
      for (const [key, value] of this.#counters) {
        if (key !== GLOBAL_KEY && now - value.startedAt >= this.#options.windowMs) {
          this.#counters.delete(key);
        }
      }
    }
    return this.#counters.size < this.#options.maxTrackedWindows - 1 ? rawKey : SOURCE_OVERFLOW_KEY;
  }
}
