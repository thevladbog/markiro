import { HttpException, HttpStatus, Injectable } from "@nestjs/common";

const WINDOW_MS = 60_000;
const SOURCE_BUDGET = 100;
const INVITATION_BUDGET = 20;
const MAX_TRACKED_WINDOWS = 10_000;

interface WindowCounter {
  startedAt: number;
  count: number;
}

@Injectable()
export class InvitationLookupRateLimiter {
  readonly #counters = new Map<string, WindowCounter>();

  assertAllowed(source: string, invitationId: string, now = Date.now()): void {
    const normalizedSource = source.trim().slice(0, 128) || "unknown";
    this.#charge(`source:${normalizedSource}`, "overflow:source", SOURCE_BUDGET, now);
    this.#charge(
      `invitation:${normalizedSource}:${invitationId}`,
      "overflow:invitation",
      INVITATION_BUDGET,
      now,
    );
  }

  #charge(rawKey: string, overflowKey: string, budget: number, now: number): void {
    const key = this.#boundedKey(rawKey, overflowKey, now);
    const current = this.#counters.get(key);
    const window =
      !current || now - current.startedAt >= WINDOW_MS ? { startedAt: now, count: 0 } : current;
    window.count += 1;
    this.#counters.set(key, window);
    if (window.count > budget) {
      throw new HttpException(
        "Invitation lookup rate limit exceeded",
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
  }

  #boundedKey(rawKey: string, overflowKey: string, now: number): string {
    if (this.#counters.has(rawKey) || this.#counters.size < MAX_TRACKED_WINDOWS) return rawKey;
    for (const [key, value] of this.#counters) {
      if (now - value.startedAt >= WINDOW_MS) this.#counters.delete(key);
    }
    return this.#counters.size < MAX_TRACKED_WINDOWS ? rawKey : overflowKey;
  }
}
