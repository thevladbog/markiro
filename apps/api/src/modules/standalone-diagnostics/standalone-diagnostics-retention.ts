import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from "@nestjs/common";
import { StandaloneDiagnosticsService } from "./standalone-diagnostics.service";

const PURGE_INTERVAL_MS = 24 * 60 * 60 * 1_000;

/** Deletes support reports past the 24-month retention (decision В6); idempotent across replicas. */
@Injectable()
export class StandaloneDiagnosticsRetention implements OnModuleInit, OnModuleDestroy {
  readonly #logger = new Logger(StandaloneDiagnosticsRetention.name);
  #timer: NodeJS.Timeout | undefined;

  constructor(private readonly diagnostics: StandaloneDiagnosticsService) {}

  onModuleInit(): void {
    this.#timer = setInterval(() => {
      void this.diagnostics.purgeExpired().catch(() => {
        this.#logger.error("Could not purge expired support diagnostics");
      });
    }, PURGE_INTERVAL_MS);
    this.#timer.unref();
  }

  onModuleDestroy(): void {
    if (this.#timer) clearInterval(this.#timer);
  }
}
