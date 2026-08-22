import type { DadataSuggestionResult } from "./dadata.types";

const DEFAULT_TTL_MS = 15 * 60_000;

export class DadataCache {
  readonly #entries = new Map<
    string,
    { expiresAt: number; value: DadataSuggestionResult<unknown> }
  >();

  constructor(
    private readonly now: () => number = Date.now,
    private readonly ttlMs = DEFAULT_TTL_MS,
  ) {}

  get<T>(key: string): DadataSuggestionResult<T> | undefined {
    const entry = this.#entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= this.now()) {
      this.#entries.delete(key);
      return undefined;
    }
    return structuredClone(entry.value) as DadataSuggestionResult<T>;
  }

  set<T>(key: string, value: DadataSuggestionResult<T>): void {
    this.#entries.set(key, {
      expiresAt: this.now() + this.ttlMs,
      value: structuredClone(value),
    });
  }
}
