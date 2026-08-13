import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from "@nestjs/common";
import { MediaAssetsService } from "./media-assets.service";

const RECONCILE_INTERVAL_MS = 5 * 60 * 1_000;

@Injectable()
export class MediaAssetsReconciler implements OnModuleInit, OnModuleDestroy {
  readonly #logger = new Logger(MediaAssetsReconciler.name);
  #timer?: NodeJS.Timeout;

  constructor(private readonly mediaAssets: MediaAssetsService) {}

  onModuleInit(): void {
    this.#timer = setInterval(() => void this.runOnce(), RECONCILE_INTERVAL_MS);
    this.#timer.unref();
    void this.runOnce();
  }

  onModuleDestroy(): void {
    if (this.#timer) clearInterval(this.#timer);
  }

  private async runOnce(): Promise<void> {
    try {
      const count = await this.mediaAssets.reconcile();
      if (count > 0) this.#logger.log(`Reconciled ${count} stale media asset(s)`);
    } catch (error) {
      this.#logger.error(
        `Could not reconcile stale media assets: ${
          error instanceof Error ? error.message : "unknown error"
        }`,
      );
    }
  }
}
