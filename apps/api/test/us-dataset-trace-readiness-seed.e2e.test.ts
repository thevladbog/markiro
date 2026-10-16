import { canonicalExportDigest } from "@markiro/domain";
import { describe, expect, it } from "vitest";
import { UsDatasetTraceReadinessSeedStore } from "../src/modules/traceability/demo/us-dataset-trace-readiness-seed";
import { UsDatasetTraceReadinessStageStore } from "../src/modules/traceability/demo/us-dataset-trace-readiness-stage";
import { UsDatasetRegularSeedStore } from "../src/modules/traceability/demo/us-dataset-regular-seed";
import { UsDatasetReferenceSeedStore } from "../src/modules/traceability/demo/us-dataset-reference-seed";
import { specialFixture, specialFault } from "./support/us-dataset-special-fixture";
import { outcome } from "./support/us-transformation-lock-fixture";
import { assertUsValidationPhaseBudgets } from "./support/us-validation-phase-budgets";

describe.skipIf(!process.env.US_TEST_DATABASE_URL)(
  "complete durable dataset Trace/Readiness composition",
  () => {
    const h = specialFixture(process.env.US_TEST_DATABASE_URL);
    const store = () => new UsDatasetTraceReadinessSeedStore(h.f.db);

    // Changing verify to initialize must never populate missing native units or evidence.
    it.each(["fresh", "references", "first chain"])(
      "verify refuses %s without installing prerequisites",
      h.phase(async (state) => {
        if (state === "references")
          await new UsDatasetReferenceSeedStore(h.f.db).initialize(h.context);
        if (state === "first chain")
          await new UsDatasetRegularSeedStore(h.f.db).initialize(h.context, {
            startIndex: 0,
            count: 1,
          });
        const before = await h.f.snapshot();
        await expect(store().verify(h.context)).rejects.toThrow(/incomplete/);
        expect(await h.f.snapshot()).toEqual(before);
      }),
      30000,
    );

    // A shortened range, receipt-only verification, swallowed SQL failure, or write-on-replay
    // must fail against all native roots, journals and full-table hashes in one actual fixture.
    it(
      "retains real partial progress, resumes all 262 units, verifies and replays without writes",
      h.phase(async () => {
        const { f, context } = h;
        const coordinator = store();
        const started = performance.now();
        console.info("Complete durable Trace/Readiness phase", { phase: "fault_setup_started" });
        const remove = await specialFault(
          f,
          "traceability_demo_dataset_stages",
          "UPDATE",
          "NEW.unit_key='chain_0001' AND NEW.stage='trace_readiness' AND NEW.receipt IS NOT NULL",
          "40001",
        );
        let failedMs: number;
        try {
          console.info("Complete durable Trace/Readiness phase", {
            phase: "faulted_generation_started",
            totalMs: performance.now() - started,
          });
          const failed = await outcome(coordinator.initialize(context));
          failedMs = performance.now() - started;
          console.info("Complete durable Trace/Readiness phase", {
            phase: "faulted_generation_returned",
            totalMs: failedMs,
          });
          expect(failed.error).toMatchObject({
            cause: { code: "40001", message: "special_sql_fault" },
          });
          expect(
            (
              await f.pool.query(
                "SELECT unit_key,revision,receipt IS NOT NULL AS completed FROM traceability_demo_dataset_stages WHERE tenant_id=$1 AND stage='trace_readiness' ORDER BY unit_key",
                [context.tenantId],
              )
            ).rows,
          ).toEqual([
            { unit_key: "chain_0000", revision: 2, completed: true },
            { unit_key: "chain_0001", revision: 1, completed: false },
          ]);
        } finally {
          await remove();
        }
        console.info("Complete durable Trace/Readiness phase", {
          phase: "partial_progress_verification_started",
          totalMs: performance.now() - started,
        });
        const stopped = await f.snapshot();
        await expect(coordinator.verify(context)).rejects.toMatchObject({
          message: "us_dataset_trace_readiness_stage_incomplete",
          unitKey: "chain_0001",
          stage: "trace_readiness",
        });
        expect(await f.snapshot()).toEqual(stopped);
        const pending = (
          await f.pool.query(
            "SELECT operation_key,input_digest,input FROM traceability_demo_dataset_stages WHERE tenant_id=$1 AND unit_key='chain_0001' AND stage='trace_readiness'",
            [context.tenantId],
          )
        ).rows;
        console.info("Complete durable Trace/Readiness phase", {
          phase: "all_units_resume_started",
          totalMs: performance.now() - started,
        });
        const resumeStarted = performance.now();
        const result = await coordinator.initialize(context);
        const resumeMs = performance.now() - resumeStarted;
        console.info("Complete durable Trace/Readiness phase", {
          phase: "all_units_resume_returned",
          phaseMs: resumeMs,
          totalMs: performance.now() - started,
          units: result.units.length,
        });
        expect(
          (
            await f.pool.query(
              "SELECT operation_key,input_digest,input FROM traceability_demo_dataset_stages WHERE tenant_id=$1 AND unit_key='chain_0001' AND stage='trace_readiness'",
              [context.tenantId],
            )
          ).rows,
        ).toEqual(pending);
        expect(result).toMatchObject({
          state: "native_chains_trace_readiness_verified",
          datasetComplete: false,
          native: { state: "native_chains_shipping_verified", datasetComplete: false },
        });
        expect(result.units.map((unit) => unit.unitKey)).toEqual([
          ...Array.from({ length: 260 }, (_, i) => `chain_${String(i).padStart(4, "0")}`),
          "correction_0001",
          "orphan_0001",
        ]);
        const completed = await f.pool.query<{ unit_key: string; result_digest: string }>(
          "SELECT unit_key,receipt->>'resultDigest' AS result_digest FROM traceability_demo_dataset_stages WHERE tenant_id=$1 AND stage='trace_readiness' AND revision=2 AND receipt IS NOT NULL ORDER BY unit_key",
          [context.tenantId],
        );
        expect(completed.rows).toHaveLength(262);
        expect(completed.rows).toEqual(
          result.units.map((unit) => ({
            unit_key: unit.unitKey,
            result_digest: unit.resultDigest,
          })),
        );
        console.info("Complete durable Trace/Readiness phase", {
          phase: "boundary_unit_verification_started",
          totalMs: performance.now() - started,
          completedStages: completed.rows.length,
        });
        for (const unit of [
          { kind: "regular", index: 0 },
          { kind: "regular", index: 259 },
          { kind: "correction" },
          { kind: "orphan" },
        ] as const) {
          const checked = await new UsDatasetTraceReadinessStageStore(f.db).verify(context, unit);
          expect(result.units.find((row) => row.unitKey === checked.unitKey)?.resultDigest).toBe(
            canonicalExportDigest(checked),
          );
        }
        console.info("Complete durable Trace/Readiness phase", {
          phase: "boundary_unit_verification_completed",
          totalMs: performance.now() - started,
        });
        expect(
          (
            await f.pool.query(
              "WITH roots AS (SELECT tenant_id,current_event_id FROM receiving_event_roots UNION ALL SELECT tenant_id,current_event_id FROM transformation_event_roots UNION ALL SELECT tenant_id,current_event_id FROM shipping_event_roots) SELECT (SELECT count(*)::int FROM roots WHERE tenant_id=$1) roots,(SELECT count(*)::int FROM roots r JOIN traceability_events e ON e.tenant_id=r.tenant_id AND e.id=r.current_event_id WHERE r.tenant_id=$1 AND e.status='finalized') finalized,(SELECT count(*)::int FROM traceability_lots WHERE tenant_id=$1) lots,(SELECT count(DISTINCT b.id)::int FROM boxes b JOIN traceability_synthetic_case_origins o ON o.tenant_id=b.tenant_id AND o.box_id=b.id WHERE b.tenant_id=$1) boxes",
              [context.tenantId],
            )
          ).rows,
        ).toEqual([{ roots: 964, finalized: 963, lots: 785, boxes: 15700 }]);
        expect(
          (
            await f.pool.query(
              "SELECT (SELECT count(*)::int FROM traceability_plan_versions WHERE tenant_id=$1) plans,(SELECT count(*)::int FROM trace_requests WHERE tenant_id=$1) requests,(SELECT count(*)::int FROM traceability_demo_dataset_stages WHERE tenant_id=$1 AND (receipt IS NULL OR stage IN ('plan','request','package'))) incomplete_or_later",
              [context.tenantId],
            )
          ).rows,
        ).toEqual([{ plans: 0, requests: 0, incomplete_or_later: 0 }]);
        for (const value of [
          result,
          result.units,
          ...result.units,
          result.native,
          result.native.regular,
          result.native.regular.range,
          result.native.regular.chains,
          ...result.native.regular.chains,
          result.native.special,
          result.native.special.correction,
          result.native.special.orphan,
        ])
          expect(Object.isFrozen(value)).toBe(true);
        expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(256 * 1024);
        console.info("Complete durable Trace/Readiness phase", {
          phase: "full_table_baseline_started",
          totalMs: performance.now() - started,
        });
        const before = await f.snapshot();
        const verifyStarted = performance.now();
        console.info("Complete durable Trace/Readiness phase", {
          phase: "completed_verification_started",
          totalMs: verifyStarted - started,
        });
        expect(await coordinator.verify(context)).toEqual(result);
        const verifyMs = performance.now() - verifyStarted;
        console.info("Complete durable Trace/Readiness phase", {
          phase: "completed_verification_returned",
          phaseMs: verifyMs,
          totalMs: performance.now() - started,
        });
        expect(await f.snapshot()).toEqual(before);
        const replayStarted = performance.now();
        console.info("Complete durable Trace/Readiness phase", {
          phase: "completed_replay_started",
          totalMs: replayStarted - started,
        });
        const replay = await coordinator.initialize(context);
        const replayMs = performance.now() - replayStarted;
        console.info("Complete durable Trace/Readiness phase", {
          phase: "completed_replay_returned",
          phaseMs: replayMs,
          totalMs: performance.now() - started,
        });
        expect(replay).toEqual(result);
        expect(replay).not.toBe(result);
        expect(replay.units).not.toBe(result.units);
        expect(await f.snapshot()).toEqual(before);
        console.info("Complete durable Trace/Readiness phase", {
          phase: "full_table_replay_no_write_completed",
          totalMs: performance.now() - started,
        });
        console.info("Complete durable Trace/Readiness measurements", {
          failedGenerationMs: failedMs,
          resumeMs,
          verifyMs,
          replayMs,
          totalMs: performance.now() - started,
          tables: Object.keys(before).length,
          snapshotDigest: canonicalExportDigest(before),
          processPeakRssKiB: process.resourceUsage().maxRSS,
        });
        console.info("Complete durable Trace/Readiness independent phase budgets", {
          ...assertUsValidationPhaseBudgets(
            performance.now() - started,
            [resumeMs],
            900000,
            900000,
          ),
        });
      }),
      1800000,
    );
  },
);
