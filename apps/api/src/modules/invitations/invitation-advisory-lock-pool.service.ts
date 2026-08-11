import { Inject, Injectable, Logger, type OnModuleDestroy } from "@nestjs/common";
import { createDb } from "@markiro/db";
import type { MailPgClient } from "../mail/mail-jobs.service";

export const INVITATION_ADVISORY_LOCK_DATABASE_URL = Symbol(
  "INVITATION_ADVISORY_LOCK_DATABASE_URL",
);
export const INVITATION_ADVISORY_LOCK_POOL_MAX = 4;

type AdvisoryLockPool = ReturnType<typeof createDb>["pool"];
export type InvitationAdvisoryLockClient = MailPgClient;

@Injectable()
export class InvitationAdvisoryLockPool implements OnModuleDestroy {
  readonly #logger = new Logger(InvitationAdvisoryLockPool.name);
  readonly #pool: AdvisoryLockPool;

  constructor(@Inject(INVITATION_ADVISORY_LOCK_DATABASE_URL) databaseUrl: string) {
    this.#pool = createDb(databaseUrl, { max: INVITATION_ADVISORY_LOCK_POOL_MAX }).pool;
    this.#pool.on("error", () => {
      this.#logger.error("An idle invitation advisory-lock connection failed");
    });
  }

  connect(): Promise<InvitationAdvisoryLockClient> {
    return this.#pool.connect();
  }

  async onModuleDestroy(): Promise<void> {
    await this.#pool.end();
  }
}
