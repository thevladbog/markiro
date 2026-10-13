import { canonicalExportDigest } from "@markiro/domain";
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { UsDatasetRegularSeedStore } from "../src/modules/traceability/demo/us-dataset-regular-seed";
import { UsDatasetTraceReadinessStore } from "../src/modules/traceability/demo/us-dataset-trace-readiness";
import { UsDatasetTraceReadinessStageStore } from "../src/modules/traceability/demo/us-dataset-trace-readiness-stage";
import { UsDatasetJournalStore } from "../src/modules/traceability/demo/us-dataset-journal";
import { usSixMonthDefinition } from "../src/modules/traceability/demo/us-six-month-definition";
import { specialFixture, specialFault } from "./support/us-dataset-special-fixture";
import { outcome } from "./support/us-transformation-lock-fixture";
import { UsDatasetReferenceSeedStore } from "../src/modules/traceability/demo/us-dataset-reference-seed";
import { UsDatasetReceivingSeedStore } from "../src/modules/traceability/demo/us-dataset-receiving-seed";
import { UsDatasetSpecialChainsSeedStore } from "../src/modules/traceability/demo/us-dataset-special-chains-seed";
import { UsDatasetSpecialSeedStore } from "../src/modules/traceability/demo/us-dataset-special-seed";
import { UsDatasetShippingSeedStore } from "../src/modules/traceability/demo/us-dataset-shipping-seed";
import { UsShippingStore } from "../src/modules/traceability/shipping/us-shipping-store";

describe.skipIf(!process.env.US_TEST_DATABASE_URL)("durable dataset Trace/Readiness stage", () => {
  const h = specialFixture(process.env.US_TEST_DATABASE_URL);
  const journal = () => new UsDatasetJournalStore(h.f.db, usSixMonthDefinition);
  const store = () => new UsDatasetTraceReadinessStageStore(h.f.db);
  async function row(unitKey = "chain_0000") {
    const header = await journal().read(h.context);
    if (!header) throw new Error("Missing owned header");
    return journal().readStage(h.context, header.id, unitKey, "trace_readiness");
  }
  const native = () =>
    new UsDatasetRegularSeedStore(h.f.db).initialize(h.context, { startIndex: 0, count: 1 });

  // A read-only result alone must not masquerade as durable checked progress.
  it(
    "persists actual checked evidence after a native regular chain",
    h.phase(async () => {
      const { f, context } = h;
      await new UsDatasetRegularSeedStore(f.db).initialize(context, { startIndex: 0, count: 1 });
      const stage = new UsDatasetTraceReadinessStageStore(f.db);
      const result = await stage.initialize(context, { kind: "regular", index: 0 });
      const journal = new UsDatasetJournalStore(f.db, usSixMonthDefinition);
      const header = await journal.read(context);
      if (!header) throw new Error("Missing owned header");
      const saved = await journal.readStage(context, header.id, "chain_0000", "trace_readiness");
      expect(saved?.revision).toBe(2);
      expect(saved?.receipt?.result).toEqual(result);
      expect(saved?.receipt?.resultDigest).toBe(canonicalExportDigest(result));
      expect(saved?.receipt?.recordIds).toEqual([
        ...new Set([...result.lotIds, ...result.currentEventIds]),
      ]);
      expect(result.datasetComplete).toBe(false);
      const shipping = await journal.readStage(context, header.id, "chain_0000", "shipping");
      expect(saved?.intent.input).toEqual({
        codec: "us-dataset-trace-readiness-stage-v1",
        datasetId: header.id,
        version: "us-processor-six-month-v1",
        definitionDigest: header.definitionDigest,
        unit: { kind: "regular", index: 0 },
        predecessor: {
          unitKey: "chain_0000",
          stage: "shipping",
          revision: 2,
          operationKey: shipping?.intent.operationKey,
          inputDigest: shipping?.intent.inputDigest,
          resultDigest: shipping?.receipt?.resultDigest,
        },
      });
      const before = await f.snapshot();
      expect(await stage.verify(context, { kind: "regular", index: 0 })).toEqual(result);
      const replay = await stage.initialize(context, { kind: "regular", index: 0 });
      expect(replay).toEqual(result);
      expect(replay).not.toBe(result);
      expect(replay.evidence).not.toBe(result.evidence);
      for (const value of [
        result,
        result.lotIds,
        result.currentEventIds,
        result.evidence,
        ...result.evidence,
      ])
        expect(Object.isFrozen(value)).toBe(true);
      expect(await journal.readStage(context, header.id, "chain_0000", "trace_readiness")).toEqual(
        saved,
      );
      expect(await f.snapshot()).toEqual(before);
    }),
    30000,
  );

  it.each(["fresh", "receiving", "native"])(
    "verify refuses %s prerequisites or missing progress without writing",
    h.phase(async (state) => {
      if (state === "receiving") {
        await new UsDatasetReferenceSeedStore(h.f.db).initialize(h.context);
        await new UsDatasetReceivingSeedStore(h.f.db).initialize(h.context, 0);
      }
      if (state === "native") await native();
      const before = await h.f.snapshot();
      if (state === "native")
        await expect(
          store().verify(h.context, { kind: "regular", index: 0 }),
        ).rejects.toMatchObject({
          message: "us_dataset_trace_readiness_stage_incomplete",
          unitKey: "chain_0000",
          stage: "trace_readiness",
        });
      else
        await expect(store().verify(h.context, { kind: "regular", index: 0 })).rejects.toThrow(
          /incomplete/,
        );
      expect(await h.f.snapshot()).toEqual(before);
    }),
    30000,
  );

  it(
    "retains actual pending intent on driver failure, refuses verify, then resumes its original key",
    h.phase(async () => {
      const { f, context } = h;
      await native();
      const remove = await specialFault(
        f,
        "traceability_demo_dataset_stages",
        "UPDATE",
        "NEW.stage='trace_readiness' AND NEW.receipt IS NOT NULL",
        "40001",
      );
      try {
        const failed = await outcome(store().initialize(context, { kind: "regular", index: 0 }));
        expect(failed.error).toMatchObject({
          cause: { code: "40001", message: "special_sql_fault" },
        });
      } finally {
        await remove();
      }
      const pending = await row();
      expect(pending?.revision).toBe(1);
      expect(pending?.receipt).toBeNull();
      const before = await f.snapshot();
      await expect(store().verify(context, { kind: "regular", index: 0 })).rejects.toMatchObject({
        message: "us_dataset_trace_readiness_stage_incomplete",
        unitKey: "chain_0000",
        stage: "trace_readiness",
      });
      expect(await f.snapshot()).toEqual(before);
      const expected = await new UsDatasetTraceReadinessStore(f.db).verify(context, {
        kind: "regular",
        index: 0,
      });
      expect(await store().initialize(context, { kind: "regular", index: 0 })).toEqual(expected);
      const completed = await row();
      expect(completed?.intent).toEqual(pending?.intent);
      expect(completed?.revision).toBe(2);
      expect(completed?.receipt).toEqual({
        recordIds: [...new Set([...expected.lotIds, ...expected.currentEventIds])],
        result: expected,
        resultDigest: canonicalExportDigest(expected),
      });
    }),
    30000,
  );

  it(
    "reconciles compatible competing captures into one durable operation identity",
    h.phase(async () => {
      const { f, context } = h;
      await native();
      const name = "trace_capture_" + randomUUID().replaceAll("-", "");
      await f.pool.query(
        `CREATE FUNCTION ${name}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.stage='trace_readiness' THEN PERFORM pg_sleep(0.5); END IF; RETURN NEW; END $$`,
      );
      try {
        await f.pool.query(
          `CREATE TRIGGER ${name} BEFORE INSERT ON traceability_demo_dataset_stages FOR EACH ROW EXECUTE FUNCTION ${name}()`,
        );
        const results = await Promise.allSettled([
          store().initialize(context, { kind: "regular", index: 0 }),
          store().initialize(context, { kind: "regular", index: 0 }),
        ]);
        for (const result of results) if (result.status === "rejected") throw result.reason;
        expect(results[0]).toEqual(results[1]);
        const saved = await row();
        expect(saved?.revision).toBe(2);
        expect(
          (
            await f.pool.query(
              "SELECT operation_key,revision FROM traceability_demo_dataset_stages WHERE tenant_id=$1 AND stage='trace_readiness'",
              [context.tenantId],
            )
          ).rows,
        ).toEqual([{ operation_key: saved?.intent.operationKey, revision: 2 }]);
        const before = await f.snapshot();
        await store().initialize(context, { kind: "regular", index: 0 });
        expect(await row()).toEqual(saved);
        expect(await f.snapshot()).toEqual(before);
      } finally {
        try {
          await f.pool.query(`DROP TRIGGER IF EXISTS ${name} ON traceability_demo_dataset_stages`);
        } finally {
          await f.pool.query(`DROP FUNCTION ${name}()`);
        }
      }
    }),
    30000,
  );

  it.each(["selector", "predecessor", "receipt evidence", "receipt IDs"])(
    "rejects incompatible %s without replacing saved progress",
    h.phase(async (kind) => {
      const { f, context } = h;
      await native();
      await store().initialize(context, { kind: "regular", index: 0 });
      const saved = await row();
      if (!saved?.receipt) throw new Error("Missing actual checked receipt");
      if (kind === "selector" || kind === "predecessor") {
        const input = { ...structuredClone(saved.intent.input) };
        if (kind === "selector") input["unit"] = { kind: "regular", index: 1 };
        else
          input["predecessor"] = {
            ...(input["predecessor"] as Record<string, unknown>),
            operationKey: randomUUID(),
          };
        await f.pool.query(
          "UPDATE traceability_demo_dataset_stages SET input=$1,input_digest=$2 WHERE tenant_id=$3 AND unit_key='chain_0000' AND stage='trace_readiness'",
          [JSON.stringify(input), canonicalExportDigest(input), context.tenantId],
        );
      } else {
        const receipt = structuredClone(saved.receipt);
        const result =
          kind === "receipt evidence"
            ? { ...receipt.result, datasetComplete: true }
            : receipt.result;
        const changed = {
          result,
          resultDigest: canonicalExportDigest(result),
          recordIds:
            kind === "receipt IDs" ? [...receipt.recordIds, randomUUID()] : receipt.recordIds,
        };
        await f.pool.query(
          "UPDATE traceability_demo_dataset_stages SET receipt=$1 WHERE tenant_id=$2 AND unit_key='chain_0000' AND stage='trace_readiness'",
          [JSON.stringify(changed), context.tenantId],
        );
      }
      const before = await f.snapshot();
      for (const mode of ["verify", "initialize"] as const)
        await expect(store()[mode](context, { kind: "regular", index: 0 })).rejects.toMatchObject({
          message: "us_dataset_trace_readiness_stage_conflict",
          unitKey: "chain_0000",
          stage: "trace_readiness",
        });
      expect(await f.snapshot()).toEqual(before);
    }),
    30000,
  );

  it(
    "persists correction and orphan bindings including retained void history",
    h.phase(async () => {
      const { f, context } = h;
      await new UsDatasetSpecialChainsSeedStore(f.db).initialize(context);
      const special = new UsDatasetSpecialSeedStore(f.db);
      const correction = await special.verify(context, "correction");
      const orphan = await special.verify(context, "orphan");
      if (correction.stage !== "amend_receiving" || orphan.stage !== "void_receiving")
        throw new Error("Missing native special lifecycle");
      for (const kind of ["correction", "orphan"] as const) {
        const result = await store().initialize(context, { kind });
        const saved = await row(`${kind}_0001`);
        expect(saved?.intent.input["unit"]).toEqual({ kind });
        expect(saved?.intent.input["predecessor"]).toMatchObject({
          unitKey: `${kind}_0001`,
          stage: kind === "orphan" ? "void_receiving" : "shipping",
          revision: 2,
        });
        expect(saved?.receipt?.recordIds).toEqual([
          ...new Set([...result.lotIds, ...result.currentEventIds]),
        ]);
        expect(saved?.receipt?.result).toEqual(result);
        expect(saved?.receipt?.resultDigest).toBe(canonicalExportDigest(result));
        if (kind === "orphan") {
          expect(result.currentEventIds).toEqual([]);
          expect(saved?.receipt?.recordIds).toEqual(orphan.lots.map((lot) => lot.id));
          expect(saved?.receipt?.recordIds).not.toContain(orphan.voided.eventId);
          expect(result.evidence.map((e) => e.originGap)).toEqual([true, true]);
        } else {
          expect(result.currentEventIds).toContain(correction.finalized.eventId);
          expect(result.currentEventIds).not.toContain(correction.predecessor.id);
        }
        const before = await f.snapshot();
        expect(await store().verify(context, { kind })).toEqual(result);
        expect(await store().initialize(context, { kind })).toEqual(result);
        expect(await f.snapshot()).toEqual(before);
      }
    }),
    30000,
  );

  it(
    "denies tenant, original owner, database and actual role before interpreting selectors",
    h.phase(async () => {
      const { f, context } = h;
      await native();
      await store().initialize(context, { kind: "regular", index: 0 });
      const alternate = await f.alternateRole();
      const before = await f.snapshot();
      for (const denied of [
        { ...context, tenantId: randomUUID() },
        { ...context, actorUserId: randomUUID() },
        { ...context, expectedDatabaseName: "markiro_us_dev" },
      ])
        for (const mode of ["initialize", "verify"] as const)
          await expect(store()[mode](denied, { kind: "regular", index: -1 })).rejects.toThrow(
            "us_dataset_target_invalid",
          );
      for (const mode of ["initialize", "verify"] as const)
        await expect(
          new UsDatasetTraceReadinessStageStore(alternate)[mode](context, {
            kind: "regular",
            index: 0,
          }),
        ).rejects.toThrow("us_dataset_target_invalid");
      expect(await f.snapshot()).toEqual(before);
    }),
    30000,
  );

  it(
    "rejects actual Shipping void drift with old completed receipts and performs no repair",
    h.phase(async () => {
      const { f, context } = h;
      await native();
      await store().initialize(context, { kind: "regular", index: 0 });
      const shipping = await new UsDatasetShippingSeedStore(f.db).verify(context, 0);
      const shipment = shipping.shipments[0];
      if (!shipment) throw new Error("Missing native shipment");
      await new UsShippingStore(f.db).void(
        context.tenantId,
        context.actorUserId,
        shipment.finalized.id,
        {
          operationKey: randomUUID(),
          expectedLifecycleVersion: 2,
          reason: "Owned durable evidence drift",
        },
        "owned-durable-drift",
      );
      const before = await f.snapshot();
      for (const mode of ["verify", "initialize"] as const) {
        const expected = await outcome(
          new UsDatasetTraceReadinessStore(f.db).verify(context, { kind: "regular", index: 0 }),
        );
        const actual = await outcome(store()[mode](context, { kind: "regular", index: 0 }));
        expect(actual.error).toMatchObject({
          message: (expected.error as Error).message,
          unitKey: "chain_0000",
          stage: "shipping",
        });
      }
      expect(await f.snapshot()).toEqual(before);
    }),
    30000,
  );
});
