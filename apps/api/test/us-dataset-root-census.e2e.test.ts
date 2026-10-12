import { randomUUID } from "node:crypto";
import { canonicalExportDigest } from "@markiro/domain";
import { describe, expect, it } from "vitest";
import { UsDatasetRegularSeedStore } from "../src/modules/traceability/demo/us-dataset-regular-seed";
import { UsDatasetSpecialChainsSeedStore } from "../src/modules/traceability/demo/us-dataset-special-chains-seed";
import { UsDatasetSpecialSeedStore } from "../src/modules/traceability/demo/us-dataset-special-seed";
import { UsDatasetShippingSeedStore } from "../src/modules/traceability/demo/us-dataset-shipping-seed";
import { UsDatasetCorrectedShippingSeedStore } from "../src/modules/traceability/demo/us-dataset-corrected-shipping-seed";
import { makeUsDatasetNativeAssemblyInput } from "../src/modules/traceability/demo/us-dataset-native-assembly-contract";
import { specialFault, specialFixture } from "./support/us-dataset-special-fixture";
import {
  captureCounterPreservation,
  checkCounterPreservation,
} from "./support/us-dataset-counter-preservation";
import { outcome } from "./support/us-transformation-lock-fixture";

describe.skipIf(!process.env.US_TEST_DATABASE_URL)(
  "native permanent roots and current event census",
  () => {
    const h = specialFixture(process.env.US_TEST_DATABASE_URL);
    // Counting through current pointers loses the voided root; retaining that pointer breaks the orphan witness.
    it(
      "counts the voided orphan as a permanent root with no current event after native fault and resume",
      h.phase(async () => {
        const { f, context } = h;
        const started = performance.now();
        const regular = new UsDatasetRegularSeedStore(f.db);
        const selected = [0, 259].map((startIndex) => ({ startIndex, count: 1 }));
        const regularResults = [];
        for (const range of selected) regularResults.push(await regular.initialize(context, range));
        expect(regularResults.map((result) => result.chains.map((chain) => chain.index))).toEqual([
          [0],
          [259],
        ]);
        expect(regularResults.map((result) => result.chains[0]?.shipmentCount)).toEqual([2, 1]);
        const baseline = await captureCounterPreservation(f.pool);
        expect(baseline.counters.map((row) => [row.table, row.body.sequence])).toEqual([
          ["receiving_counters", 2],
          ["transformation_counters", 2],
          ["shipping_counters", 3],
        ]);
        const tables = (
          await f.pool.query<{ name: string; columns: string[] }>(
            "SELECT c.relname AS name,array_agg(a.attname::text ORDER BY u.ordinality) AS columns FROM pg_index i JOIN pg_class c ON c.oid=i.indrelid JOIN pg_namespace n ON n.oid=c.relnamespace CROSS JOIN LATERAL unnest(i.indkey) WITH ORDINALITY u(attnum,ordinality) JOIN pg_attribute a ON a.attrelid=c.oid AND a.attnum=u.attnum WHERE i.indisprimary AND n.nspname='public' GROUP BY c.relname ORDER BY c.relname",
          )
        ).rows;
        const owned: { name: string; key: string; ids: string[]; digest: string }[] = [];
        for (const { name, columns } of tables) {
          if (name.startsWith("traceability_demo_dataset")) continue;
          expect([name, ...columns].every((value) => /^[a-z_][a-z0-9_]*$/.test(value))).toBe(true);
          const key = `jsonb_build_array(${columns.map((column) => `to_jsonb(t)->'${column}'`).join(",")})::text`;
          const rows = (
            await f.pool.query<{ key: string; body: unknown }>(
              `SELECT ${key} AS key,to_jsonb(t) AS body FROM "${name}" t ORDER BY ${key}`,
            )
          ).rows;
          owned.push({
            name,
            key,
            ids: rows.map((row) => row.key),
            digest: canonicalExportDigest(rows),
          });
        }
        const stages = async () =>
          (
            await f.pool.query(
              "SELECT to_jsonb(t) AS body FROM traceability_demo_dataset_stages t WHERE tenant_id=$1 AND unit_key ~ '^chain_[0-9]{4}$' ORDER BY unit_key,stage",
              [context.tenantId],
            )
          ).rows;
        const regularStages = await stages();
        const special = new UsDatasetSpecialChainsSeedStore(f.db);
        const attempts = "task12_attempts_" + randomUUID().replaceAll("-", "");
        await f.pool.query(`CREATE SEQUENCE ${attempts}`);
        const remove = await specialFault(
          f,
          "traceability_demo_dataset_stages",
          "UPDATE",
          `NEW.unit_key='correction_0001' AND NEW.stage='receiving' AND NEW.receipt IS NOT NULL AND nextval('${attempts}')>0`,
          "40001",
        );
        try {
          const failed = await outcome(special.initialize(context));
          expect(failed.error).toMatchObject({
            cause: { code: "40001", message: "special_sql_fault" },
            unitKey: "correction_0001",
            stage: "amend_receiving",
          });
          expect((await f.pool.query(`SELECT last_value::int AS n FROM ${attempts}`)).rows).toEqual(
            [{ n: 1 }],
          );
          expect(await captureCounterPreservation(f.pool)).toEqual(baseline);
          expect(
            (
              await f.pool.query(
                "SELECT revision,receipt FROM traceability_demo_dataset_stages WHERE tenant_id=$1 AND unit_key='correction_0001' AND stage='receiving'",
                [context.tenantId],
              )
            ).rows,
          ).toEqual([{ revision: 1, receipt: null }]);
          expect(
            (
              await f.pool.query(
                "SELECT count(*)::int AS n FROM traceability_demo_dataset_stages WHERE tenant_id=$1 AND unit_key='orphan_0001'",
                [context.tenantId],
              )
            ).rows,
          ).toEqual([{ n: 0 }]);
          const stopped = await f.snapshot();
          await expect(special.verify(context)).rejects.toThrow(/incomplete/);
          expect(await f.snapshot()).toEqual(stopped);
        } finally {
          try {
            await remove();
          } finally {
            await f.pool.query(`DROP SEQUENCE ${attempts}`);
          }
        }
        const result = await special.initialize(context);
        const expectedDigests = await checkCounterPreservation(f.pool, baseline, context.tenantId);
        const resumed = await captureCounterPreservation(f.pool);
        expect(resumed.roots.length - baseline.roots.length).toBe(4);
        expect(resumed.counters.map((row) => [row.table, row.body.sequence])).toEqual([
          ["receiving_counters", 4],
          ["transformation_counters", 3],
          ["shipping_counters", 4],
        ]);
        expect(await stages()).toEqual(regularStages);
        for (const table of owned) {
          const rows = (
            await f.pool.query<{ key: string; body: unknown }>(
              `SELECT ${table.key} AS key,to_jsonb(t) AS body FROM "${table.name}" t WHERE ${table.key}=ANY($1::text[]) ORDER BY ${table.key}`,
              [table.ids],
            )
          ).rows;
          expect(
            rows.map((row) => row.key),
            table.name,
          ).toEqual(table.ids);
          expect(canonicalExportDigest(rows), table.name).toBe(
            expectedDigests.get(table.name) ?? table.digest,
          );
        }
        const roots =
          "WITH roots AS (SELECT tenant_id,id,current_event_id FROM receiving_event_roots UNION ALL SELECT tenant_id,id,current_event_id FROM transformation_event_roots UNION ALL SELECT tenant_id,id,current_event_id FROM shipping_event_roots) ";
        const physical = (
          await f.pool.query(
            roots +
              "SELECT e.type,count(*)::int AS n FROM roots r JOIN traceability_events e ON e.tenant_id=r.tenant_id AND e.id=r.id WHERE r.tenant_id=$1 GROUP BY e.type ORDER BY e.type",
            [context.tenantId],
          )
        ).rows;
        const current = (
          await f.pool.query(
            roots +
              "SELECT e.type,count(*)::int AS n FROM roots r JOIN traceability_events e ON e.tenant_id=r.tenant_id AND e.id=r.current_event_id WHERE r.tenant_id=$1 GROUP BY e.type ORDER BY e.type",
            [context.tenantId],
          )
        ).rows;
        expect(physical).toEqual([
          { type: "receiving", n: 4 },
          { type: "shipping", n: 4 },
          { type: "transformation", n: 3 },
        ]);
        expect(current).toEqual([
          { type: "receiving", n: 3 },
          { type: "shipping", n: 4 },
          { type: "transformation", n: 3 },
        ]);
        const counts = (
          await f.pool.query(
            roots +
              "SELECT (SELECT count(*)::int FROM roots WHERE tenant_id=$1) roots,(SELECT count(*)::int FROM roots r JOIN traceability_events e ON e.tenant_id=r.tenant_id AND e.id=r.current_event_id WHERE r.tenant_id=$1 AND e.status='finalized') finalized,(SELECT count(*)::int FROM traceability_lots WHERE tenant_id=$1) lots,(SELECT count(DISTINCT b.id)::int FROM boxes b JOIN traceability_synthetic_case_origins o ON o.tenant_id=b.tenant_id AND o.box_id=b.id WHERE b.tenant_id=$1) boxes",
            [context.tenantId],
          )
        ).rows;
        expect(counts).toEqual([{ roots: 11, finalized: 10, lots: 11, boxes: 215 }]);
        expect(
          (
            await f.pool.query(
              roots +
                "SELECT count(*)::int AS n FROM roots r JOIN traceability_events e ON e.tenant_id=r.tenant_id AND e.id=r.id WHERE r.tenant_id=$1 AND (e.revision<>1 OR e.root_event_id<>r.id)",
              [context.tenantId],
            )
          ).rows,
        ).toEqual([{ n: 0 }]);
        expect(
          (
            await f.pool.query(
              roots +
                "SELECT e.status,count(*)::int AS n FROM roots r JOIN traceability_events e ON e.tenant_id=r.tenant_id AND e.id=r.current_event_id WHERE r.tenant_id=$1 GROUP BY e.status",
              [context.tenantId],
            )
          ).rows,
        ).toEqual([{ status: "finalized", n: 10 }]);
        expect(result).toMatchObject({
          state: "special_chains_shipping_verified",
          datasetComplete: false,
          correction: { shipmentCount: 1 },
          orphan: { unitKey: "orphan_0001" },
        });
        expect(
          (
            await f.pool.query(
              "SELECT count(*)::int AS n FROM traceability_demo_dataset_stages WHERE tenant_id=$1 AND (receipt IS NULL OR stage='trace_readiness' OR unit_key IN ('plan','request'))",
              [context.tenantId],
            )
          ).rows,
        ).toEqual([{ n: 0 }]);
        expect(
          (
            await f.pool.query(
              "SELECT (SELECT count(*)::int FROM traceability_plan_versions WHERE tenant_id=$1) AS plans,(SELECT count(*)::int FROM trace_requests WHERE tenant_id=$1) AS requests",
              [context.tenantId],
            )
          ).rows,
        ).toEqual([{ plans: 0, requests: 0 }]);
        for (const [position, index] of [0, 259].entries()) {
          const actual = await new UsDatasetShippingSeedStore(f.db).verify(context, index);
          expect(regularResults[position]?.chains[0]?.shippingResultDigest).toBe(
            canonicalExportDigest(actual),
          );
          if (index === 259) {
            expect(
              actual.shipments.map((value) => value.finalized.snapshot.items[0]?.quantity),
            ).toEqual(["100"]);
            expect(
              (
                await f.pool.query(
                  "SELECT count(*)::int AS n FROM trace_lot_boxes l JOIN boxes b ON b.tenant_id=l.tenant_id AND b.id=l.box_id JOIN traceability_synthetic_case_origins o ON o.tenant_id=b.tenant_id AND o.box_id=b.id WHERE l.tenant_id=$1 AND l.lot_id=$2",
                  [context.tenantId, actual.outputLotAfter.id],
                )
              ).rows,
            ).toEqual([{ n: 100 }]);
          }
        }
        const correctedShipping = await new UsDatasetCorrectedShippingSeedStore(f.db).verify(
          context,
        );
        expect(result.correction.shippingResultDigest).toBe(
          canonicalExportDigest(correctedShipping),
        );
        const lifecycle = new UsDatasetSpecialSeedStore(f.db);
        const correction = await lifecycle.verify(context, "correction");
        const orphan = await lifecycle.verify(context, "orphan");
        expect(result.correction.lifecycleResultDigest).toBe(canonicalExportDigest(correction));
        expect(result.orphan.lifecycleResultDigest).toBe(canonicalExportDigest(orphan));
        if (
          correction.stage !== "amend_receiving" ||
          correction.finalized.record.content.kind !== "finalized" ||
          correction.original.finalized.record.content.kind !== "finalized" ||
          orphan.stage !== "void_receiving"
        )
          throw new Error("Unexpected actual lifecycle");
        expect(correction.finalized.record.revision).toBe(2);
        expect(
          correction.original.finalized.record.content.snapshot.items.map(
            (value) => value.quantity,
          ),
        ).toEqual(["250", "400"]);
        expect(
          correction.finalized.record.content.snapshot.items.map((value) => value.quantity),
        ).toEqual(["300", "400"]);
        expect(orphan.voided.record.status).toBe("void");
        expect(orphan.lots.map((value) => [value.id, value.status, value.sourceLockedAt])).toEqual(
          orphan.original.lots.map((value) => [value.id, value.status, value.sourceLockedAt]),
        );
        const orphanRoot = (
          await f.pool.query(
            "SELECT r.id,r.current_event_id,r.pending_draft_id,e.id AS latest_id,e.status AS latest_status,e.revision AS latest_revision FROM receiving_event_roots r JOIN LATERAL (SELECT id,status,revision FROM traceability_events WHERE tenant_id=r.tenant_id AND root_event_id=r.id ORDER BY revision DESC LIMIT 1) e ON true WHERE r.tenant_id=$1 AND r.id=$2",
            [context.tenantId, orphan.original.finalized.eventId],
          )
        ).rows;
        expect(orphanRoot).toEqual([
          {
            id: orphan.original.finalized.eventId,
            current_event_id: null,
            pending_draft_id: null,
            latest_id: orphan.voided.eventId,
            latest_status: "void",
            latest_revision: 1,
          },
        ]);
        const components = [
          result,
          result.correction,
          result.orphan,
          ...regularResults.flatMap((value) => [value, value.range, value.chains, ...value.chains]),
        ];
        for (const component of components) expect(Object.isFrozen(component)).toBe(true);
        const actualComponentBytes = Buffer.byteLength(
          JSON.stringify({ regularResults, special: result }),
        );
        expect(actualComponentBytes).toBeLessThan(256 * 1024);
        for (const actualRegular of regularResults)
          expect(() => makeUsDatasetNativeAssemblyInput(actualRegular, result)).toThrow(
            "us_dataset_native_assembly_input_invalid",
          );
        const settled = await f.snapshot();
        expect(Object.keys(settled)).toHaveLength(198);
        for (const mode of ["verify", "initialize"] as const) {
          expect(await special[mode](context)).toEqual(result);
          expect(await f.snapshot()).toEqual(settled);
          for (const [position, range] of selected.entries()) {
            expect(await regular[mode](context, range)).toEqual(regularResults[position]);
            expect(await f.snapshot()).toEqual(settled);
          }
        }
        const changed = await f.pool.query(
          "UPDATE reference_documents SET notes='Owned native drift' WHERE tenant_id=$1",
          [context.tenantId],
        );
        expect(changed.rowCount).toBeGreaterThan(0);
        const drift = await f.snapshot();
        const driftFailures = [];
        for (const mode of ["verify", "initialize"] as const) {
          for (const range of selected) {
            const failed = await outcome(regular[mode](context, range));
            expect(failed.error).toMatchObject({
              message: "us_dataset_cases_mismatch",
              unitKey: range.startIndex === 0 ? "chain_0000" : "chain_0259",
              stage: "shipping",
            });
            driftFailures.push({
              store: "regular",
              mode,
              index: range.startIndex,
              message: failed.error instanceof Error ? failed.error.message : "unexpected",
            });
            expect(await f.snapshot()).toEqual(drift);
          }
          const failed = await outcome(special[mode](context));
          expect(failed.error).toBeInstanceOf(Error);
          expect(failed.error instanceof Error && failed.error.message).toMatch(
            /^us_dataset_.*_mismatch$/,
          );
          driftFailures.push({
            store: "special",
            mode,
            message: failed.error instanceof Error ? failed.error.message : "unexpected",
          });
          expect(await f.snapshot()).toEqual(drift);
        }
        console.info("Native permanent and current root census verified", {
          actualRegularIndices: [0, 259],
          faultAttempts: 1,
          newRoots: 4,
          primaryKeyTables: owned.length,
          counterTables: expectedDigests.size,
          physical,
          current,
          counts,
          orphanRoot,
          actualComponentBytes,
          hashedTables: Object.keys(settled).length,
          driftChangedRows: changed.rowCount,
          driftFailures,
          elapsedMs: performance.now() - started,
          limitation:
            "No native full result or full260 execution; native drift namespace inspected in Task8 boundary source only",
        });
      }),
      60_000,
    );
  },
);
