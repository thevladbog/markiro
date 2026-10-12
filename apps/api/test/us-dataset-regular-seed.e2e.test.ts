import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { canonicalExportDigest } from "@markiro/domain";
import { createUsDatasetJournalFixture } from "./support/us-dataset-journal-fixture";
import { runDatasetCasesFixtureBody } from "./support/us-dataset-cases-fixture";
import { outcome, withOwnedWork } from "./support/us-transformation-lock-fixture";
import { randomUUID } from "node:crypto";
import { UsDatasetRegularSeedStore } from "../src/modules/traceability/demo/us-dataset-regular-seed";
import { UsDatasetJournalStore } from "../src/modules/traceability/demo/us-dataset-journal";
import { UsDatasetShippingSeedStore } from "../src/modules/traceability/demo/us-dataset-shipping-seed";
import { UsDatasetReferenceSeedStore } from "../src/modules/traceability/demo/us-dataset-reference-seed";
import { UsDatasetReceivingSeedStore } from "../src/modules/traceability/demo/us-dataset-receiving-seed";
import {
  makeUsDatasetReceivingInput,
  makeUsDatasetReferenceIdentity,
} from "../src/modules/traceability/demo/us-dataset-receiving-contract";
import { parseUsDatasetShippingResult } from "../src/modules/traceability/demo/us-dataset-shipping-contract";
import { usSixMonthDefinition } from "../src/modules/traceability/demo/us-six-month-definition";
import type { UsDatasetContext } from "../src/modules/traceability/demo/us-dataset-contract";

const base = process.env.US_TEST_DATABASE_URL;
describe.skipIf(!base)("actual sequential regular-chain range", () => {
  let f: Awaited<ReturnType<typeof createUsDatasetJournalFixture>>;
  let setup: ReturnType<typeof outcome<typeof f>> | undefined;
  let context: UsDatasetContext;
  beforeAll(async () => {
    if (!base) throw new Error("Missing isolated US URL");
    setup = outcome(createUsDatasetJournalFixture(base));
    const ready = await setup;
    if (ready.error !== undefined) throw ready.error;
    if (!ready.value) throw new Error("Missing owned fixture");
    f = ready.value;
  }, 60000);
  beforeEach(
    async () =>
      runDatasetCasesFixtureBody(async () => {
        context = await f.provision();
      }),
    60000,
  );
  afterAll(async () => {
    const ready = await setup;
    // Actual setup is drained even if the beforeAll timer fired before acquisition.
    await ready?.value?.close();
  }, 60000);

  // Skipping any stage, substituting one index, or reporting completion fails native facts.
  it(
    "creates fresh chains 0 and 1 with four finalized shipments, six lots and 120 boxes",
    async () =>
      runDatasetCasesFixtureBody(async () => {
        const seed = new UsDatasetRegularSeedStore(f.db);
        const range = { startIndex: 0, count: 2 };
        const result = await seed.initialize(context, range);
        expect(result).toMatchObject({
          version: "us-processor-six-month-v1",
          definitionDigest: usSixMonthDefinition.digest,
          range: { startIndex: 0, count: 2 },
          state: "selected_regular_shipping_verified",
          datasetComplete: false,
          chains: [
            { index: 0, unitKey: "chain_0000", shipmentCount: 2 },
            { index: 1, unitKey: "chain_0001", shipmentCount: 2 },
          ],
        });
        const counts = await f.pool.query(
          "SELECT (SELECT count(*)::int FROM shipping_event_roots WHERE tenant_id=$1 AND current_event_id IS NOT NULL AND pending_draft_id IS NULL) AS shipping, (SELECT count(*)::int FROM traceability_lots WHERE tenant_id=$1) AS lots, (SELECT count(*)::int FROM boxes WHERE tenant_id=$1) AS boxes",
          [context.tenantId],
        );
        expect(counts.rows).toEqual([{ shipping: 4, lots: 6, boxes: 120 }]);
        const journal = new UsDatasetJournalStore(f.db, usSixMonthDefinition);
        const header = await journal.read(context);
        expect(header?.id).toBe(result.datasetId);
        for (const [index, quantities, status, revision] of [
          [0, ["22", "23"], "active", 1],
          [1, ["26", "39"], "shipped", 2],
        ] as const) {
          const shipping = await new UsDatasetShippingSeedStore(f.db).verify(context, index);
          expect(
            shipping.shipments.map((row) => row.finalized.snapshot.items[0]?.quantity),
          ).toEqual(quantities);
          expect(shipping.outputLotAfter).toMatchObject({ status, revision });
          expect(result.chains[index]?.shippingResultDigest).toBe(canonicalExportDigest(shipping));
          for (const stage of ["receiving", "transformation", "cases", "shipping"] as const) {
            expect(
              await journal.readStage(context, result.datasetId, `chain_000${index}`, stage),
            ).toMatchObject({
              revision: 2,
              receipt: { resultDigest: expect.stringMatching(/^[a-f0-9]{64}$/) },
            });
          }
        }
        range.count = 1;
        expect(result.range).toEqual({ startIndex: 0, count: 2 });
        for (const value of [result, result.range, result.chains, ...result.chains])
          expect(Object.isFrozen(value)).toBe(true);
        expect(result.range).not.toBe(range);
        expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(256 * 1024);
        expect(Object.keys(result.chains[0] ?? {}).sort()).toEqual([
          "index",
          "shipmentCount",
          "shippingResultDigest",
          "unitKey",
        ]);
        const before = await f.snapshot();
        expect(await seed.initialize(context, { startIndex: 0, count: 2 })).toEqual(result);
        expect(await seed.verify(context, { startIndex: 0, count: 2 })).toEqual(result);
        expect(await f.snapshot()).toEqual(before);
        console.info("Task1 fresh 0/1 and no-write replay", {
          tables: Object.keys(before).length,
          hash: canonicalExportDigest(before),
          summaryDigest: canonicalExportDigest(result),
        });
      }),
    30000,
  );

  it(
    "executes Scenario A 259 as 100 cases and one 100-case shipment",
    async () =>
      runDatasetCasesFixtureBody(async () => {
        const seed = new UsDatasetRegularSeedStore(f.db);
        const range = { startIndex: 259, count: 1 };
        const result = await seed.initialize(context, range);
        expect(result.chains).toEqual([
          {
            index: 259,
            unitKey: "chain_0259",
            shipmentCount: 1,
            shippingResultDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
          },
        ]);
        const actual = await new UsDatasetShippingSeedStore(f.db).verify(context, 259);
        expect(actual.shipments.map((row) => row.finalized.snapshot.items[0]?.quantity)).toEqual([
          "100",
        ]);
        expect(actual.outputLotAfter).toMatchObject({ status: "shipped", revision: 2 });
        expect(result.chains[0]?.shippingResultDigest).toBe(canonicalExportDigest(actual));
        expect(
          (
            await f.pool.query("SELECT count(*)::int AS count FROM boxes WHERE tenant_id=$1", [
              context.tenantId,
            ])
          ).rows,
        ).toEqual([{ count: 100 }]);
        const before = await f.snapshot();
        expect(await seed.initialize(context, range)).toEqual(result);
        expect(await seed.verify(context, range)).toEqual(result);
        expect(await f.snapshot()).toEqual(before);
        console.info("Task1 Scenario A 259 no-write replay", {
          tables: Object.keys(before).length,
          hash: canonicalExportDigest(before),
        });
      }),
    30000,
  );

  it.each([
    "absent",
    "references",
    "receiving",
    "pending receiving",
    "completed first chain",
  ] as const)(
    "verify %s never installs missing selected state",
    async (state) =>
      runDatasetCasesFixtureBody(async () => {
        if (state === "completed first chain")
          await new UsDatasetRegularSeedStore(f.db).initialize(context, {
            startIndex: 0,
            count: 1,
          });
        else if (state !== "absent") {
          await new UsDatasetReferenceSeedStore(f.db).initialize(context);
          if (state === "receiving")
            await new UsDatasetReceivingSeedStore(f.db).initialize(context, 0);
          if (state === "pending receiving") {
            const journal = new UsDatasetJournalStore(f.db, usSixMonthDefinition);
            const header = await journal.read(context);
            if (!header) throw new Error("Missing references header");
            const references = await journal.readStage(
              context,
              header.id,
              "references",
              "references",
            );
            if (!references) throw new Error("Missing references stage");
            const input = makeUsDatasetReceivingInput(
              0,
              makeUsDatasetReferenceIdentity(header.id, references),
            );
            await journal.captureIntent(context, header.id, {
              unitKey: "chain_0000",
              stage: "receiving",
              operationKey: randomUUID(),
              input,
              inputDigest: canonicalExportDigest(input),
            });
          }
        }
        const before = await f.snapshot();
        await expect(
          new UsDatasetRegularSeedStore(f.db).verify(context, { startIndex: 0, count: 2 }),
        ).rejects.toThrow(state === "absent" ? "us_dataset_references_incomplete" : /incomplete/);
        expect(await f.snapshot()).toEqual(before);
      }),
    30000,
  );

  it(
    "invalid range fails before References without executing a getter or writing",
    async () =>
      runDatasetCasesFixtureBody(async () => {
        let reads = 0;
        const hostile = {
          get startIndex() {
            reads++;
            return 0;
          },
          count: 1,
        };
        const seed = new UsDatasetRegularSeedStore(f.db);
        const before = await f.snapshot();
        for (const range of [hostile, { startIndex: 259, count: 2 }, { startIndex: 0, count: 0 }]) {
          await expect(seed.initialize(context, range)).rejects.toThrow(
            "us_dataset_regular_range_invalid",
          );
          await expect(seed.verify(context, range)).rejects.toThrow(
            "us_dataset_regular_range_invalid",
          );
        }
        expect(reads).toBe(0);
        expect(await f.snapshot()).toEqual(before);
        expect(
          await new UsDatasetJournalStore(f.db, usSixMonthDefinition).read(context),
        ).toBeNull();
      }),
    30000,
  );

  it.each([
    "foreign tenant",
    "current owner",
    "current role",
    "actual database",
    "actual user",
  ] as const)(
    "guards %s before range getters in both modes",
    async (kind) =>
      runDatasetCasesFixtureBody(async () => {
        let db = f.db;
        if (kind === "current owner")
          await f.pool.query('UPDATE "user" SET name=$1 WHERE id=$2', [
            "changed owner",
            context.actorUserId,
          ]);
        if (kind === "current role")
          await f.pool.query("UPDATE member SET role='viewer' WHERE user_id=$1", [
            context.actorUserId,
          ]);
        if (kind === "actual user") db = await f.alternateRole();
        const checked = {
          ...context,
          ...(kind === "foreign tenant" ? { tenantId: randomUUID() } : {}),
          ...(kind === "actual database" ? { expectedDatabaseName: "wrong_db" } : {}),
        };
        let reads = 0;
        const hostile = {
          get startIndex(): never {
            reads++;
            throw new Error("hostile range getter");
          },
          count: 1,
        };
        const before = await f.snapshot();
        const seed = new UsDatasetRegularSeedStore(db);
        await expect(seed.initialize(checked, hostile)).rejects.toThrow(
          "us_dataset_target_invalid",
        );
        await expect(seed.verify(checked, hostile)).rejects.toThrow("us_dataset_target_invalid");
        expect(reads).toBe(0);
        expect(await f.snapshot()).toEqual(before);
      }),
    30000,
  );

  describe("owned failed range and explicit caller resume", () => {
    let failure: { error: unknown; attempts: { attempts: number }[] };
    let setupMs = 0;
    // This real multi-stage failure setup is independently registered and drained.
    // It starts fresh, so a whole-range transaction would lose chain 0 and fail the body.
    beforeEach(
      async () =>
        runDatasetCasesFixtureBody(async () => {
          const started = performance.now();
          const assertOwned = async () => {
            const actual = await f.pool.query(
              "SELECT current_database() AS name,current_user AS owner",
            );
            expect(actual.rows).toEqual([{ name: f.databaseName, owner: "markiro_us" }]);
          };
          failure = await withOwnedWork(async (own) => {
            await assertOwned();
            await f.pool.query("CREATE SEQUENCE task1_regular_attempts");
            own("exact owned failpoint sequence", async () => {
              await assertOwned();
              await f.pool.query("DROP SEQUENCE task1_regular_attempts");
            });
            await f.pool.query(
              "CREATE FUNCTION task1_regular_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.unit_key='chain_0001' AND NEW.stage='shipping' AND NEW.receipt IS NOT NULL THEN PERFORM nextval('task1_regular_attempts'); RAISE EXCEPTION 'task1_regular_original_sql' USING ERRCODE='40001'; END IF; RETURN NEW; END $$",
            );
            own("exact owned failpoint function", async () => {
              await assertOwned();
              await f.pool.query("DROP FUNCTION task1_regular_failure()");
            });
            await f.pool.query(
              "CREATE TRIGGER task1_regular_failure AFTER UPDATE ON traceability_demo_dataset_stages FOR EACH ROW EXECUTE FUNCTION task1_regular_failure()",
            );
            own("exact owned failpoint trigger", async () => {
              await assertOwned();
              await f.pool.query(
                "DROP TRIGGER task1_regular_failure ON traceability_demo_dataset_stages",
              );
            });
            const error = await new UsDatasetRegularSeedStore(f.db)
              .initialize(context, { startIndex: 0, count: 3 })
              .catch((cause: unknown) => cause);
            const attempts = await f.pool.query<{ attempts: number }>(
              "SELECT last_value::int AS attempts FROM task1_regular_attempts",
            );
            return { error, attempts: attempts.rows };
          });
          setupMs = performance.now() - started;
        }),
      30000,
    );

    // An outer retry, range transaction, continuation after failure, or SQL wrapper breaks this.
    it(
      "stops chain 1 Shipping once, preserves chain 0, and resumes only on explicit caller retry",
      async () =>
        runDatasetCasesFixtureBody(async () => {
          const started = performance.now();
          const journal = new UsDatasetJournalStore(f.db, usSixMonthDefinition);
          const seed = new UsDatasetRegularSeedStore(f.db);
          const { error, attempts } = failure;
          expect(error).toMatchObject({
            name: "Error",
            cause: { code: "40001", message: "task1_regular_original_sql" },
            stage: "shipping",
            unitKey: "chain_0001",
          });
          expect(attempts).toEqual([{ attempts: 1 }]);
          const header = await journal.read(context);
          if (!header) throw new Error("Missing header after failed range");
          const firstStages = await f.pool.query(
            "SELECT to_jsonb(t) AS body FROM traceability_demo_dataset_stages t WHERE tenant_id=$1 AND unit_key='chain_0000' ORDER BY stage",
            [context.tenantId],
          );
          expect(firstStages.rows).toHaveLength(4);
          const first = await new UsDatasetShippingSeedStore(f.db).verify(context, 0);
          expect(first.shipments).toHaveLength(2);
          const firstAudit = await f.pool.query(
            "SELECT to_jsonb(t) AS body FROM tenant_audit_events t WHERE organization_id=$1 AND request_id=ANY($2::text[]) ORDER BY id",
            [context.tenantId, first.shipments.map((row) => row.requestId)],
          );
          expect(firstAudit.rows).toHaveLength(8);
          expect(
            await journal.readStage(context, header.id, "chain_0001", "shipping"),
          ).toMatchObject({ revision: 1, receipt: null });
          expect(await journal.readStage(context, header.id, "chain_0002", "receiving")).toBeNull();
          expect(
            (
              await f.pool.query(
                "SELECT count(*)::int AS count FROM shipping_event_roots WHERE tenant_id=$1",
                [context.tenantId],
              )
            ).rows,
          ).toEqual([{ count: 2 }]);
          const before = await f.snapshot();
          await seed.verify(context, { startIndex: 0, count: 1 });
          expect(await f.snapshot()).toEqual(before);
          console.info("Task1 stopped SQL range", {
            attempts: 1,
            tables: Object.keys(before).length,
            hash: canonicalExportDigest(before),
            chain0StagesHash: canonicalExportDigest(firstStages.rows),
            chain0AuditHash: canonicalExportDigest(firstAudit.rows),
          });
          // Setup cleanup removed all exact owned failpoint objects before caller resume.
          const resumed = await seed.initialize(context, { startIndex: 0, count: 3 });
          expect(
            resumed.chains.map(({ index, shipmentCount }) => ({ index, shipmentCount })),
          ).toEqual([
            { index: 0, shipmentCount: 2 },
            { index: 1, shipmentCount: 2 },
            { index: 2, shipmentCount: 2 },
          ]);
          expect(await new UsDatasetShippingSeedStore(f.db).verify(context, 0)).toEqual(first);
          expect(
            (
              await f.pool.query(
                "SELECT to_jsonb(t) AS body FROM traceability_demo_dataset_stages t WHERE tenant_id=$1 AND unit_key='chain_0000' ORDER BY stage",
                [context.tenantId],
              )
            ).rows,
          ).toEqual(firstStages.rows);
          expect(
            (
              await f.pool.query(
                "SELECT to_jsonb(t) AS body FROM tenant_audit_events t WHERE organization_id=$1 AND request_id=ANY($2::text[]) ORDER BY id",
                [context.tenantId, first.shipments.map((row) => row.requestId)],
              )
            ).rows,
          ).toEqual(firstAudit.rows);
          const resumedBefore = await f.snapshot();
          expect(await seed.verify(context, { startIndex: 0, count: 3 })).toEqual(resumed);
          expect(await f.snapshot()).toEqual(resumedBefore);
          console.info("Task1 explicit SQL resume", {
            tables: Object.keys(resumedBefore).length,
            hash: canonicalExportDigest(resumedBefore),
            setupMs: Math.round(setupMs),
            bodyMs: Math.round(performance.now() - started),
            setupBudgetMs: 30000,
            bodyBudgetMs: 30000,
          });
        }),
      30000,
    );
  });

  it(
    "current chain 1 Receiving drift stops before Transformation or chain 2 without writes",
    async () =>
      runDatasetCasesFixtureBody(async () => {
        const seed = new UsDatasetRegularSeedStore(f.db);
        await seed.initialize(context, { startIndex: 0, count: 1 });
        const receiving = await new UsDatasetReceivingSeedStore(f.db).initialize(context, 1);
        const changed = await f.pool.query(
          "UPDATE tenant_audit_events SET after='{}'::jsonb WHERE organization_id=$1 AND target_id=$2 AND action='traceability.receiving.finalized'",
          [context.tenantId, receiving.created.eventId],
        );
        expect(changed.rowCount).toBe(1);
        const before = await f.snapshot();
        await expect(seed.initialize(context, { startIndex: 0, count: 3 })).rejects.toMatchObject({
          message: "us_dataset_receiving_mismatch",
          unitKey: "chain_0001",
          stage: "receiving",
        });
        expect(await f.snapshot()).toEqual(before);
        const journal = new UsDatasetJournalStore(f.db, usSixMonthDefinition);
        const header = await journal.read(context);
        if (!header) throw new Error("Missing prepared header");
        expect(
          await journal.readStage(context, header.id, "chain_0001", "transformation"),
        ).toBeNull();
        expect(await journal.readStage(context, header.id, "chain_0002", "receiving")).toBeNull();
        console.info("Task1 canonical Receiving drift no-write", {
          tables: Object.keys(before).length,
          hash: canonicalExportDigest(before),
        });
      }),
    30000,
  );

  it(
    "drains both concurrent equal native ranges and installs one result",
    async () =>
      runDatasetCasesFixtureBody(async () => {
        const seed = new UsDatasetRegularSeedStore(f.db);
        const range = { startIndex: 0, count: 1 };
        const settled = await Promise.allSettled([
          seed.initialize(context, range),
          seed.initialize(context, range),
        ]);
        expect(settled.map(({ status }) => status)).toEqual(["fulfilled", "fulfilled"]);
        const results = settled.map((row) => {
          if (row.status === "rejected") throw row.reason;
          return row.value;
        });
        expect(results[0]).toEqual(results[1]);
        const installed = await f.pool.query(
          "SELECT stage,revision FROM traceability_demo_dataset_stages WHERE tenant_id=$1 ORDER BY unit_key,stage",
          [context.tenantId],
        );
        expect(installed.rows).toEqual([
          { stage: "cases", revision: 2 },
          { stage: "receiving", revision: 2 },
          { stage: "shipping", revision: 2 },
          { stage: "transformation", revision: 2 },
          { stage: "references", revision: 2 },
        ]);
        const journal = new UsDatasetJournalStore(f.db, usSixMonthDefinition);
        const header = await journal.read(context);
        if (!header) throw new Error("Missing concurrently installed header");
        const shipping = await journal.readStage(context, header.id, "chain_0000", "shipping");
        const actual = parseUsDatasetShippingResult(shipping?.receipt?.result);
        expect(actual.shipments).toHaveLength(2);
        const before = await f.snapshot();
        expect(await seed.verify(context, range)).toEqual(results[0]);
        expect(await f.snapshot()).toEqual(before);
        console.info("Task1 concurrent ranges drained", {
          workers: settled.length,
          rejected: settled.filter((row) => row.status === "rejected").length,
          tables: Object.keys(before).length,
          hash: canonicalExportDigest(before),
        });
      }),
    30000,
  );
});
