import { inArray } from "drizzle-orm";

import { schema, type Db } from "@markiro/db";

/**
 * Moves every claimable background run in the database to a terminal state, so
 * that no pg-boss worker can execute it. Call it in `beforeAll` right after
 * `db = setup.db` (before `app.init()`), in `afterAll` before `app.close()`, or
 * both.
 *
 * Test files share ONE database and each e2e suite boots the real `AppModule`,
 * pg-boss included. A suite that leaves work claimable therefore hands it to
 * whichever file runs next: `PgBossService.onModuleInit` re-enqueues it
 * (`reconcileQueuedInventoryDocumentRuns` / `reconcileQueuedShiftExports`),
 * that file's own worker runs it, and -- because `StorageModule` is `@Global`
 * -- the runners write their artifacts through THAT file's
 * `.overrideProvider(ObjectStorageService)` mock. A foreign
 * `tenants/<other tenant>/...` object then appears in the mock at an arbitrary
 * moment, which is how `inventory-snapshot.e2e.test.ts` once saw
 * `expected 7 to be 6` on CI. Mock call counts and any
 * `mockImplementationOnce`/`mockRejectedValueOnce` on the storage double are
 * exposed the same way, and scoping an assertion cannot defend those.
 *
 * Two suites produce such leftovers today, both by design: this repository's
 * `inventory-documents.e2e.test.ts` (four `queued` runs, since it stubs
 * `PgBossService` and never processes them) and `shift-exports.e2e.test.ts`
 * (eight `queued` exports, same reason). Both call this in `afterAll`; the
 * suites that mock object storage call it in `beforeAll` as well, so that a
 * single file run against a database left dirty by an aborted run is safe too.
 *
 * Rows are settled rather than deleted: `inventory_document_artifacts` and
 * `shift_export_artifacts` reference them, and `failed` is the state both
 * runners would have reached anyway. `queued` AND `processing` both matter --
 * `claim()` in either runner takes a `processing` row back once its lease
 * expires.
 *
 * This assumes nothing else is running against the same database: test files do
 * not run concurrently (`fileParallelism: false` in `vitest.config.ts`), and a
 * second session must not share this one's Postgres -- give each run its own
 * database, as the local recipes already require. Either would make one run
 * settle another's in-flight rows. That fails loudly in the suite that owns
 * them rather than corrupting anything, which is the same trade the shared
 * database already makes elsewhere.
 */
export async function settleQueuedBackgroundWork(db: Db): Promise<void> {
  const completedAt = new Date();
  await db
    .update(schema.inventoryDocumentRuns)
    .set({
      status: "failed",
      errorCode: "GENERATION_FAILED",
      completedAt,
      updatedAt: completedAt,
    })
    .where(inArray(schema.inventoryDocumentRuns.status, ["queued", "processing"]));
  await db
    .update(schema.shiftExports)
    .set({
      status: "failed",
      errorCode: "GENERATION_FAILED",
      completedAt,
      updatedAt: completedAt,
    })
    .where(inArray(schema.shiftExports.status, ["queued", "processing"]));
}
