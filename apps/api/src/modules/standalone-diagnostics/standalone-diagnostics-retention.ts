import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from "@nestjs/common";
import { StandaloneDiagnosticsService } from "./standalone-diagnostics.service";

const PURGE_INTERVAL_MS = 24 * 60 * 60 * 1_000;
/** A first pass soon after the start: a deploy restarts the API, which would otherwise reset the day forever. */
const FIRST_PURGE_DELAY_MS = 60 * 1_000;

/** Deletes support reports past the 24-month retention (decision В6); idempotent across replicas. */
@Injectable()
export class StandaloneDiagnosticsRetention implements OnModuleInit, OnModuleDestroy {
  readonly #logger = new Logger(StandaloneDiagnosticsRetention.name);
  #timer: NodeJS.Timeout | undefined;
  #first: NodeJS.Timeout | undefined;

  constructor(private readonly diagnostics: StandaloneDiagnosticsService) {}

  onModuleInit(): void {
    const purge = () => {
      void this.diagnostics.purgeExpired().catch(() => {
        this.#logger.error("Could not purge expired support diagnostics");
      });
    };
    this.#first = setTimeout(purge, FIRST_PURGE_DELAY_MS);
    this.#first.unref();
    this.#timer = setInterval(purge, PURGE_INTERVAL_MS);
    this.#timer.unref();
  }

  onModuleDestroy(): void {
    if (this.#first) clearTimeout(this.#first);
    if (this.#timer) clearInterval(this.#timer);
  }
}
