import { randomUUID } from "node:crypto";
import { createDb } from "@markiro/db";
import { canonicalExportDigest } from "@markiro/domain";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { UsDatasetCasesSeedStore } from "../src/modules/traceability/demo/us-dataset-cases-seed";
import { UsDatasetReferenceSeedStore } from "../src/modules/traceability/demo/us-dataset-reference-seed";
import { UsDatasetReceivingSeedStore } from "../src/modules/traceability/demo/us-dataset-receiving-seed";
import { UsDatasetTransformationSeedStore } from "../src/modules/traceability/demo/us-dataset-transformation-seed";
import { UsDatasetJournalStore } from "../src/modules/traceability/demo/us-dataset-journal";
import {
  parseUsDatasetCasesInput,
  caseDemoAuditIdentity,
  caseDemoCommandDigest,
} from "../src/modules/traceability/demo/us-dataset-cases-contract";
import { parseUsDatasetTransformationResult } from "../src/modules/traceability/demo/us-dataset-transformation-contract";
import { parseUsDatasetReferenceResult } from "../src/modules/traceability/demo/us-dataset-reference-contract";
import { UsCaseStore } from "../src/modules/traceability/cases/us-case-store";
import { UsShippingStore } from "../src/modules/traceability/shipping/us-shipping-draft";
import { UsTraceStore } from "../src/modules/traceability/trace/us-trace-store";
import { lockCaseOperation } from "../src/modules/traceability/cases/us-case-operations";
import { createUsDatasetJournalFixture } from "./support/us-dataset-journal-fixture";
import {
  prepareDatasetCasesFixture,
  runDatasetCasesFixtureBody,
} from "./support/us-dataset-cases-fixture";
import { datasetTransformationStores } from "./support/us-dataset-transformation-fixture";
import {
  abortable,
  barrier,
  outcome,
  ownClient,
  startObservation,
  waitBlocked,
  withOwnedWork,
  type OwnCleanup,
} from "./support/us-transformation-lock-fixture";

const base = process.env.US_TEST_DATABASE_URL;
describe.skipIf(!base)("Dataset Cases durable executor", () => {
  let f: Awaited<ReturnType<typeof createUsDatasetJournalFixture>>;
  beforeAll(async () => {
    if (!base) throw new Error("Missing isolated US database");
    f = await createUsDatasetJournalFixture(base);
  }, 60000);
  afterAll(async () => {
    await f?.close();
  });
  type Context = Awaited<ReturnType<typeof f.provision>>;
  const stores = () => datasetTransformationStores(f.db);
  const seed = () => new UsDatasetCasesSeedStore(f.db);
  async function prerequisites(context: Context, index = 0) {
    await new UsDatasetReferenceSeedStore(f.db).initialize(context);
    await new UsDatasetReceivingSeedStore(f.db).initialize(context, index);
    const transformation = await new UsDatasetTransformationSeedStore(f.db).initialize(
      context,
      index,
    );
    const header = await stores().journal.read(context);
    if (!header) throw new Error("Missing installed dataset");
    return { header, transformation };
  }
  function connections(own: OwnCleanup) {
    if (!base) throw new Error("Missing isolated US database");
    const url = new URL(base);
    url.pathname = "/" + f.databaseName;
    const take = (name: string) => {
      const pool = createDb(url.toString(), {
        max: 1,
        connectionTimeoutMillis: 5000,
        statement_timeout: 8000,
      });
      own(name, () => pool.pool.end());
      return pool;
    };
    return { first: take("first pool"), second: take("second pool"), gate: take("gate pool") };
  }
  async function pid(pool: ReturnType<typeof createDb>) {
    const value = (await pool.pool.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]
      ?.pid;
    if (!value) throw new Error("Missing owned PID");
    return value;
  }

  // A missing native application or a recipe-index substitution must fail these literals.
  it.each([
    [0, 55],
    [130, 50],
    [259, 100],
  ])("applies and replays actual chain %i", async (index, count) =>
    runDatasetCasesFixtureBody(async () => {
      const context = await f.provision();
      const captured = await prepareDatasetCasesFixture(f, context, index);
      const seed = new UsDatasetCasesSeedStore(f.db);
      const result = await seed.initialize(context, index);
      expect(result.linked.created).toHaveLength(count);
      expect(result.linked.unchanged).toEqual([]);
      expect(result.input).toEqual(captured.input);
      expect(result.operationKey).toBe(captured.intent.operationKey);
      expect(result.requestId).toBe(`dataset-cases:${captured.intent.operationKey}`);
      const transformation = await stores().journal.readStage(
        context,
        captured.datasetId,
        captured.intent.unitKey,
        "transformation",
      );
      if (!transformation?.receipt) throw new Error("Missing Transformation receipt");
      const origin = parseUsDatasetTransformationResult(transformation.receipt.result);
      expect(
        origin.finalized.snapshot.inputs.map(({ quantity, unitOfMeasure }) => ({
          quantity,
          unitOfMeasure,
        })),
      ).toEqual(
        index === 0
          ? [
              { quantity: "300", unitOfMeasure: "lb" },
              { quantity: "400", unitOfMeasure: "lb" },
            ]
          : index === 130
            ? [
                { quantity: "400", unitOfMeasure: "lb" },
                { quantity: "500", unitOfMeasure: "lb" },
              ]
            : [
                { quantity: "500", unitOfMeasure: "lb" },
                { quantity: "500", unitOfMeasure: "lb" },
              ],
      );
      expect(
        origin.finalized.snapshot.outputs.map(({ quantity, unitOfMeasure }) => ({
          quantity,
          unitOfMeasure,
        })),
      ).toEqual([
        { quantity: index === 0 ? "55" : index === 130 ? "50" : "100", unitOfMeasure: "case" },
      ]);
      expect(origin.finalized.snapshot.eventDate).toBe(
        index === 0 ? "2026-04-02" : index === 130 ? "2026-07-10" : "2026-09-15",
      );
      expect(
        (
          await f.pool.query(
            "SELECT command,operation_key,input_digest,target_id,result FROM trace_lot_box_operations WHERE tenant_id=$1",
            [context.tenantId],
          )
        ).rows,
      ).toEqual([
        {
          command: "case.link",
          operation_key: captured.intent.operationKey,
          input_digest: caseDemoCommandDigest(result.input),
          target_id: result.input.outputLotId,
          result: result.linked,
        },
      ]);
      expect(
        (
          await f.pool.query(
            "SELECT organization_id,actor_user_id,action,outcome,target_type,target_id,before,after,request_id FROM tenant_audit_events WHERE organization_id=$1 AND action='case.link'",
            [context.tenantId],
          )
        ).rows,
      ).toEqual([
        {
          organization_id: context.tenantId,
          actor_user_id: context.actorUserId,
          action: "case.link",
          outcome: "success",
          target_type: "traceability_lot",
          target_id: result.input.outputLotId,
          before: { links: [] },
          after: {
            tenantId: context.tenantId,
            operationKey: captured.intent.operationKey,
            lotId: result.input.outputLotId,
            source: "demo_seed",
            result: result.linked,
            seed: caseDemoAuditIdentity(result.input),
          },
          request_id: result.requestId,
        },
      ]);
      expect(
        (
          await f.pool.query(
            "SELECT count(*)::int AS n FROM box_items UNION ALL SELECT count(*)::int FROM scan_events UNION ALL SELECT count(*)::int FROM shift_number_counters UNION ALL SELECT count(*)::int FROM sscc_counters",
          )
        ).rows,
      ).toEqual([{ n: 0 }, { n: 0 }, { n: 0 }, { n: 0 }]);
      const before = await f.snapshot();
      expect(await seed.initialize(context, index)).toEqual(result);
      expect(await seed.verify(context, index)).toEqual(result);
      expect(await f.snapshot()).toEqual(before);
    }),
  );

  it.each([
    "dataset",
    "references",
    "pending references",
    "receiving",
    "pending receiving",
    "transformation",
    "pending transformation",
  ])("refuses missing %s without implicit installation", async (kind) =>
    runDatasetCasesFixtureBody(async () => {
      const context = await f.provision();
      if (kind !== "dataset") {
        const journal = stores().journal;
        const header = await journal.initialize(context);
        if (!["references", "pending references"].includes(kind))
          await new UsDatasetReferenceSeedStore(f.db).initialize(context);
        if (["transformation", "pending transformation"].includes(kind))
          await new UsDatasetReceivingSeedStore(f.db).initialize(context, 0);
        if (kind.startsWith("pending")) {
          const stage =
            kind === "pending references"
              ? "references"
              : kind === "pending receiving"
                ? "receiving"
                : "transformation";
          await journal.captureIntent(context, header.id, {
            unitKey: stage === "references" ? "references" : "chain_0000",
            stage,
            operationKey: randomUUID(),
            input: {},
            inputDigest: canonicalExportDigest({}),
          });
        }
      }
      const before = await f.snapshot();
      await expect(seed().initialize(context, 0)).rejects.toThrow(
        "us_dataset_cases_prerequisite_incomplete",
      );
      await expect(seed().verify(context, 0)).rejects.toThrow(
        "us_dataset_cases_prerequisite_incomplete",
      );
      expect(await f.snapshot()).toEqual(before);
    }),
  );

  it.each([-1, 260, 1.5, NaN, Infinity])("refuses invalid index %s before capture", async (index) =>
    runDatasetCasesFixtureBody(async () => {
      const context = await f.provision();
      await stores().journal.initialize(context);
      const before = await f.snapshot();
      await expect(seed().initialize(context, index)).rejects.toThrow(
        "us_dataset_cases_input_invalid",
      );
      await expect(seed().verify(context, index)).rejects.toThrow("us_dataset_cases_input_invalid");
      expect(await f.snapshot()).toEqual(before);
    }),
  );

  it.each(["actor", "tenant", "database", "user", "role", "provenance", "owner", "timezone"])(
    "reauthorizes %s before invalid index",
    async (kind) =>
      runDatasetCasesFixtureBody(async () => {
        const context = await f.provision();
        await prepareDatasetCasesFixture(f, context, 0);
        const target = {
          ...context,
          ...(kind === "actor"
            ? { actorUserId: randomUUID() }
            : kind === "tenant"
              ? { tenantId: randomUUID() }
              : kind === "database"
                ? { expectedDatabaseName: "markiro_us_dev" }
                : {}),
        };
        if (kind === "role")
          await f.pool.query("UPDATE member SET role='viewer' WHERE user_id=$1", [
            context.actorUserId,
          ]);
        if (kind === "provenance")
          await f.pool.query("UPDATE organization SET metadata='{}' WHERE id=$1", [
            context.tenantId,
          ]);
        if (kind === "owner")
          await f.pool.query("UPDATE \"user\" SET name='Changed owner' WHERE id=$1", [
            context.actorUserId,
          ]);
        if (kind === "timezone")
          await f.pool.query("UPDATE org_profiles SET time_zone='UTC' WHERE tenant_id=$1", [
            context.tenantId,
          ]);
        const db = kind === "user" ? await f.alternateRole() : f.db;
        const before = await f.snapshot();
        await expect(new UsDatasetCasesSeedStore(db).initialize(target, NaN)).rejects.toThrow(
          "us_dataset_target_invalid",
        );
        await expect(new UsDatasetCasesSeedStore(db).verify(target, NaN)).rejects.toThrow(
          "us_dataset_target_invalid",
        );
        expect(await f.snapshot()).toEqual(before);
      }),
  );

  it.each(["absent", "pending"])("verify makes zero writes for %s Cases", async (kind) =>
    runDatasetCasesFixtureBody(async () => {
      const context = await f.provision();
      if (kind === "pending") await prepareDatasetCasesFixture(f, context, 0);
      else await prerequisites(context);
      const before = await f.snapshot();
      await expect(seed().verify(context, 0)).rejects.toThrow(
        "us_dataset_cases_prerequisite_incomplete",
      );
      expect(await f.snapshot()).toEqual(before);
    }),
  );

  it.for([
    ["support", "shifts", "INSERT", "true"],
    ["box", "boxes", "INSERT", "true"],
    ["marker", "traceability_synthetic_case_origins", "INSERT", "true"],
    ["link", "trace_lot_boxes", "INSERT", "true"],
    [
      "dependency",
      "traceability_lots",
      "UPDATE",
      "NEW.current_dependency_version<>OLD.current_dependency_version",
    ],
    ["audit", "tenant_audit_events", "INSERT", "NEW.action='case.link'"],
    ["operation", "trace_lot_box_operations", "INSERT", "true"],
    ["verifier", "tenant_audit_events", "INSERT", "NEW.action='case.link'"],
    ["receipt", "traceability_demo_dataset_stages", "UPDATE", "NEW.stage='cases'"],
    ["40001", "trace_lot_box_operations", "INSERT", "true"],
    ["40P01", "trace_lot_box_operations", "INSERT", "true"],
  ])(
    "rolls back all persisted tables at %s and reuses exact intent on explicit retry",
    async ([name, table, action, condition], test) =>
      runDatasetCasesFixtureBody(async () => {
        const context = await f.provision(),
          captured = await prepareDatasetCasesFixture(f, context, 0);
        const pending = await stores().journal.readStage(
          context,
          captured.datasetId,
          captured.intent.unitKey,
          "cases",
        );
        const code = name === "40001" || name === "40P01" ? name : "P0001";
        let originalFailure: unknown;
        const original = UsCaseStore.prototype.linkDemoInTransaction;
        const spy = vi
          .spyOn(UsCaseStore.prototype, "linkDemoInTransaction")
          .mockImplementation(async function (this: UsCaseStore, ...args) {
            try {
              return await original.apply(this, args);
            } catch (error) {
              originalFailure = error;
              throw error;
            }
          });
        test.onTestFinished(() => spy.mockRestore());
        await withOwnedWork(async (own) => {
          // Private failpoint only: real native writes run with all immutable triggers active.
          await f.pool.query(
            `CREATE FUNCTION synthetic_cases_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF ${condition} THEN ${name === "verifier" ? "UPDATE shifts SET planned_qty=1;" : `RAISE EXCEPTION 'synthetic_cases_failure' USING ERRCODE='${code}';`} END IF; RETURN NEW; END $$`,
          );
          own("failpoint function", async () => {
            await f.pool.query("DROP FUNCTION synthetic_cases_failure()");
          });
          await f.pool.query(
            `CREATE TRIGGER synthetic_cases_failure ${name === "verifier" ? "AFTER" : "BEFORE"} ${action} ON ${table} FOR EACH ROW EXECUTE FUNCTION synthetic_cases_failure()`,
          );
          own("failpoint trigger", async () => {
            await f.pool.query(`DROP TRIGGER synthetic_cases_failure ON ${table}`);
          });
          const before = await f.snapshot();
          const running = outcome(seed().initialize(context, 0));
          own("worker drain", async () => {
            await running;
          });
          const response = await abortable(running, test.signal);
          if (name === "verifier")
            expect(response.error).toMatchObject({
              message: "us_dataset_cases_mismatch",
              unitKey: "chain_0000",
              stage: "cases",
            });
          else
            expect(response.error).toMatchObject({
              cause: { code },
              unitKey: "chain_0000",
              stage: "cases",
            });
          if (name === "40001" || name === "40P01") expect(response.error).toBe(originalFailure);
          expect(await f.snapshot()).toEqual(before);
          expect(spy).toHaveBeenCalledTimes(
            ["support", "box", "marker"].includes(name ?? "") ? 0 : 1,
          );
          expect(
            await stores().journal.readStage(
              context,
              captured.datasetId,
              captured.intent.unitKey,
              "cases",
            ),
          ).toEqual(pending);
        });
        spy.mockRestore();
        const result = await seed().initialize(context, 0);
        expect(result.operationKey).toBe(captured.intent.operationKey);
        expect(result.input.support).toEqual(captured.input.support);
      }),
  );

  it("reconciles a real committed receipt after acknowledgement loss", async (test) =>
    runDatasetCasesFixtureBody(async () => {
      const context = await f.provision(),
        installed = await prerequisites(context);
      const original = UsDatasetJournalStore.prototype.runAtomicStage;
      const spy = vi
        .spyOn(UsDatasetJournalStore.prototype, "runAtomicStage")
        .mockImplementation(async function (this: UsDatasetJournalStore, ...args) {
          await original.apply(this, args);
          throw new Error("lost committed Cases acknowledgement");
        });
      test.onTestFinished(() => spy.mockRestore());
      await expect(seed().initialize(context, 0)).rejects.toThrow(
        "lost committed Cases acknowledgement",
      );
      spy.mockRestore();
      const completed = await stores().journal.readStage(
        context,
        installed.header.id,
        "chain_0000",
        "cases",
      );
      if (!completed?.receipt) throw new Error("Missing actual committed Cases receipt");
      const before = await f.snapshot();
      expect(await seed().initialize(context, 0)).toEqual(completed.receipt.result);
      expect(await seed().verify(context, 0)).toEqual(completed.receipt.result);
      expect(await f.snapshot()).toEqual(before);
    }));

  it("uses a prior-month captured support descriptor without changing actual clocks", async () =>
    runDatasetCasesFixtureBody(async () => {
      const context = await f.provision(),
        captured = await prepareDatasetCasesFixture(f, context, 0);
      const support = {
        ...captured.input.support,
        capturedAt: "2026-09-30T23:59:59.999Z",
        numberMonthKey: "SEP26",
      };
      const input = parseUsDatasetCasesInput({ ...captured.input, support });
      // Journal descriptor mutation is allowed test corruption/construction; no business clock is mocked.
      await f.pool.query(
        "UPDATE traceability_demo_dataset_stages SET input=$1,input_digest=$2 WHERE stage='cases'",
        [input, canonicalExportDigest(input)],
      );
      const before = new Date().getTime();
      const result = await seed().initialize(context, 0);
      expect(result.input.support).toEqual(support);
      expect(result.operationKey).toBe(captured.intent.operationKey);
      expect(result.support.shift.numberMonthKey).toBe("SEP26");
      expect(new Date(result.support.shift.createdAt).getTime()).toBeGreaterThanOrEqual(before);
    }));

  it.each(["recipe", "dependency", "output"])(
    "refuses captured %s drift without replacement",
    async (kind) =>
      runDatasetCasesFixtureBody(async () => {
        const context = await f.provision(),
          captured = await prepareDatasetCasesFixture(f, context, 0);
        const input = {
          ...captured.input,
          ...(kind === "recipe"
            ? { definitionDigest: "a".repeat(64) }
            : kind === "dependency"
              ? {
                  transformation: {
                    ...captured.input.transformation,
                    resultDigest: "a".repeat(64),
                  },
                }
              : { outputLotId: randomUUID() }),
        };
        await f.pool.query(
          "UPDATE traceability_demo_dataset_stages SET input=$1,input_digest=$2 WHERE stage='cases'",
          [input, canonicalExportDigest(input)],
        );
        const before = await f.snapshot();
        await expect(seed().initialize(context, 0)).rejects.toThrow(
          "us_dataset_cases_dependency_conflict",
        );
        await expect(seed().verify(context, 0)).rejects.toThrow(
          "us_dataset_cases_dependency_conflict",
        );
        expect(await f.snapshot()).toEqual(before);
      }),
  );

  it.each(["manual", "demo"])(
    "never adopts a real pending %s operation under the captured key",
    async (mode) =>
      runDatasetCasesFixtureBody(async () => {
        const context = await f.provision(),
          captured = await prepareDatasetCasesFixture(f, context, 0);
        // The support helper is permitted native private persistence; the operation is real public service output.
        const { insertUsDatasetCasesSupport } =
          await import("../src/modules/traceability/demo/us-dataset-cases-support");
        await f.db.transaction((tx) => insertUsDatasetCasesSupport(tx, context, captured.input));
        const service = new UsCaseStore(f.db);
        if (mode === "demo")
          await f.db.transaction((tx) =>
            service.linkDemoInTransaction(
              tx,
              context,
              captured.datasetId,
              captured.intent.unitKey,
              "demo-before-pending",
            ),
          );
        else
          await service.link(
            context.tenantId,
            context.actorUserId,
            captured.input.outputLotId,
            {
              operationKey: captured.intent.operationKey,
              ssccs: captured.input.support.boxes.map((box) => box.sscc),
            },
            "manual-before-pending",
          );
        const before = await f.snapshot();
        await expect(seed().initialize(context, 0)).rejects.toThrow("us_dataset_cases_conflict");
        await expect(seed().verify(context, 0)).rejects.toThrow(
          "us_dataset_cases_prerequisite_incomplete",
        );
        expect(await f.snapshot()).toEqual(before);
      }),
  );

  it("capture losers use the winner support and key with one native application", async (test) =>
    runDatasetCasesFixtureBody(async () => {
      const context = await f.provision();
      await prerequisites(context);
      await withOwnedWork(async (own) => {
        const pools = connections(own),
          pids = await Promise.all([pid(pools.first), pid(pools.second)]);
        const release = barrier(),
          arrived = barrier();
        const original = UsDatasetJournalStore.prototype.captureIntent;
        const candidates: unknown[] = [];
        let conflicts = 0;
        const spy = vi
          .spyOn(UsDatasetJournalStore.prototype, "captureIntent")
          .mockImplementation(async function (this: UsDatasetJournalStore, ...args) {
            candidates.push(args[2]);
            if (candidates.length === 2) arrived.release();
            await abortable(release.promise, test.signal);
            try {
              return await original.apply(this, args);
            } catch (error) {
              if (error instanceof Error && error.message === "us_dataset_intent_conflict")
                conflicts++;
              throw error;
            }
          });
        own("capture spy", async () => spy.mockRestore());
        const native = vi.spyOn(UsCaseStore.prototype, "linkDemoInTransaction");
        own("native spy", async () => native.mockRestore());
        const workers = [pools.first, pools.second].map((pool) =>
          outcome(new UsDatasetCasesSeedStore(pool.db).initialize(context, 0)),
        );
        own("release then drain", async () => {
          release.release();
          await Promise.all(workers);
        });
        await abortable(arrived.promise, test.signal);
        expect(candidates).toHaveLength(2);
        expect(candidates[0]).not.toEqual(candidates[1]);
        release.release();
        const responses = await Promise.all(workers);
        for (const response of responses) expect(response.error).toBeUndefined();
        expect(responses[0]?.value).toEqual(responses[1]?.value);
        expect(conflicts).toBe(1);
        expect(native).toHaveBeenCalledTimes(1);
        const result = responses[0]?.value;
        if (!result) throw new Error("Missing capture winner result");
        expect(candidates).toContainEqual({
          unitKey: "chain_0000",
          stage: "cases",
          operationKey: result.operationKey,
          input: result.input,
          inputDigest: canonicalExportDigest(result.input),
        });
        console.info("Observed actual capture racer backend PIDs", pids);
        expect(
          (
            await f.pool.query(
              "SELECT (SELECT count(*)::int FROM shifts) AS shifts,(SELECT count(*)::int FROM boxes) AS boxes,(SELECT count(*)::int FROM trace_lot_boxes) AS links,(SELECT count(*)::int FROM trace_lot_box_operations) AS operations,(SELECT count(*)::int FROM traceability_demo_dataset_stages WHERE stage='cases' AND revision=2) AS receipts",
            )
          ).rows,
        ).toEqual([{ shifts: 1, boxes: 55, links: 55, operations: 1, receipts: 1 }]);
      });
    }));

  it("serializes simultaneous pending applications with a PID-observed winner and no duplicate writes", async (test) =>
    runDatasetCasesFixtureBody(async () => {
      const context = await f.provision(),
        captured = await prepareDatasetCasesFixture(f, context, 0);
      await withOwnedWork(async (own) => {
        const pools = connections(own),
          firstPid = await pid(pools.first),
          secondPid = await pid(pools.second);
        const held = barrier(),
          release = barrier();
        let applies = 0,
          pendingAtVerify = false;
        const original = UsDatasetJournalStore.prototype.runAtomicStage;
        const spy = vi
          .spyOn(UsDatasetJournalStore.prototype, "runAtomicStage")
          .mockImplementation(function (this: UsDatasetJournalStore, ...args) {
            const [checked, datasetId, revision, intent, work] = args;
            return original.call(this, checked, datasetId, revision, intent, {
              apply: async (...applyArgs) => {
                applies++;
                const receipt = await work.apply(...applyArgs);
                held.release();
                await abortable(release.promise, test.signal);
                return receipt;
              },
              verify: async (tx, value, saved, receipt) => {
                const row = await stores().journal.readStageInTransaction(
                  tx,
                  value,
                  datasetId,
                  saved.unitKey,
                  "cases",
                );
                if (row?.receipt === null) pendingAtVerify = true;
                await work.verify(tx, value, saved, receipt);
              },
            });
          });
        own("journal spy", async () => spy.mockRestore());
        const workers: ReturnType<typeof outcome>[] = [];
        own("release before worker drain", async () => {
          release.release();
          await Promise.all(workers);
        });
        workers.push(outcome(new UsDatasetCasesSeedStore(pools.first.db).initialize(context, 0)));
        await abortable(held.promise, test.signal);
        workers.push(outcome(new UsDatasetCasesSeedStore(pools.second.db).initialize(context, 0)));
        await waitBlocked(f, firstPid, secondPid, test.signal);
        release.release();
        const responses = await Promise.all(workers);
        for (const response of responses) expect(response.error).toBeUndefined();
        expect(responses[0]?.value).toEqual(responses[1]?.value);
        expect(applies).toBe(1);
        expect(pendingAtVerify).toBe(true);
        expect(responses[0]?.value).toMatchObject({
          operationKey: captured.intent.operationKey,
          input: captured.input,
        });
        const before = await f.snapshot();
        expect(await seed().verify(context, 0)).toEqual(responses[0]?.value);
        expect(await f.snapshot()).toEqual(before);
      });
    }));

  it("accepts later real Shipping and public synthetic reads without changing historical facts", async () =>
    runDatasetCasesFixtureBody(async () => {
      const context = await f.provision(),
        installed = await prerequisites(context);
      const original = await f.snapshot();
      const historical = (
        await f.pool.query(
          "SELECT to_jsonb(t) AS row FROM traceability_events t WHERE tenant_id=$1 ORDER BY id",
          [context.tenantId],
        )
      ).rows;
      const lotFacts = (
        await f.pool.query(
          "SELECT id,tlc,product_id,assignment_basis,source_location_id,source_reference_kind,source_reference_value,source_reference_location_id,source_locked_at,created_by,created_at FROM traceability_lots WHERE tenant_id=$1 ORDER BY id",
          [context.tenantId],
        )
      ).rows;
      const result = await seed().initialize(context, 0);
      const references = await stores().journal.readStage(
        context,
        installed.header.id,
        "references",
        "references",
      );
      if (!references?.receipt) throw new Error("Missing reference stage");
      const refs = parseUsDatasetReferenceResult(references.receipt.result);
      const shipping = new UsShippingStore(f.db);
      const document = await stores().documents.createDocument(
        context.tenantId,
        context.actorUserId,
        {
          type: "bol",
          typeOtherLabel: null,
          number: "SYNTHETIC-EXECUTOR-SHIP",
          issuedOn: "2026-09-30",
          partyId: null,
          notes: null,
        },
        "shipping-document",
      );
      const draft = await shipping.createDraft(
        context.tenantId,
        context.actorUserId,
        {
          operationKey: randomUUID(),
          draft: {
            eventDate: "2026-09-30",
            shipFromLocationId: refs.bindings.locations.find((row) => row.key === "processor")?.id,
            recipientLocationId: refs.bindings.locations.find((row) => row.key === "recipient")?.id,
            carrierReference: null,
            notes: "Synthetic downstream",
            items: [{ lotId: result.input.outputLotId, quantity: "1", unitOfMeasure: "case" }],
            documentIds: [document.id],
          },
        },
        "shipping-draft",
      );
      const ready = await shipping.checkReadiness(context.tenantId, context.actorUserId, draft.id, {
        expectedDraftVersion: 1,
      });
      expect(ready.state).toBe("complete");
      await shipping.finalize(
        context.tenantId,
        context.actorUserId,
        draft.id,
        {
          operationKey: randomUUID(),
          expectedDraftVersion: 1,
          expectedInputDigest: ready.inputDigest,
        },
        "shipping-finalize",
      );
      expect(
        await shipping.getLotShippingBalance(
          context.tenantId,
          context.actorUserId,
          result.input.outputLotId,
          {},
        ),
      ).toEqual({
        lotId: result.input.outputLotId,
        originUom: "case",
        balance: {
          state: "known",
          unitOfMeasure: "case",
          supply: "55",
          used: "1",
          remaining: "54",
        },
      });
      const publicCases = new UsCaseStore(f.db);
      expect(
        (
          await publicCases.list(context.tenantId, context.actorUserId, result.input.outputLotId, {
            limit: 100,
          })
        ).rows,
      ).toEqual(
        [...result.linked.created].sort(
          (a, b) => a.linkedAt.localeCompare(b.linkedAt) || a.linkId.localeCompare(b.linkId),
        ),
      );
      expect(
        (
          await publicCases.lookup(context.tenantId, context.actorUserId, {
            sscc: result.input.support.boxes[0]?.sscc,
          })
        ).activeLink,
      ).toEqual(result.linked.created[0]);
      const trace = await new UsTraceStore(f.db).read(
        context.tenantId,
        context.actorUserId,
        result.input.outputLotId,
        { direction: "both" },
      );
      expect(trace.findings).toEqual([]);
      expect(trace.completion.state).toBe("complete");
      const before = await f.snapshot();
      for (const table of [
        "receiving_event_roots",
        "receiving_event_items",
        "receiving_event_documents",
        "transformation_event_roots",
        "transformation_event_inputs",
        "transformation_event_outputs",
        "transformation_event_documents",
        "lot_genealogy_edges",
      ]) {
        expect(original[table]).toMatch(/^[0-9a-f]{64}$/);
        expect(before[table]).toBe(original[table]);
      }
      expect(
        (
          await f.pool.query(
            "SELECT to_jsonb(t) AS row FROM traceability_events t WHERE tenant_id=$1 AND type IN ('receiving','transformation') ORDER BY id",
            [context.tenantId],
          )
        ).rows,
      ).toEqual(historical);
      expect(
        (
          await f.pool.query(
            "SELECT id,tlc,product_id,assignment_basis,source_location_id,source_reference_kind,source_reference_value,source_reference_location_id,source_locked_at,created_by,created_at FROM traceability_lots WHERE tenant_id=$1 ORDER BY id",
            [context.tenantId],
          )
        ).rows,
      ).toEqual(lotFacts);
      expect(await seed().initialize(context, 0)).toEqual(result);
      expect(await seed().verify(context, 0)).toEqual(result);
      expect(await f.snapshot()).toEqual(before);
    }));

  it.each(["physical", "unlink", "void", "amend", "wrong source receipt"])(
    "completed replay refuses %s drift without repair",
    async (kind) =>
      runDatasetCasesFixtureBody(async () => {
        const context = await f.provision(),
          installed = await prerequisites(context);
        const result = await seed().initialize(context, 0);
        if (kind === "physical")
          await f.pool.query("UPDATE shifts SET planned_qty=1 WHERE id=$1", [
            result.input.support.shiftId,
          ]);
        else if (kind === "wrong source receipt") {
          const stage = await stores().journal.readStage(
            context,
            installed.header.id,
            "chain_0000",
            "cases",
          );
          if (!stage?.receipt) throw new Error("Missing Cases receipt");
          const forged = {
            ...result,
            linked: {
              ...result.linked,
              created: result.linked.created.map((row) => ({ ...row, linkSource: "manual" })),
            },
          };
          await f.pool.query(
            "UPDATE traceability_demo_dataset_stages SET receipt=$1 WHERE stage='cases'",
            [{ ...stage.receipt, result: forged, resultDigest: canonicalExportDigest(forged) }],
          );
        } else if (kind === "unlink")
          await new UsCaseStore(f.db).unlink(
            context.tenantId,
            context.actorUserId,
            result.input.outputLotId,
            result.linked.created[0]?.linkId,
            { operationKey: randomUUID(), reason: "Synthetic drift" },
            "unlink-drift",
          );
        else {
          const args = {
            operationKey: randomUUID(),
            expectedLifecycleVersion: 2,
            reason: "Synthetic drift",
          };
          if (kind === "void")
            await stores().transformation.void(
              context.tenantId,
              context.actorUserId,
              installed.transformation.created.id,
              args,
              "void-drift",
            );
          else
            await stores().transformation.amend(
              context.tenantId,
              context.actorUserId,
              installed.transformation.created.id,
              args,
              "amend-drift",
            );
        }
        const before = await f.snapshot();
        await expect(seed().initialize(context, 0)).rejects.toThrow("us_dataset_cases_mismatch");
        await expect(seed().verify(context, 0)).rejects.toThrow("us_dataset_cases_mismatch");
        expect(await f.snapshot()).toEqual(before);
      }),
  );

  it.for(["extensible", "frozen", "sealed", "nonconfigurable", "non-error"])(
    "preserves original %s error after real native writes",
    async (kind, test) =>
      runDatasetCasesFixtureBody(async () => {
        const context = await f.provision(),
          captured = await prepareDatasetCasesFixture(f, context, 0);
        const cause = new Error("synthetic driver cause"),
          error = new Error("synthetic native failure", { cause });
        if (kind === "nonconfigurable")
          Object.defineProperty(error, "unitKey", { value: "protected" });
        const failure =
          kind === "frozen"
            ? Object.freeze(error)
            : kind === "sealed"
              ? Object.seal(error)
              : kind === "non-error"
                ? "synthetic non-error failure"
                : error;
        const original = UsCaseStore.prototype.linkDemoInTransaction;
        const spy = vi
          .spyOn(UsCaseStore.prototype, "linkDemoInTransaction")
          .mockImplementation(async function (this: UsCaseStore, ...args) {
            await original.apply(this, args);
            throw failure;
          });
        test.onTestFinished(() => spy.mockRestore());
        const before = await f.snapshot();
        try {
          await expect(seed().initialize(context, 0)).rejects.toBe(failure);
          if (kind === "extensible")
            expect(failure).toMatchObject({
              cause,
              unitKey: captured.intent.unitKey,
              stage: "cases",
            });
          expect(await f.snapshot()).toEqual(before);
        } finally {
          spy.mockRestore();
        }
      }),
  );

  describe("runner cancellation of actual executor work", () => {
    let context: Context;
    let captured: Awaited<ReturnType<typeof prepareDatasetCasesFixture>>;
    let before: Awaited<ReturnType<typeof f.snapshot>>;
    beforeEach(async () => {
      context = await f.provision();
      captured = await prepareDatasetCasesFixture(f, context, 0);
      before = await f.snapshot();
    }, 60000);
    const evidence: {
      phase: string;
      aborted: boolean;
      sameReason: boolean;
      observed: boolean;
      absent: boolean;
      rollback: boolean;
    }[] = [];

    it.fails(
      "runner timeout aborts actual executor authorization before readiness",
      { timeout: 400 },
      async (test) => {
        let ownedPid = 0,
          wrote = false;
        const observation = startObservation(test, (signal) =>
          withOwnedWork(async (own) => {
            const pools = connections(own);
            ownedPid = await pid(pools.first);
            const original = UsDatasetJournalStore.prototype.read;
            const spy = vi
              .spyOn(UsDatasetJournalStore.prototype, "read")
              .mockImplementation(async function (this: UsDatasetJournalStore, ...args) {
                const result = await original.apply(this, args);
                wrote = result?.id === captured.datasetId;
                await abortable(barrier().promise, signal);
                return result;
              });
            own("native spy", async () => spy.mockRestore());
            await new UsDatasetCasesSeedStore(pools.first.db).initialize(context, 0);
          }),
        );
        const readiness = outcome(observation.ready);
        test.onTestFinished(async () => {
          await observation.cleanup();
          await readiness;
          const result = await observation.running;
          const absent =
            (
              await f.pool.query<{ n: number }>(
                "SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database() AND pid=$1",
                [ownedPid],
              )
            ).rows[0]?.n === 0;
          evidence.push({
            phase: "before readiness",
            aborted: test.signal.aborted,
            sameReason: result.error === test.signal.reason,
            observed: wrote && ownedPid > 0,
            absent,
            rollback: canonicalExportDigest(await f.snapshot()) === canonicalExportDigest(before),
          });
        });
        await observation.ready;
      },
    );

    it.fails(
      "runner timeout cancels a PID-observed pending Cases operation waiter",
      { timeout: 5000 },
      async (test) => {
        let pids: number[] = [],
          observed = false;
        const observation = startObservation(test, (signal, ready) =>
          withOwnedWork(async (own) => {
            const pools = connections(own);
            const holderPid = await pid(pools.gate),
              executorPid = await pid(pools.first);
            pids = [holderPid, executorPid];
            const acquired = barrier(),
              release = barrier();
            const workers: ReturnType<typeof outcome>[] = [];
            own("release before actual workers drain", async () => {
              release.release();
              await Promise.all(workers);
            });
            workers.push(
              outcome(
                pools.gate.db.transaction(async (tx) => {
                  await lockCaseOperation(
                    tx,
                    context.tenantId,
                    "case.link",
                    captured.intent.operationKey,
                  );
                  acquired.release();
                  await release.promise;
                }),
              ),
            );
            await abortable(acquired.promise, signal);
            const original = UsCaseStore.prototype.linkDemoInTransaction;
            const spy = vi
              .spyOn(UsCaseStore.prototype, "linkDemoInTransaction")
              .mockImplementation(async function (this: UsCaseStore, ...args) {
                signal.throwIfAborted();
                return original.apply(this, args);
              });
            // This cleanup is ordered after drain below, so pending native code retains the cancellation guard.
            const running = outcome(
              new UsDatasetCasesSeedStore(pools.first.db).initialize(context, 0),
            );
            workers.push(running);
            try {
              await waitBlocked(f, holderPid, executorPid, signal);
              observed = true;
              await abortable(ready(), signal);
              const result = await abortable(running, signal);
              if (result.error !== undefined) throw result.error;
            } finally {
              release.release();
              await Promise.all(workers);
              spy.mockRestore();
            }
          }),
        );
        test.onTestFinished(async () => {
          await observation.cleanup();
          const result = await observation.running;
          const absent =
            (
              await f.pool.query<{ n: number }>(
                "SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database() AND pid=ANY($1::int[])",
                [pids],
              )
            ).rows[0]?.n === 0;
          evidence.push({
            phase: "while blocked",
            aborted: test.signal.aborted,
            sameReason: result.error === test.signal.reason,
            observed: observed && pids.length === 2,
            absent,
            rollback: canonicalExportDigest(await f.snapshot()) === canonicalExportDigest(before),
          });
        });
        await observation.ready;
        const result = await observation.running;
        if (result.error !== undefined) throw result.error;
      },
    );

    it("proves exact signal phases, primary reason, full rollback and owned backend disposal", () => {
      expect(evidence).toEqual([
        {
          phase: "before readiness",
          aborted: true,
          sameReason: true,
          observed: true,
          absent: true,
          rollback: true,
        },
        {
          phase: "while blocked",
          aborted: true,
          sameReason: true,
          observed: true,
          absent: true,
          rollback: true,
        },
      ]);
    });
  });

  it("keeps the primary failure while independently releasing actual owned clients", async () => {
    const primary = new Error("executor primary"),
      cleanup = new Error("synthetic client cleanup"),
      seen: string[] = [],
      pids: number[] = [];
    let report: unknown;
    await expect(
      withOwnedWork(
        async (own) => {
          const second = await f.pool.connect();
          ownClient(own, second, "second client", async () => {
            await second.query("ROLLBACK");
            seen.push("second");
          });
          await second.query("BEGIN");
          const first = await f.pool.connect();
          ownClient(own, first, "first client", async () => {
            await first.query("ROLLBACK");
            seen.push("first");
            throw cleanup;
          });
          await first.query("BEGIN");
          for (const client of [first, second]) {
            const value = (await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid"))
              .rows[0]?.pid;
            if (!value) throw new Error("Missing cleanup PID");
            pids.push(value);
          }
          throw primary;
        },
        (value) => {
          report = value;
        },
      ),
    ).rejects.toBe(primary);
    expect(seen).toEqual(["first", "second"]);
    expect(report).toEqual({
      primaryError: primary,
      cleanupFailures: [{ phase: "first client", error: cleanup }],
    });
    expect(
      (
        await f.pool.query<{ n: number }>(
          "SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database() AND pid=ANY($1::int[])",
          [pids],
        )
      ).rows[0]?.n,
    ).toBe(0);
  });
});
