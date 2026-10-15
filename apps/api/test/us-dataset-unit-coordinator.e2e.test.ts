import { randomUUID } from "node:crypto";
import { canonicalExportDigest } from "@markiro/domain";
import { beforeEach, describe, expect, it, vi, type TestContext } from "vitest";
import type {
  UsDatasetContext,
  UsDatasetReceipt,
} from "../src/modules/traceability/demo/us-dataset-contract";
import { UsDatasetJournalStore } from "../src/modules/traceability/demo/us-dataset-journal";
import { UsDatasetRegularSeedStore } from "../src/modules/traceability/demo/us-dataset-regular-seed";
import { UsDatasetReferenceSeedStore } from "../src/modules/traceability/demo/us-dataset-reference-seed";
import { UsDatasetShippingSeedStore } from "../src/modules/traceability/demo/us-dataset-shipping-seed";
import { UsDatasetTraceReadinessStageStore } from "../src/modules/traceability/demo/us-dataset-trace-readiness-stage";
import type {
  UsDatasetTraceReadinessResult,
  UsDatasetTraceReadinessUnit,
} from "../src/modules/traceability/demo/us-dataset-trace-readiness";
import { UsTraceStore } from "../src/modules/traceability/trace/us-trace-store";
import { countActualQueries } from "./support/us-dataset-query-counter";
import {
  UsDatasetTraceReadinessSeedStore,
  type UsDatasetTraceReadinessSeedResult,
} from "../src/modules/traceability/demo/us-dataset-trace-readiness-seed";
import {
  UsDatasetUnitCompositionStore,
  type UsDatasetUnitCompositionResult,
} from "../src/modules/traceability/demo/us-dataset-unit-composition";
import { specialFixture } from "./support/us-dataset-special-fixture";
import {
  driverCode,
  outcome,
  withOwnedWork,
  type OwnCleanup,
} from "./support/us-transformation-lock-fixture";

type RawStage = Readonly<
  Record<string, unknown> & {
    dataset_id: string;
    unit_key: string;
    stage: string;
    revision: number;
    receipt: UsDatasetReceipt | null;
    operation_key: string;
    input: Readonly<Record<string, unknown>>;
    input_digest: string;
  }
>;

const base = process.env.US_TEST_DATABASE_URL;
describe.skipIf(!base)("bounded dataset unit coordinator", () => {
  const h = specialFixture(base);
  const faultCases = {
    "trace-unit1": {
      action: "UPDATE",
      condition:
        "NEW.unit_key='chain_0001' AND NEW.stage='trace_readiness' AND NEW.receipt IS NOT NULL",
      code: "40001",
    },
    "receiving-unit1": {
      action: "INSERT",
      condition: "NEW.unit_key='chain_0001' AND NEW.stage='receiving'",
      code: "23514",
    },
    "receiving-unit2": {
      action: "INSERT",
      condition: "NEW.unit_key='chain_0002' AND NEW.stage='receiving'",
      code: "23514",
    },
  } as const;

  async function installCoordinatorFault(
    own: OwnCleanup,
    test: TestContext,
    kind: keyof typeof faultCases,
  ) {
    const { action, condition, code } = faultCases[kind];
    const name = "coordinator_fault_" + randomUUID().replaceAll("-", "");
    let functionCreated = false,
      triggerCreated = false;
    const removeFunction = async () => {
      if (functionCreated) {
        await h.f.pool.query(`DROP FUNCTION ${name}()`);
        functionCreated = false;
      }
    };
    const removeTrigger = async () => {
      if (triggerCreated) {
        await h.f.pool.query(`DROP TRIGGER ${name} ON traceability_demo_dataset_stages`);
        triggerCreated = false;
      }
    };
    // Pre-CREATE ownership survives partial installation; failed DROP retains retry ownership.
    own("remove coordinator function", removeFunction);
    own("remove coordinator trigger", removeTrigger);
    const remove = () =>
      withOwnedWork(async (retry) => {
        retry("retry coordinator function", removeFunction);
        retry("retry coordinator trigger", removeTrigger);
      });
    test.onTestFinished(remove);
    await h.f.pool.query(
      `CREATE FUNCTION ${name}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF ${condition} THEN RAISE EXCEPTION 'special_sql_fault' USING ERRCODE='${code}'; END IF; RETURN NEW; END $$`,
    );
    functionCreated = true;
    await h.f.pool.query(
      `CREATE TRIGGER ${name} BEFORE ${action} ON traceability_demo_dataset_stages FOR EACH ROW EXECUTE FUNCTION ${name}()`,
    );
    triggerCreated = true;
    return remove;
  }

  async function rawStages() {
    return (
      await h.f.pool.query<{ row: RawStage }>(
        "SELECT to_jsonb(s) AS row FROM traceability_demo_dataset_stages s ORDER BY unit_key, stage",
      )
    ).rows.map(({ row }) => row);
  }
  const nativeCensus = [
    ["chain_0000", "cases"],
    ["chain_0000", "receiving"],
    ["chain_0000", "shipping"],
    ["chain_0000", "transformation"],
    ["chain_0001", "cases"],
    ["chain_0001", "receiving"],
    ["chain_0001", "shipping"],
    ["chain_0001", "transformation"],
    ["references", "references"],
  ];

  beforeEach(
    h.phase(async (test: TestContext) => {
      if (test.task.name !== "C01 trace-unit1-before-native-unit2") {
        await prepareOther(test);
        return;
      }
      // Prepared order proof: eight real native chain stages plus one Reference stage.
      await new UsDatasetRegularSeedStore(h.f.db).initialize(h.context, {
        startIndex: 0,
        count: 2,
      });
      const rows = await rawStages();
      expect(rows.map((row) => [row.unit_key, row.stage])).toEqual(nativeCensus);
      expect(rows.every((row) => row.revision === 2 && row.receipt !== null)).toBe(true);
    }),
    60_000,
  );

  // A native-all prepass reaches the real Receiving2 fault before it can attempt Trace1.
  it(
    "C01 trace-unit1-before-native-unit2",
    h.phase(async (test: TestContext) => {
      const started = performance.now();
      try {
        await withOwnedWork(async (own) => {
          const before = await h.f.snapshot();
          const nativeRows = await rawStages();
          await installCoordinatorFault(own, test, "trace-unit1");
          await installCoordinatorFault(own, test, "receiving-unit2");

          let savedPending: RawStage | undefined;
          let receiptError: unknown;
          const recordReceipt = UsDatasetJournalStore.prototype.recordReceipt;
          const receiptSpy = vi
            .spyOn(UsDatasetJournalStore.prototype, "recordReceipt")
            .mockImplementation(async function (this: UsDatasetJournalStore, ...args) {
              const selected = args[3] === "chain_0001" && args[4] === "trace_readiness";
              if (selected)
                savedPending = (await rawStages()).find(
                  (row) => row.unit_key === "chain_0001" && row.stage === "trace_readiness",
                );
              try {
                return await recordReceipt.apply(this, args);
              } catch (error) {
                if (selected) receiptError = error;
                throw error;
              }
            });
          own("restore coordinator receipt observation", async () => {
            receiptSpy.mockRestore();
          });

          const outputs: UsDatasetUnitCompositionResult[] = [];
          let ownerError: unknown;
          const initialize = UsDatasetUnitCompositionStore.prototype.initialize;
          const ownerSpy = vi
            .spyOn(UsDatasetUnitCompositionStore.prototype, "initialize")
            .mockImplementation(async function (this: UsDatasetUnitCompositionStore, ...args) {
              try {
                const checked = await initialize.apply(this, args);
                outputs.push(checked);
                return checked;
              } catch (error) {
                ownerError = error;
                throw error;
              }
            });
          own("restore coordinator owner observation", async () => {
            ownerSpy.mockRestore();
          });

          const work: { pending?: ReturnType<typeof outcome<UsDatasetTraceReadinessSeedResult>> } =
            {};
          const drain = async () => {
            await work.pending;
          };
          own("drain coordinator invocation", drain);
          test.onTestFinished(drain);
          work.pending = outcome(
            new UsDatasetTraceReadinessSeedStore(h.f.db).initialize(h.context),
          );
          const failed = await work.pending;
          const rows = await rawStages();
          const after = await h.f.snapshot();
          // Record the old-source outcome before the meaningful wrong-error assertion fires.
          console.info("C01 actual coordinator rejection", {
            code: driverCode(failed.error),
            unitKey:
              failed.error instanceof Error && "unitKey" in failed.error
                ? failed.error.unitKey
                : undefined,
            stage:
              failed.error instanceof Error && "stage" in failed.error
                ? failed.error.stage
                : undefined,
            traceRows: rows.filter((row) => row.stage === "trace_readiness").length,
            stages: rows.map((row) => [row.unit_key, row.stage, row.revision]),
            nativeRowsUnchanged: canonicalExportDigest(rows) === canonicalExportDigest(nativeRows),
            nonjournalTablesUnchanged: Object.keys(before).every(
              (table) =>
                table === "traceability_demo_dataset_stages" || before[table] === after[table],
            ),
          });
          expect(failed.value).toBeUndefined();
          expect(failed.error).toMatchObject({
            cause: { code: "40001", message: "special_sql_fault" },
          });
          expect(failed.error).toBe(receiptError);
          expect(failed.error).toBe(ownerError);
          expect(failed.error).not.toHaveProperty("unitKey");
          expect(failed.error).not.toHaveProperty("stage");
          expect(ownerSpy.mock.calls.map(([, unit]) => unit)).toEqual([
            { kind: "regular", index: 0 },
            { kind: "regular", index: 1 },
          ]);
          expect(outputs).toHaveLength(1);
          const prefix = outputs[0];
          if (!prefix || prefix.kind !== "regular") throw new Error("Missing real regular prefix");
          expect(prefix.trace.unitKey).toBe("chain_0000");
          expect(rows.filter((row) => row.stage !== "trace_readiness")).toEqual(nativeRows);
          expect(rows).toHaveLength(11);
          const complete = rows.find(
            (row) => row.unit_key === "chain_0000" && row.stage === "trace_readiness",
          );
          expect(complete).toMatchObject({
            revision: 2,
            receipt: {
              result: prefix.trace,
              resultDigest: canonicalExportDigest(prefix.trace),
            },
          });
          const pending = rows.find(
            (row) => row.unit_key === "chain_0001" && row.stage === "trace_readiness",
          );
          const predecessor = nativeRows.find(
            (row) => row.unit_key === "chain_0001" && row.stage === "shipping",
          );
          if (!savedPending || !pending || !predecessor?.receipt)
            throw new Error("Missing actual pending intent or native predecessor");
          expect(pending).toEqual(savedPending);
          expect(pending.revision).toBe(1);
          expect(pending.receipt).toBeNull();
          expect(pending.operation_key).toMatch(
            /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
          );
          expect(pending.input).toEqual({
            codec: "us-dataset-trace-readiness-stage-v1",
            datasetId: prefix.trace.datasetId,
            version: prefix.trace.version,
            definitionDigest: prefix.trace.definitionDigest,
            unit: { kind: "regular", index: 1 },
            predecessor: {
              unitKey: "chain_0001",
              stage: "shipping",
              operationKey: predecessor.operation_key,
              inputDigest: predecessor.input_digest,
              resultDigest: predecessor.receipt.resultDigest,
              revision: 2,
            },
          });
          expect(pending.input_digest).toBe(canonicalExportDigest(pending.input));
          for (const [table, digest] of Object.entries(before))
            if (table !== "traceability_demo_dataset_stages") expect(after[table]).toBe(digest);
        });
      } finally {
        console.info("C01 whole body ms", Math.round(performance.now() - started));
      }
    }),
  );

  let foreignTenantId: string | undefined;
  async function prepareOther(test: TestContext) {
    foreignTenantId = undefined;
    const id = test.task.name.slice(0, 3);
    const owner = new UsDatasetUnitCompositionStore(h.f.db);
    if (id === "C03" || id === "C04") {
      await owner.initialize(h.context, { kind: "regular", index: 0 });
      await withOwnedWork(async (own) => {
        await installCoordinatorFault(own, test, "trace-unit1");
        const work: { pending?: ReturnType<typeof outcome<UsDatasetUnitCompositionResult>> } = {};
        const drain = async () => {
          await work.pending;
        };
        own("drain pending setup invocation", drain);
        test.onTestFinished(drain);
        work.pending = outcome(owner.initialize(h.context, { kind: "regular", index: 1 }));
        const failed = await work.pending;
        expect(failed.value).toBeUndefined();
        expect(failed.error).toMatchObject({
          cause: { code: "40001", message: "special_sql_fault" },
        });
        expect(
          (await rawStages()).find(
            (row) => row.unit_key === "chain_0001" && row.stage === "trace_readiness",
          ),
        ).toMatchObject({ revision: 1, receipt: null });
      });
    }
    if (id === "C05" || id === "C06") {
      await owner.initialize(h.context, { kind: "regular", index: 0 });
      await owner.initialize(h.context, { kind: "regular", index: 1 });
    }
    if (id === "C08" || id === "C13" || id === "C14")
      await new UsDatasetReferenceSeedStore(h.f.db).initialize(h.context);
    if (id === "C09" || id === "C10") {
      foreignTenantId = randomUUID();
      await h.f.pool.query(
        "INSERT INTO organization(id,name,slug,created_at) VALUES($1,'Synthetic foreign coordinator tenant',$2,now())",
        [foreignTenantId, `coordinator-${randomUUID()}`],
      );
    }
    if (id === "C11" || id === "C12")
      await h.f.pool.query('UPDATE "user" SET name=$1 WHERE id=$2', [
        "changed owner",
        h.context.actorUserId,
      ]);
    if (id === "C13" || id === "C14") {
      const references = new UsDatasetReferenceSeedStore(h.f.db);
      const refs = await references.verify(h.context);
      const product = refs.bindings.products[0];
      if (!product) throw new Error("Missing bound Reference product");
      const evidence = refs.evidence.products.find(({ id }) => id === product.id);
      if (!evidence || typeof evidence.name !== "string")
        throw new Error("Missing bound Reference product evidence");
      expect(evidence.id).toBe(product.id);
      const savedRows = await rawStages();
      expect(savedRows.map((row) => [row.unit_key, row.stage])).toEqual([
        ["references", "references"],
      ]);
      expect(savedRows[0]).toMatchObject({ revision: 2 });
      expect(savedRows[0]?.receipt).not.toBeNull();
      if (!savedRows[0]?.receipt) throw new Error("Missing completed Reference receipt");
      const savedBytes = JSON.stringify(savedRows);
      const before = await h.f.pool.query<{ id: string; name: string }>(
        "SELECT id,name FROM products WHERE tenant_id=$1 AND id=$2",
        [h.context.tenantId, product.id],
      );
      expect(before.rowCount).toBe(1);
      expect(before.rows).toEqual([{ id: product.id, name: evidence.name }]);
      const original = before.rows[0];
      if (!original || typeof original.name !== "string")
        throw new Error("Missing raw bound Reference product name");
      const changedName = original.name + " synthetic coordinator drift";
      expect(changedName).not.toBe(original.name);
      const changed = await h.f.pool.query<{ id: string; name: string }>(
        "UPDATE products SET name=$1 WHERE tenant_id=$2 AND id=$3 AND name=$4 RETURNING id,name",
        [changedName, h.context.tenantId, product.id, original.name],
      );
      expect(changed.rowCount).toBe(1);
      expect(changed.rows).toEqual([{ id: product.id, name: changedName }]);
      const readback = await h.f.pool.query<{ id: string; name: string }>(
        "SELECT id,name FROM products WHERE tenant_id=$1 AND id=$2",
        [h.context.tenantId, product.id],
      );
      expect(readback.rowCount).toBe(1);
      expect(readback.rows).toEqual([{ id: product.id, name: changedName }]);
      expect(readback.rows).not.toEqual(before.rows);
      expect(JSON.stringify(await rawStages())).toBe(savedBytes);
      const mismatched = await outcome(references.verify(h.context));
      expect(mismatched.value).toBeUndefined();
      expect(mismatched.error).toBeInstanceOf(Error);
      expect(mismatched.error).toMatchObject({
        message: "us_dataset_reference_mismatch",
        unitKey: "references",
        stage: "references",
      });
      expect(JSON.stringify(await rawStages())).toBe(savedBytes);
    }
    if (id === "C15" || id === "C16")
      await new UsDatasetRegularSeedStore(h.f.db).initialize(h.context, {
        startIndex: 0,
        count: 1,
      });
    if (id === "C17") await owner.initialize(h.context, { kind: "regular", index: 0 });
  }

  function body(name: string, run: (test: TestContext, own: OwnCleanup) => Promise<void>) {
    return h.phase(async (test: TestContext) => {
      const started = performance.now();
      try {
        await withOwnedWork((own) => run(test, own));
      } finally {
        console.info(`${name} whole body ms`, Math.round(performance.now() - started));
      }
    });
  }
  async function checkpoint(label: string) {
    const measured = await countActualQueries(h.f.pool, () => h.f.snapshot());
    console.info(`${label} snapshot forwarding`, {
      queries: measured.count,
      elapsedMs: Math.round(measured.durationMs),
    });
    return { snapshot: measured.value, rows: await rawStages() };
  }
  async function invoke(
    own: OwnCleanup,
    test: TestContext,
    mode: "initialize" | "verify",
    context: UsDatasetContext = h.context,
  ) {
    const outputs: UsDatasetUnitCompositionResult[] = [];
    const calls: UsDatasetTraceReadinessUnit[] = [];
    let observedError: unknown;
    const original = UsDatasetUnitCompositionStore.prototype[mode];
    const spy = vi
      .spyOn(UsDatasetUnitCompositionStore.prototype, mode)
      .mockImplementation(async function (this: UsDatasetUnitCompositionStore, ...args) {
        calls.push(args[1]);
        try {
          const value = await original.apply(this, args);
          outputs.push(value);
          return value;
        } catch (error) {
          observedError = error;
          throw error;
        }
      });
    own("restore finite coordinator observation", async () => {
      spy.mockRestore();
    });
    type Failed = Awaited<ReturnType<typeof outcome<UsDatasetTraceReadinessSeedResult>>>;
    const work: { pending?: Promise<{ value: Failed; count: number; durationMs: number }> } = {};
    const drain = async () => {
      await work.pending;
    };
    own("drain finite coordinator invocation", drain);
    test.onTestFinished(drain);
    work.pending = countActualQueries(h.f.pool, () =>
      outcome(new UsDatasetTraceReadinessSeedStore(h.f.db)[mode](context)),
    );
    const measured = await work.pending;
    console.info(`${test.task.name} invocation forwarding`, {
      queries: measured.count,
      elapsedMs: Math.round(measured.durationMs),
    });
    expect(measured.value.value).toBeUndefined();
    expect(measured.value.error).toBe(observedError);
    return { failed: measured.value, outputs, calls };
  }
  function rejection(
    error: unknown,
    message: string,
    unitKey: string,
    stage: string,
    cause?: string,
  ) {
    expect(error).toBeInstanceOf(Error);
    expect(error).toMatchObject({ message, unitKey, stage });
    expect(driverCode(error)).toBeUndefined();
    if (cause) expect(error).toMatchObject({ cause: { message: cause } });
    else expect(error).not.toHaveProperty("cause");
  }
  function cutoff(error: unknown, index: 1 | 2) {
    expect(error).toMatchObject({
      cause: { code: "23514", message: "special_sql_fault" },
      unitKey: `chain_000${index}`,
      stage: "receiving",
    });
  }
  function unchanged(
    before: Awaited<ReturnType<typeof checkpoint>>,
    after: Awaited<ReturnType<typeof checkpoint>>,
  ) {
    expect(after.snapshot).toEqual(before.snapshot);
    expect(after.rows).toEqual(before.rows);
  }
  function receipt(result: UsDatasetTraceReadinessResult): UsDatasetReceipt {
    return {
      recordIds: [...new Set([...result.lotIds, ...result.currentEventIds])],
      resultDigest: canonicalExportDigest(result),
      result,
    };
  }
  function prefixReceipts(
    outputs: readonly UsDatasetUnitCompositionResult[],
    rows: readonly RawStage[],
  ) {
    for (const output of outputs) {
      const saved = rows.find(
        (row) => row.unit_key === output.trace.unitKey && row.stage === "trace_readiness",
      );
      expect(saved).toMatchObject({ revision: 2, receipt: receipt(output.trace) });
    }
  }
  function completedCensus(rows: readonly RawStage[], count: 1 | 2) {
    const expected = ["references:references"];
    for (let index = 0; index < count; index++)
      for (const stage of ["receiving", "transformation", "cases", "shipping", "trace_readiness"])
        expected.push(`chain_000${index}:${stage}`);
    expect(rows.map((row) => `${row.unit_key}:${row.stage}`).sort()).toEqual(expected.sort());
    expect(rows.every((row) => row.revision === 2 && row.receipt !== null)).toBe(true);
  }
  async function creationParity(outputs: readonly UsDatasetUnitCompositionResult[], index: 0 | 1) {
    const output = outputs.find(
      (value) => value.kind === "regular" && value.native.index === index,
    );
    if (!output || output.kind !== "regular")
      throw new Error("Missing actual created regular output");
    const shipping = await new UsDatasetShippingSeedStore(h.f.db).verify(h.context, index);
    expect(output.native).toEqual({
      index,
      unitKey: `chain_000${index}`,
      shipmentCount: shipping.shipments.length,
      shippingResultDigest: canonicalExportDigest(shipping),
    });
    const independentTrace = await new UsDatasetTraceReadinessStageStore(h.f.db).verify(h.context, {
      kind: "regular",
      index,
    });
    expect(output.trace).toEqual(independentTrace);
    const census = await h.f.pool.query<{ kind: "event" | "lot"; id: string }>(
      "SELECT 'event' AS kind,id FROM traceability_events UNION ALL SELECT 'lot' AS kind,id FROM traceability_lots ORDER BY kind,id",
    );
    const events = [...new Set(outputs.flatMap((value) => value.trace.currentEventIds))];
    const lots = [...new Set(outputs.flatMap((value) => value.trace.lotIds))];
    expect(census.rows).toEqual(
      [
        ...events.map((id) => ({ kind: "event", id })),
        ...lots.map((id) => ({ kind: "lot", id })),
      ].sort((a, b) => a.kind.localeCompare(b.kind) || a.id.localeCompare(b.id)),
    );
  }

  it(
    "C02 fresh-unit0-before-native-unit1",
    body("C02", async (test, own) => {
      const before = await checkpoint("C02 before");
      expect(before.rows).toEqual([]);
      await installCoordinatorFault(own, test, "receiving-unit1");
      const actual = await invoke(own, test, "initialize");
      cutoff(actual.failed.error, 1);
      expect(actual.calls).toEqual([
        { kind: "regular", index: 0 },
        { kind: "regular", index: 1 },
      ]);
      expect(actual.outputs).toHaveLength(1);
      await creationParity(actual.outputs, 0);
      const after = await checkpoint("C02 after");
      completedCensus(after.rows, 1);
      prefixReceipts(actual.outputs, after.rows);
    }),
  );

  it(
    "C03 resume-pending-unit1-before-native-unit2",
    body("C03", async (test, own) => {
      const before = await checkpoint("C03 before");
      const pending = before.rows.find(
        (row) => row.unit_key === "chain_0001" && row.stage === "trace_readiness",
      );
      if (!pending) throw new Error("Missing prepared pending row");
      expect(pending).toMatchObject({ revision: 1, receipt: null });
      await installCoordinatorFault(own, test, "receiving-unit2");
      const actual = await invoke(own, test, "initialize");
      cutoff(actual.failed.error, 2);
      expect(actual.calls).toEqual([
        { kind: "regular", index: 0 },
        { kind: "regular", index: 1 },
        { kind: "regular", index: 2 },
      ]);
      const independent = await new UsDatasetTraceReadinessStageStore(h.f.db).verify(h.context, {
        kind: "regular",
        index: 1,
      });
      const expected = { ...pending, receipt: receipt(independent), revision: 2 };
      const after = await checkpoint("C03 after");
      expect(after.rows).toEqual(before.rows.map((row) => (row === pending ? expected : row)));
      for (const [table, digest] of Object.entries(before.snapshot))
        if (table !== "traceability_demo_dataset_stages")
          expect(after.snapshot[table]).toBe(digest);
      expect(actual.outputs).toHaveLength(2);
      prefixReceipts(actual.outputs, after.rows);
      completedCensus(after.rows, 2);
    }),
  );

  it(
    "C04 verify-pending-unit1-without-writes",
    body("C04", async (test, own) => {
      const before = await checkpoint("C04 before");
      const actual = await invoke(own, test, "verify");
      rejection(
        actual.failed.error,
        "us_dataset_trace_readiness_stage_incomplete",
        "chain_0001",
        "trace_readiness",
      );
      expect(actual.outputs).toHaveLength(1);
      unchanged(before, await checkpoint("C04 after"));
    }),
  );

  it(
    "C05 verify-complete-prefix-without-writes",
    body("C05", async (test, own) => {
      const before = await checkpoint("C05 before");
      const actual = await invoke(own, test, "verify");
      rejection(
        actual.failed.error,
        "us_dataset_receiving_prerequisite_incomplete",
        "chain_0002",
        "receiving",
      );
      expect(actual.outputs).toHaveLength(2);
      expect(actual.calls).toEqual([
        { kind: "regular", index: 0 },
        { kind: "regular", index: 1 },
        { kind: "regular", index: 2 },
      ]);
      prefixReceipts(actual.outputs, before.rows);
      unchanged(before, await checkpoint("C05 after"));
    }),
  );

  it(
    "C06 replay-complete-prefix-without-writes",
    body("C06", async (test, own) => {
      const before = await checkpoint("C06 before");
      await installCoordinatorFault(own, test, "receiving-unit2");
      const actual = await invoke(own, test, "initialize");
      cutoff(actual.failed.error, 2);
      expect(actual.outputs).toHaveLength(2);
      expect(actual.calls).toEqual([
        { kind: "regular", index: 0 },
        { kind: "regular", index: 1 },
        { kind: "regular", index: 2 },
      ]);
      prefixReceipts(actual.outputs, before.rows);
      unchanged(before, await checkpoint("C06 after"));
    }),
  );

  it(
    "C07 verify-fresh-without-writes",
    body("C07", async (test, own) => {
      const before = await checkpoint("C07 before");
      const actual = await invoke(own, test, "verify");
      rejection(
        actual.failed.error,
        "us_dataset_references_incomplete",
        "references",
        "references",
      );
      unchanged(before, await checkpoint("C07 after"));
    }),
  );
  it(
    "C08 verify-reference-only-without-writes",
    body("C08", async (test, own) => {
      const before = await checkpoint("C08 before");
      const actual = await invoke(own, test, "verify");
      rejection(
        actual.failed.error,
        "us_dataset_receiving_prerequisite_incomplete",
        "chain_0000",
        "receiving",
      );
      unchanged(before, await checkpoint("C08 after"));
    }),
  );

  for (const [name, mode] of [
    ["C09 initialize-denies-foreign-tenant", "initialize"],
    ["C10 verify-denies-foreign-tenant", "verify"],
  ] as const)
    it(
      name,
      body(name, async (test, own) => {
        if (!foreignTenantId) throw new Error("Missing real foreign synthetic tenant");
        const before = await checkpoint(`${name} before`);
        const actual = await invoke(own, test, mode, { ...h.context, tenantId: foreignTenantId });
        rejection(actual.failed.error, "us_dataset_target_invalid", "unknown", "target");
        unchanged(before, await checkpoint(`${name} after`));
      }),
    );
  for (const [name, mode] of [
    ["C11 initialize-denies-changed-original-owner", "initialize"],
    ["C12 verify-denies-changed-original-owner", "verify"],
  ] as const)
    it(
      name,
      body(name, async (test, own) => {
        const before = await checkpoint(`${name} before`);
        const actual = await invoke(own, test, mode);
        rejection(actual.failed.error, "us_dataset_target_invalid", "unknown", "target");
        unchanged(before, await checkpoint(`${name} after`));
      }),
    );
  for (const [name, mode] of [
    ["C13 initialize-preserves-native-drift", "initialize"],
    ["C14 verify-preserves-native-drift", "verify"],
  ] as const)
    it(
      name,
      body(name, async (test, own) => {
        const before = await checkpoint(`${name} before`);
        if (name === "C13 initialize-preserves-native-drift")
          await installCoordinatorFault(own, test, "receiving-unit1");
        const actual = await invoke(own, test, mode);
        rejection(
          actual.failed.error,
          "us_dataset_native_drift",
          "references",
          "references",
          "us_dataset_reference_mismatch",
        );
        unchanged(before, await checkpoint(`${name} after`));
      }),
    );
  // These two cases test exception routing at the real Trace boundary, not SQL fault behavior.
  for (const [name, mode] of [
    ["C15 initialize-does-not-translate-trace-error", "initialize"],
    ["C16 verify-does-not-translate-trace-error", "verify"],
  ] as const)
    it(
      name,
      body(name, async (test, own) => {
        const before = await checkpoint(`${name} before`);
        const saved = new Error("us_dataset_shipping_mismatch");
        const trace = vi.spyOn(UsTraceStore.prototype, "read").mockRejectedValue(saved);
        own("restore fixed Trace error boundary", async () => {
          trace.mockRestore();
        });
        const actual = await invoke(own, test, mode);
        expect(actual.failed.error).toBe(saved);
        expect(saved.message).toBe("us_dataset_shipping_mismatch");
        expect(saved).not.toHaveProperty("cause");
        expect(saved).not.toHaveProperty("unitKey");
        expect(saved).not.toHaveProperty("stage");
        expect(actual.outputs).toEqual([]);
        unchanged(before, await checkpoint(`${name} after`));
      }),
    );

  // Preserve every noncounter old row; the three allocators have their own exact transition check.
  async function existingRowDigests() {
    const tables = await h.f.pool.query<{ tablename: string }>(
      "SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename NOT IN ('receiving_counters','transformation_counters','shipping_counters') ORDER BY tablename",
    );
    for (const { tablename } of tables.rows)
      if (!/^[a-z_][a-z0-9_]*$/.test(tablename)) throw new Error("Invalid owned table name");
    const selections = tables.rows.map(
      ({ tablename }) =>
        `SELECT '${tablename}' AS name,to_jsonb(t) AS body FROM public."${tablename}" t`,
    );
    const rows = await h.f.pool.query<{ name: string; body: unknown }>(
      selections.join(" UNION ALL "),
    );
    return rows.rows.map((row) => `${row.name}:${canonicalExportDigest(row.body)}`).sort();
  }

  const c17Kinds = ["receiving", "transformation", "shipping"] as const;
  type C17Kind = (typeof c17Kinds)[number];
  type C17Counter = {
    table: string;
    body: { tenant_id: string; year: number; sequence: number; [key: string]: unknown };
  };
  type C17Root = {
    kind: C17Kind;
    id: string;
    tenant_id: string;
    event_number: string;
    event_id: string | null;
    event_tenant_id: string | null;
    event_type: string | null;
    root_event_id: string | null;
    original_event_number: string | null;
    revision: number | null;
    created_at: string | null;
    time_zone: string | null;
  };
  async function c17Allocations() {
    const counters = await h.f.pool.query<C17Counter>(
      c17Kinds
        .map(
          (kind) =>
            `SELECT '${kind}_counters' AS "table",to_jsonb(t) AS body FROM ${kind}_counters t`,
        )
        .join(" UNION ALL "),
    );
    const relation = c17Kinds
      .map((kind) => `SELECT '${kind}' AS kind,id,tenant_id,event_number FROM ${kind}_event_roots`)
      .join(" UNION ALL ");
    // LEFT JOIN and no tenant filter keep missing originals and foreign extra roots visible.
    const roots = await h.f.pool.query<C17Root>(
      `WITH roots AS (${relation}) SELECT r.*,e.id AS event_id,e.tenant_id AS event_tenant_id,e.type AS event_type,e.root_event_id,e.event_number AS original_event_number,e.revision,to_jsonb(e)->>'created_at' AS created_at,e.time_zone FROM roots r LEFT JOIN traceability_events e ON e.id=r.id AND e.tenant_id=r.tenant_id`,
    );
    return { counters: counters.rows, roots: roots.rows };
  }
  function c17CounterTransition(
    before: Awaited<ReturnType<typeof c17Allocations>>,
    after: Awaited<ReturnType<typeof c17Allocations>>,
    checkedUnit1: UsDatasetTraceReadinessResult,
  ) {
    const key = (row: C17Counter) =>
      `${row.table}:${JSON.stringify([row.body.tenant_id, row.body.year])}`;
    const validate = (rows: readonly C17Counter[]) => {
      expect(new Set(rows.map(key)).size).toBe(rows.length);
      for (const row of rows) {
        expect(c17Kinds.some((kind) => row.table === `${kind}_counters`)).toBe(true);
        expect(typeof row.body.tenant_id).toBe("string");
        expect(row.body.tenant_id.length).toBeGreaterThan(0);
        expect(Number.isInteger(row.body.year) && row.body.year >= 1 && row.body.year <= 9999).toBe(
          true,
        );
        expect(Number.isSafeInteger(row.body.sequence) && row.body.sequence > 0).toBe(true);
      }
    };
    validate(before.counters);
    const oldIds = new Set(before.roots.map((root) => root.id));
    expect(oldIds.size).toBe(before.roots.length);
    expect(new Set(after.roots.map((root) => root.id)).size).toBe(after.roots.length);
    for (const root of before.roots)
      expect(after.roots.find((current) => current.id === root.id)).toEqual(root);
    const added = after.roots.filter((root) => !oldIds.has(root.id));
    expect(added).toHaveLength(4);
    expect(added.filter((root) => root.kind === "receiving")).toHaveLength(1);
    expect(added.filter((root) => root.kind === "transformation")).toHaveLength(1);
    expect(added.filter((root) => root.kind === "shipping")).toHaveLength(2);
    expect(added.map((root) => root.id).sort()).toEqual([...checkedUnit1.currentEventIds].sort());
    expect(new Set(added.map((root) => root.event_number)).size).toBe(4);
    const prefixes = { receiving: "REC", transformation: "TRN", shipping: "SHP" } as const;
    const groups = new Map<string, { table: string; year: number; suffixes: number[] }>();
    for (const root of added) {
      expect(root.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
      expect(root.tenant_id).toBe(h.context.tenantId);
      expect(root.event_tenant_id).toBe(h.context.tenantId);
      expect(root.event_id).toBe(root.id);
      expect(root.root_event_id).toBe(root.id);
      expect(root.event_type).toBe(root.kind);
      expect(root.revision).toBe(1);
      expect(root.original_event_number).toBe(root.event_number);
      if (!root.created_at || !root.time_zone)
        throw new Error("Missing C17 allocation instant/timezone");
      const date =
        /^(\d{4}-\d{2}-\d{2})T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/.exec(
          root.created_at,
        );
      if (!date) throw new Error("Invalid C17 allocation instant");
      expect(new Date(`${date[1]}T00:00:00.000Z`).toISOString().startsWith(`${date[1]}T`)).toBe(
        true,
      );
      const instant = new Date(root.created_at);
      expect(Number.isFinite(instant.getTime())).toBe(true);
      const year = Number(
        new Intl.DateTimeFormat("en-US", { timeZone: root.time_zone, year: "numeric" }).format(
          instant,
        ),
      );
      expect(Number.isInteger(year) && year >= 1 && year <= 9999).toBe(true);
      const number = /^(REC|TRN|SHP)-(\d{2})-(\d{4,})$/.exec(root.event_number);
      if (!number) throw new Error("Invalid C17 allocation number");
      const suffix = Number(number[3]);
      expect(Number.isSafeInteger(suffix) && suffix > 0).toBe(true);
      expect(root.event_number).toBe(
        `${prefixes[root.kind]}-${String(year).slice(-2).padStart(2, "0")}-${String(suffix).padStart(4, "0")}`,
      );
      const table = `${root.kind}_counters`;
      const identity = `${table}:${JSON.stringify([h.context.tenantId, year])}`;
      const group = groups.get(identity) ?? { table, year, suffixes: [] };
      group.suffixes.push(suffix);
      groups.set(identity, group);
    }
    // Expectations use only saved before counters and the four independently checked allocations.
    const expected = structuredClone(before.counters);
    for (const [identity, group] of groups) {
      let row = expected.find((value) => key(value) === identity);
      const oldSequence = row?.body.sequence ?? 0;
      expect([...group.suffixes].sort((a, b) => a - b)).toEqual(
        group.suffixes.map((_, index) => oldSequence + index + 1),
      );
      if (!row) {
        row = {
          table: group.table,
          body: { tenant_id: h.context.tenantId, year: group.year, sequence: 0 },
        };
        expected.push(row);
      }
      row.body.sequence = oldSequence + group.suffixes.length;
    }
    validate(expected);
    validate(after.counters);
    const ordered = (rows: readonly C17Counter[]) =>
      [...rows].sort((a, b) => key(a).localeCompare(key(b)));
    expect(ordered(after.counters)).toEqual(ordered(expected));
  }
  it(
    "C17 extend-real-prefix-by-one-unit",
    body("C17", async (test, own) => {
      const before = await checkpoint("C17 before");
      const existing = await existingRowDigests();
      const allocations = await c17Allocations();
      await installCoordinatorFault(own, test, "receiving-unit2");
      const actual = await invoke(own, test, "initialize");
      cutoff(actual.failed.error, 2);
      expect(actual.outputs).toHaveLength(2);
      expect(actual.calls).toEqual([
        { kind: "regular", index: 0 },
        { kind: "regular", index: 1 },
        { kind: "regular", index: 2 },
      ]);
      await creationParity(actual.outputs, 1);
      const after = await checkpoint("C17 after");
      expect(after.rows.filter((row) => row.unit_key !== "chain_0001")).toEqual(before.rows);
      completedCensus(after.rows, 2);
      prefixReceipts(actual.outputs, after.rows);
      const remaining = await existingRowDigests();
      for (const digest of existing) {
        const index = remaining.indexOf(digest);
        expect(index).toBeGreaterThanOrEqual(0);
        remaining.splice(index, 1);
      }
      const unit1 = actual.outputs.find(
        (output) => output.kind === "regular" && output.native.index === 1,
      );
      if (!unit1) throw new Error("Missing independently checked C17 unit1");
      c17CounterTransition(allocations, await c17Allocations(), unit1.trace);
    }),
  );
});
