import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createUsDatasetJournalFixture } from "./support/us-dataset-journal-fixture";
import {
  prepareDatasetShippingFixture,
  type UsDatasetJournalFixture,
  type UsDatasetShippingFixturePrepared,
} from "./support/us-dataset-shipping-fixture";
import { runDatasetCasesFixtureBody } from "./support/us-dataset-cases-fixture";
import { datasetTransformationStores } from "./support/us-dataset-transformation-fixture";
import { UsDatasetShippingSeedStore } from "../src/modules/traceability/demo/us-dataset-shipping-seed";
import {
  driverCode,
  outcome,
  ownClient,
  waitBlocked,
  withOwnedWork,
} from "./support/us-transformation-lock-fixture";
import { UsDatasetTransformationSeedStore } from "../src/modules/traceability/demo/us-dataset-transformation-seed";
import { UsDatasetCasesSeedStore } from "../src/modules/traceability/demo/us-dataset-cases-seed";
import { UsDatasetReferenceSeedStore } from "../src/modules/traceability/demo/us-dataset-reference-seed";
import { UsDatasetReceivingSeedStore } from "../src/modules/traceability/demo/us-dataset-receiving-seed";
import { canonicalExportDigest } from "@markiro/domain";
import type { UsDatasetContext } from "../src/modules/traceability/demo/us-dataset-contract";

const base = process.env.US_TEST_DATABASE_URL;
async function settleInitializers<T>(pending: readonly Promise<T>[]): Promise<T[]> {
  let primary: { error: unknown } | undefined;
  const results = await Promise.allSettled(
    pending.map(async (operation) => {
      try {
        return await operation;
      } catch (error) {
        primary ??= { error };
        throw error;
      }
    }),
  );
  if (primary) throw primary.error;
  return results.map((result) => {
    if (result.status === "rejected") throw result.reason;
    return result.value;
  });
}
describe.skipIf(!base)("Atomic dataset Shipping", () => {
  let f: UsDatasetJournalFixture;
  beforeAll(async () => {
    if (!base) throw new Error("Missing isolated US URL");
    f = await createUsDatasetJournalFixture(base);
  }, 60000);
  afterAll(async () => {
    await f?.close();
  });
  // Removing native finalization or publishing a pending receipt must fail this consumer test.
  it("initializes two real finalized shipments and completed revision2", async () =>
    runDatasetCasesFixtureBody(async () => {
      const context = await f.provision();
      const prepared = await prepareDatasetShippingFixture(f, context, 0);
      const result = await new UsDatasetShippingSeedStore(f.db).initialize(context, 0);
      expect(result.shipments.map((row) => row.finalized.status)).toEqual([
        "finalized",
        "finalized",
      ]);
      expect(result.shipments.map((row) => row.finalized.snapshot.items[0]?.quantity)).toEqual([
        "22",
        "23",
      ]);
      expect(
        await datasetTransformationStores(f.db).journal.readStage(
          context,
          prepared.datasetId,
          prepared.intent.unitKey,
          "shipping",
        ),
      ).toMatchObject({ revision: 2, receipt: { result } });
      const audits = await f.pool.query<{ action: string }>(
        "SELECT action FROM tenant_audit_events WHERE organization_id=$1 AND request_id LIKE 'dataset-shipping:%' ORDER BY action",
        [context.tenantId],
      );
      expect(audits.rows.map((row) => row.action)).toEqual([
        "traceability.reference_document.created",
        "traceability.reference_document.created",
        "traceability.reference_document.created",
        "traceability.reference_document.created",
        "traceability.shipping.draft_created",
        "traceability.shipping.draft_created",
        "traceability.shipping.finalized",
        "traceability.shipping.finalized",
      ]);
    }));
  it.each([
    [0, ["22", "23"], "55", "45", "10", "active", 1],
    [1, ["26", "39"], "65", "65", "0", "shipped", 2],
    [258, ["60"], "60", "60", "0", "shipped", 2],
    [259, ["100"], "100", "100", "0", "shipped", 2],
  ] as const)(
    "executes chain %i and exact no-write initialize/verify/upstream replay",
    async (index, quantities, supply, used, remaining, status, revision) =>
      runDatasetCasesFixtureBody(async () => {
        const context = await f.provision();
        await prepareDatasetShippingFixture(f, context, index);
        const seed = new UsDatasetShippingSeedStore(f.db);
        const result = await seed.initialize(context, index);
        expect(result.shipments.map((row) => row.finalized.snapshot.items[0]?.quantity)).toEqual(
          quantities,
        );
        expect(result.outputLotAfter).toMatchObject({ status, revision });
        const { UsShippingStore } =
          await import("../src/modules/traceability/shipping/us-shipping-draft");
        expect(
          await new UsShippingStore(f.db).getLotShippingBalance(
            context.tenantId,
            context.actorUserId,
            result.input.outputLotId,
            {},
          ),
        ).toMatchObject({ balance: { supply, used, remaining } });
        const before = await f.snapshot();
        expect(await seed.initialize(context, index)).toEqual(result);
        expect(await seed.verify(context, index)).toEqual(result);
        await new UsDatasetTransformationSeedStore(f.db).verify(context, index);
        await new UsDatasetCasesSeedStore(f.db).verify(context, index);
        expect(await f.snapshot()).toEqual(before);
        console.info("Task3 no-write whole-public-table proof", {
          index,
          tables: Object.keys(before).length,
          hash: canonicalExportDigest(before),
          resultDigest: canonicalExportDigest(result),
        });
      }),
    30000,
  );
  describe("concurrent initialization with absent Shipping intent", () => {
    let context: UsDatasetContext;
    let headerId: string;
    let setupMs = 0;
    beforeEach(async () =>
      runDatasetCasesFixtureBody(async () => {
        const started = performance.now();
        context = await f.provision();
        await new UsDatasetReferenceSeedStore(f.db).initialize(context);
        await new UsDatasetReceivingSeedStore(f.db).initialize(context, 0);
        await new UsDatasetTransformationSeedStore(f.db).initialize(context, 0);
        await new UsDatasetCasesSeedStore(f.db).initialize(context, 0);
        const header = await datasetTransformationStores(f.db).journal.read(context);
        if (!header) throw new Error("Missing fixture header");
        headerId = header.id;
        setupMs = performance.now() - started;
      }),
    );
    it("concurrent same-input initializers converge on one native result", async () =>
      runDatasetCasesFixtureBody(async () => {
        const started = performance.now();
        expect(
          await datasetTransformationStores(f.db).journal.readStage(
            context,
            headerId,
            "chain_0000",
            "shipping",
          ),
        ).toBeNull();
        const seed = new UsDatasetShippingSeedStore(f.db);
        const results = await settleInitializers([
          seed.initialize(context, 0),
          seed.initialize(context, 0),
        ]);
        expect(results[0]).toEqual(results[1]);
        expect(results[0]?.shipments).toHaveLength(2);
        expect(
          await datasetTransformationStores(f.db).journal.readStage(
            context,
            headerId,
            "chain_0000",
            "shipping",
          ),
        ).toMatchObject({ revision: 2 });
        console.info("Task3 concurrency registered setup/body boundary", {
          setupMs: Math.round(setupMs),
          bodyMs: Math.round(performance.now() - started),
          bodyBudgetMs: 5000,
        });
      }));
  });
  it("drains a surviving actual operation before rethrowing the first SQL failure", async () =>
    runDatasetCasesFixtureBody(async () =>
      withOwnedWork(async (own) => {
        const failed = await f.pool.connect();
        ownClient(own, failed, "failed operation client", () => failed.query("ROLLBACK"));
        const survivor = await f.pool.connect();
        ownClient(own, survivor, "surviving operation client", () => survivor.query("ROLLBACK"));
        const workers: {
          failed?: ReturnType<typeof outcome>;
          survivor?: ReturnType<typeof outcome>;
          aggregate?: ReturnType<typeof outcome>;
        } = {};
        own("drain both actual operations", async () => {
          await Promise.all([workers.failed, workers.survivor, workers.aggregate]);
        });
        const gate = await f.pool.connect();
        ownClient(own, gate, "release gate before actual operation drain", () =>
          gate.query("ROLLBACK"),
        );
        const gatePid = (await gate.query<{ pid: number }>("SELECT pg_backend_pid() AS pid"))
          .rows[0]?.pid;
        const survivorPid = (
          await survivor.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")
        ).rows[0]?.pid;
        if (!gatePid || !survivorPid) throw new Error("Missing owned operation PIDs");
        await gate.query("BEGIN");
        await gate.query("SELECT pg_advisory_xact_lock(732019, 3)");
        const first = failed.query("SELECT * FROM task3_owned_absent_relation");
        const second = survivor.query("SELECT pg_advisory_xact_lock(732019, 3)");
        workers.failed = outcome(first);
        workers.survivor = outcome(second);
        let settled = false;
        workers.aggregate = outcome(settleInitializers([first, second])).then((result) => {
          settled = true;
          return result;
        });
        const primary = (await workers.failed).error;
        expect(driverCode(primary)).toBe("42P01");
        await waitBlocked(f, gatePid, survivorPid, new AbortController().signal);
        expect(settled).toBe(false);
        await gate.query("ROLLBACK");
        expect((await workers.survivor).error).toBeUndefined();
        expect((await workers.aggregate).error).toBe(primary);
      }),
    ));
  describe("prepared private native transactions", () => {
    let context: UsDatasetContext;
    let prepared: UsDatasetShippingFixturePrepared;
    let setupMs = 0;
    beforeEach(async () =>
      runDatasetCasesFixtureBody(async () => {
        const started = performance.now();
        context = await f.provision();
        prepared = await prepareDatasetShippingFixture(f, context, 0);
        setupMs = performance.now() - started;
      }),
    );
    it.each(["first", "second", "audit", "receipt"] as const)(
      "rolls back all native writes after %s failure and succeeds on fresh caller retry",
      async (point) =>
        runDatasetCasesFixtureBody(async () => {
          const started = performance.now();
          const table =
            point === "receipt"
              ? "traceability_demo_dataset_stages"
              : point === "audit"
                ? "tenant_audit_events"
                : "shipping_operations";
          const condition =
            point === "receipt"
              ? "NEW.stage='shipping' AND NEW.receipt IS NOT NULL"
              : point === "audit"
                ? "NEW.action='traceability.shipping.finalized' AND NEW.request_id LIKE '%:2'"
                : `NEW.command='shipping.finalize' AND (SELECT count(*) FROM shipping_operations WHERE command='shipping.finalize')=${point === "first" ? 1 : 2}`;
          await f.pool.query(
            `CREATE FUNCTION task3_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF ${condition} THEN RAISE EXCEPTION 'task3_owned_failure' USING ERRCODE='P0001'; END IF; RETURN NEW; END $$`,
          );
          await f.pool.query(
            `CREATE TRIGGER task3_fail AFTER ${point === "receipt" ? "UPDATE" : "INSERT"} ON ${table} FOR EACH ROW EXECUTE FUNCTION task3_fail()`,
          );
          const before = await f.snapshot();
          const error = await new UsDatasetShippingSeedStore(f.db)
            .initialize(context, 0)
            .catch((cause: unknown) => cause);
          expect(driverCode(error)).toBe("P0001");
          expect(error).toMatchObject({ stage: "shipping", unitKey: prepared.intent.unitKey });
          expect(await f.snapshot()).toEqual(before);
          console.info("Task3 rollback whole-public-table proof", {
            point,
            tables: Object.keys(before).length,
            hash: canonicalExportDigest(before),
            code: driverCode(error),
            revision: 1,
          });
          expect(
            await datasetTransformationStores(f.db).journal.readStage(
              context,
              prepared.datasetId,
              prepared.intent.unitKey,
              "shipping",
            ),
          ).toMatchObject({ revision: 1, receipt: null, intent: prepared.intent });
          await f.pool.query(`DROP TRIGGER task3_fail ON ${table}`);
          await f.pool.query("DROP FUNCTION task3_fail()");
          expect(
            (await new UsDatasetShippingSeedStore(f.db).initialize(context, 0)).shipments,
          ).toHaveLength(2);
          if (point === "receipt")
            console.info("Task3 measured real fixture versus assertion body", {
              group: "receipt rollback and retry",
              setupMs: Math.round(setupMs),
              bodyMs: Math.round(performance.now() - started),
              bodyBudgetMs: 5000,
            });
        }),
    );
    it("retains the native serialization failure cause and makes one attempt before caller retry", async () =>
      runDatasetCasesFixtureBody(async () => {
        await f.pool.query("CREATE SEQUENCE task3_attempts");
        await f.pool.query(
          "CREATE FUNCTION task3_serialization() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.command='shipping.finalize' THEN PERFORM nextval('task3_attempts'); RAISE EXCEPTION 'task3_original_serialization' USING ERRCODE='40001'; END IF; RETURN NEW; END $$",
        );
        await f.pool.query(
          "CREATE TRIGGER task3_serialization AFTER INSERT ON shipping_operations FOR EACH ROW EXECUTE FUNCTION task3_serialization()",
        );
        const before = await f.snapshot();
        const error = await new UsDatasetShippingSeedStore(f.db)
          .initialize(context, 0)
          .catch((cause: unknown) => cause);
        expect(error).toMatchObject({
          name: "Error",
          cause: { code: "40001", message: "task3_original_serialization" },
          stage: "shipping",
          unitKey: prepared.intent.unitKey,
        });
        expect(
          (await f.pool.query("SELECT last_value::int AS attempts FROM task3_attempts")).rows[0]
            ?.attempts,
        ).toBe(1);
        expect(await f.snapshot()).toEqual(before);
        await f.pool.query("DROP TRIGGER task3_serialization ON shipping_operations");
        await f.pool.query("DROP FUNCTION task3_serialization()");
        await f.pool.query("DROP SEQUENCE task3_attempts");
        expect(
          (await new UsDatasetShippingSeedStore(f.db).initialize(context, 0)).shipments,
        ).toHaveLength(2);
      }));
    it("rejects a well-formed substituted native finalize digest before receipt publication", async () =>
      runDatasetCasesFixtureBody(async () => {
        await f.pool.query(
          "CREATE FUNCTION task3_digest() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.command='shipping.finalize' THEN NEW.input_digest=repeat('a',64); END IF; RETURN NEW; END $$",
        );
        await f.pool.query(
          "CREATE TRIGGER task3_digest BEFORE INSERT ON shipping_operations FOR EACH ROW EXECUTE FUNCTION task3_digest()",
        );
        const before = await f.snapshot();
        await expect(new UsDatasetShippingSeedStore(f.db).initialize(context, 0)).rejects.toThrow(
          "us_dataset_shipping_mismatch",
        );
        expect(await f.snapshot()).toEqual(before);
        await f.pool.query("DROP TRIGGER task3_digest ON shipping_operations");
        await f.pool.query("DROP FUNCTION task3_digest()");
        expect(
          (await new UsDatasetShippingSeedStore(f.db).initialize(context, 0)).shipments,
        ).toHaveLength(2);
      }));
  });
});
