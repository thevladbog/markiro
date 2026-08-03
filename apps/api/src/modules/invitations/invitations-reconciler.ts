import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from "@nestjs/common";
import { InvitationsService } from "./invitations.service";

const RECONCILE_INTERVAL_MS = 5 * 60 * 1_000;

@Injectable()
export class InvitationsReconciler implements OnModuleInit, OnModuleDestroy {
  readonly #logger = new Logger(InvitationsReconciler.name);
  #timer: NodeJS.Timeout | undefined;

  constructor(private readonly invitations: InvitationsService) {}

  onModuleInit(): void {
    this.#timer = setInterval(() => {
      void this.invitations.reconcileAccepted().catch(() => {
        this.#logger.error("Could not reconcile accepted invitation extensions");
      });
    }, RECONCILE_INTERVAL_MS);
    this.#timer.unref();
  }

  onModuleDestroy(): void {
    if (this.#timer) clearInterval(this.#timer);
  }
}
