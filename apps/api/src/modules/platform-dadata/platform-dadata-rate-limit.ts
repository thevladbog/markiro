import { HttpException, HttpStatus } from "@nestjs/common";

const WINDOW_MS = 60_000;
const MAX_REQUESTS = 60;

export class PlatformDadataRateLimit {
  readonly #requestsByPrincipal = new Map<string, number[]>();

  constructor(private readonly now: () => number = Date.now) {}

  consume(platformUserId: string): void {
    const now = this.now();
    const windowStart = now - WINDOW_MS;
    const recent = (this.#requestsByPrincipal.get(platformUserId) ?? []).filter(
      (timestamp) => timestamp > windowStart,
    );
    if (recent.length >= MAX_REQUESTS) {
      this.#requestsByPrincipal.set(platformUserId, recent);
      throw new HttpException({ code: "dadata_rate_limited" }, HttpStatus.TOO_MANY_REQUESTS);
    }
    recent.push(now);
    this.#requestsByPrincipal.set(platformUserId, recent);
  }
}
