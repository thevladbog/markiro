import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { schema, type Db } from "@markiro/db";
import { eq } from "drizzle-orm";
import { loadEnv } from "../src/env";
import { setupAuth } from "../src/auth/auth.setup";
import { PgBossService } from "../src/jobs/jobs.module";
import { JournalService } from "../src/modules/integrations/journal.service";
import { ExchangeSessionService } from "../src/modules/exchange/exchange-session.service";
import type { MailJobsService } from "../src/modules/mail/mail-jobs.service";
import type { MailRetentionService } from "../src/modules/mail/mail-retention.service";
import type { SubscriptionStatusJob } from "../src/subscriptions/subscription-status.job";
import type { ShiftExportRunnerService } from "../src/modules/shift-exports/shift-export-runner.service";
import type { InventoryDocumentRunnerService } from "../src/modules/inventories/inventory-document-runner.service";
import type { SignerSchedulerService } from "../src/modules/signer-agents/signer-scheduler.service";

const ready = Boolean(
  process.env.DATABASE_URL && process.env.BETTER_AUTH_SECRET && process.env.BETTER_AUTH_URL,
);

/**
 * Fix 5 (final review): Task 16 wired up hourly cleanup for `kiosk_pair_
 * attempts`, daily cleanup for the integrations journal, and hourly sweeping
 * of expired `/1c_exchange` sessions -- but not `exchange_attempts`, its own
 * twin (same shape, same reason: `assertUnderCheckauthLimit` in
 * exchange-credentials.ts writes it from an unauthenticated route,
 * `checkauth`, with nothing else ever deleting a row). Constructs
 * `PgBossService` directly, bypassing `onModuleInit`'s real pg-boss
 * scheduling entirely (which needs its own `pgboss` schema and a running
 * worker loop this suite has no interest in) -- the one thing under test is
 * whether the prune QUERY itself, once wired, deletes the right rows.
 */
describe.skipIf(!ready)("PgBossService: prune exchange_attempts", () => {
  let db: Db;
  let service: PgBossService;
  const seededSources: string[] = [];

  beforeAll(() => {
    const env = loadEnv();
    const setup = setupAuth(env);
    db = setup.db;
    const journal = new JournalService(db);
    const exchangeSessions = new ExchangeSessionService(db, journal);
    const mailJobs = {} as MailJobsService;
    const mailRetention = {} as MailRetentionService;
    const shiftExportRunner = {} as ShiftExportRunnerService;
    service = new PgBossService(
      db,
      "unused-in-this-test",
      journal,
      exchangeSessions,
      mailJobs,
      mailRetention,
      {} as SubscriptionStatusJob,
      shiftExportRunner,
      {} as InventoryDocumentRunnerService,
      {} as SignerSchedulerService,
    );
  });

  afterAll(async () => {
    if (seededSources.length === 0) return;
    for (const source of seededSources) {
      await db.delete(schema.exchangeAttempts).where(eq(schema.exchangeAttempts.source, source));
    }
  });

  it("удаляет окна exchange_attempts старше часа, но не свежие", async () => {
    const staleSource = `stale-${randomUUID()}`;
    const freshSource = `fresh-${randomUUID()}`;
    seededSources.push(staleSource, freshSource);

    await db.insert(schema.exchangeAttempts).values([
      {
        source: staleSource,
        windowStartedAt: new Date(Date.now() - 2 * 3_600_000),
        failures: 3,
      },
      {
        source: freshSource,
        windowStartedAt: new Date(),
        failures: 1,
      },
    ]);

    // Private on the class -- exercised the same way pg-boss itself would
    // call it on a tick, not through pg-boss's own scheduling machinery.
    await (
      service as unknown as { runPruneExchangeAttempts: () => Promise<void> }
    ).runPruneExchangeAttempts();

    const rows = await db
      .select({ source: schema.exchangeAttempts.source })
      .from(schema.exchangeAttempts)
      .where(eq(schema.exchangeAttempts.source, staleSource));
    expect(rows).toHaveLength(0);

    const freshRows = await db
      .select({ source: schema.exchangeAttempts.source })
      .from(schema.exchangeAttempts)
      .where(eq(schema.exchangeAttempts.source, freshSource));
    expect(freshRows).toHaveLength(1);
  });
});
