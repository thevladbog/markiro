import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from "@nestjs/common";
import { ProfileService } from "./profile.service";

const RECONCILE_INTERVAL_MS = 5 * 60 * 1_000;

@Injectable()
export class ProfileAssetsReconciler implements OnModuleInit, OnModuleDestroy {
  readonly #logger = new Logger(ProfileAssetsReconciler.name);
  #timer?: NodeJS.Timeout;

  constructor(private readonly profiles: ProfileService) {}

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
      const count = await this.profiles.reconcileAssets();
      if (count > 0) this.#logger.log(`Reconciled ${count} stale profile asset(s)`);
    } catch (error) {
      this.#logger.error(
        `Could not reconcile stale profile assets: ${
          error instanceof Error ? error.message : "unknown error"
        }`,
      );
    }
  }
}
