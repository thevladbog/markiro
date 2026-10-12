import { randomUUID } from "node:crypto";
import { canonicalExportDigest } from "@markiro/domain";
import { describe, expect, it } from "vitest";
import { UsDatasetNativeSeedStore } from "../src/modules/traceability/demo/us-dataset-native-seed";
import { UsDatasetRegularSeedStore } from "../src/modules/traceability/demo/us-dataset-regular-seed";
import { UsDatasetReferenceSeedStore } from "../src/modules/traceability/demo/us-dataset-reference-seed";
import { UsDatasetShippingSeedStore } from "../src/modules/traceability/demo/us-dataset-shipping-seed";
import { UsDatasetCorrectedShippingSeedStore } from "../src/modules/traceability/demo/us-dataset-corrected-shipping-seed";
import { UsDatasetSpecialSeedStore } from "../src/modules/traceability/demo/us-dataset-special-seed";
import { outcome } from "./support/us-transformation-lock-fixture";
import { specialFault, specialFixture } from "./support/us-dataset-special-fixture";
import {
  captureCounterPreservation,
  checkCounterPreservation,
} from "./support/us-dataset-counter-preservation";

describe.skipIf(!process.env.US_TEST_DATABASE_URL)("actual full native dataset coordinator", () => {
  const h = specialFixture(process.env.US_TEST_DATABASE_URL);
  const seed = () => new UsDatasetNativeSeedStore(h.f.db);
  const primaryKeys = () =>
    h.f.pool.query<{ name: string; columns: string[] }>(
      "SELECT c.relname AS name, array_agg(a.attname::text ORDER BY u.ordinality) AS columns FROM pg_index i JOIN pg_class c ON c.oid=i.indrelid JOIN pg_namespace n ON n.oid=c.relnamespace CROSS JOIN LATERAL unnest(i.indkey) WITH ORDINALITY u(attnum,ordinality) JOIN pg_attribute a ON a.attrelid=c.oid AND a.attnum=u.attnum WHERE i.indisprimary AND n.nspname='public' GROUP BY c.relname ORDER BY c.relname",
    );

  // A name[] result silently typed as string[] would break preservation after costly generation.
  it(
    "reads actual primary-key column arrays before full native generation",
    h.phase(async () => {
      const tables = await primaryKeys();
      expect(tables.rows.find((v) => v.name === "traceability_events")?.columns).toEqual(["id"]);
      expect(tables.rows.every((v) => Array.isArray(v.columns))).toBe(true);
    }),
    30_000,
  );

  // Mutating verify into initialize would install references or missing chains.
  it.each(["fresh", "references", "first chain"])(
    "verify rejects %s state without installing any prerequisite",
    h.phase(async (state) => {
      if (state === "references")
        await new UsDatasetReferenceSeedStore(h.f.db).initialize(h.context);
      if (state === "first chain")
        await new UsDatasetRegularSeedStore(h.f.db).initialize(h.context, {
          startIndex: 0,
          count: 1,
        });
      const before = await h.f.snapshot();
      await expect(seed().verify(h.context)).rejects.toThrow(/incomplete/);
      expect(await h.f.snapshot()).toEqual(before);
    }),
    30_000,
  );

  // Omitting the initial current target proof would allow writes after owner revocation.
  it.each(["owner", "membership", "builtin role", "database", "tenant", "provenance"])(
    "both modes deny actual changed %s and preserve every table hash",
    h.phase(async (kind) => {
      let db = h.f.db;
      if (kind === "owner")
        await h.f.pool.query('UPDATE "user" SET name=$1 WHERE id=$2', [
          "changed owner",
          h.context.actorUserId,
        ]);
      if (kind === "membership")
        await h.f.pool.query("UPDATE member SET role='viewer' WHERE user_id=$1", [
          h.context.actorUserId,
        ]);
      if (kind === "builtin role") db = await h.f.alternateRole();
      if (kind === "provenance")
        await h.f.pool.query(
          "UPDATE tenant_audit_events SET outcome='failure' WHERE organization_id=$1 AND action='us.development.owner.provisioned'",
          [h.context.tenantId],
        );
      const context = {
        ...h.context,
        ...(kind === "database" ? { expectedDatabaseName: "wrong_db" } : {}),
        ...(kind === "tenant" ? { tenantId: randomUUID() } : {}),
      };
      const before = await h.f.snapshot();
      const coordinator = new UsDatasetNativeSeedStore(db);
      await expect(coordinator.initialize(context)).rejects.toThrow("us_dataset_target_invalid");
      await expect(coordinator.verify(context)).rejects.toThrow("us_dataset_target_invalid");
      expect(await h.f.snapshot()).toEqual(before);
    }),
    30_000,
  );

  // A shortened range, parallel special execution, outer rollback/retry, fabricated proof,
  // repair-on-verify or swallowed driver error breaks independent native facts here.
  it(
    "commits all regular chains before one special SQL failure, explicitly resumes, then rejects drift",
    h.phase(async () => {
      const { f, context } = h;
      const coordinator = seed();
      const tables = await primaryKeys();
      expect(tables.rows.find((v) => v.name === "traceability_events")?.columns).toEqual(["id"]);
      expect(tables.rows.every((v) => Array.isArray(v.columns))).toBe(true);
      const attempts = "native_attempts_" + randomUUID().replaceAll("-", "");
      await f.pool.query(`CREATE SEQUENCE ${attempts}`);
      const remove = await specialFault(
        f,
        "traceability_demo_dataset_stages",
        "UPDATE",
        `NEW.unit_key='correction_0001' AND NEW.stage='receiving' AND NEW.receipt IS NOT NULL AND nextval('${attempts}')>0`,
        "40001",
      );
      const started = performance.now();
      try {
        const failed = await outcome(coordinator.initialize(context));
        expect(failed.error).toMatchObject({
          cause: { code: "40001", message: "special_sql_fault" },
          unitKey: "correction_0001",
          stage: "amend_receiving",
        });
        expect((await f.pool.query(`SELECT last_value::int AS n FROM ${attempts}`)).rows).toEqual([
          { n: 1 },
        ]);
        expect(
          (
            await f.pool.query(
              "SELECT count(*)::int AS n FROM traceability_demo_dataset_stages WHERE tenant_id=$1 AND unit_key ~ '^chain_[0-9]{4}$' AND stage='shipping' AND receipt IS NOT NULL",
              [context.tenantId],
            )
          ).rows,
        ).toEqual([{ n: 260 }]);
        expect(
          (
            await f.pool.query(
              "SELECT revision, receipt FROM traceability_demo_dataset_stages WHERE tenant_id=$1 AND unit_key='correction_0001' AND stage='receiving'",
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
        expect(
          (
            await f.pool.query(
              "SELECT count(*)::int AS n FROM receiving_event_roots WHERE tenant_id=$1",
              [context.tenantId],
            )
          ).rows,
        ).toEqual([{ n: 260 }]);
        const stopped = await f.snapshot();
        await expect(coordinator.verify(context)).rejects.toThrow(/incomplete/);
        expect(await f.snapshot()).toEqual(stopped);
      } finally {
        try {
          await remove();
        } finally {
          await f.pool.query(`DROP SEQUENCE ${attempts}`);
        }
      }
      const generationMs = performance.now() - started;

      // Keep actual primary-key identities of every already-committed row. New special
      // rows are excluded, while any mutation/removal of the regular rows is detected.
      const owned: { name: string; key: string; ids: string[]; digest: string }[] = [];
      for (const { name, columns } of tables.rows) {
        if (name.startsWith("traceability_demo_dataset")) continue;
        if (![name, ...columns].every((v) => /^[a-z_][a-z0-9_]*$/.test(v)))
          throw new Error("Unsafe fixture identifier");
        const key = `jsonb_build_array(${columns.map((v) => `to_jsonb(t)->'${v}'`).join(",")})::text`;
        const rows = await f.pool.query<{ key: string; body: unknown }>(
          `SELECT ${key} AS key,to_jsonb(t) AS body FROM "${name}" t ORDER BY ${key}`,
        );
        owned.push({
          name,
          key,
          ids: rows.rows.map((r) => r.key),
          digest: canonicalExportDigest(rows.rows),
        });
      }
      const regularStages = async () =>
        canonicalExportDigest(
          (
            await f.pool.query(
              "SELECT to_jsonb(t) AS body FROM traceability_demo_dataset_stages t WHERE tenant_id=$1 AND unit_key ~ '^chain_[0-9]{4}$' ORDER BY unit_key,stage",
              [context.tenantId],
            )
          ).rows,
        );
      const regularStageDigest = await regularStages();
      const counterBaseline = await captureCounterPreservation(f.pool);
      const resumeStarted = performance.now();
      const result = await coordinator.initialize(context);
      const resumeMs = performance.now() - resumeStarted;
      expect(await regularStages()).toBe(regularStageDigest);
      const counterExpectedDigests = await checkCounterPreservation(
        f.pool,
        counterBaseline,
        context.tenantId,
      );
      for (const table of owned) {
        const rows = await f.pool.query(
          `SELECT ${table.key} AS key,to_jsonb(t) AS body FROM "${table.name}" t WHERE ${table.key}=ANY($1::text[]) ORDER BY ${table.key}`,
          [table.ids],
        );
        const counterExpectedDigest = counterExpectedDigests.get(table.name);
        if (counterExpectedDigest !== undefined)
          expect(canonicalExportDigest(rows.rows), table.name).toBe(counterExpectedDigest);
        else expect(canonicalExportDigest(rows.rows), table.name).toBe(table.digest);
      }

      const counts = await f.pool.query(
        "WITH roots AS (SELECT tenant_id,current_event_id FROM receiving_event_roots UNION ALL SELECT tenant_id,current_event_id FROM transformation_event_roots UNION ALL SELECT tenant_id,current_event_id FROM shipping_event_roots) SELECT (SELECT count(*)::int FROM roots WHERE tenant_id=$1) roots,(SELECT count(*)::int FROM roots r JOIN traceability_events e ON e.tenant_id=r.tenant_id AND e.id=r.current_event_id WHERE r.tenant_id=$1 AND e.status='finalized') finalized,(SELECT count(*)::int FROM traceability_lots WHERE tenant_id=$1) lots,(SELECT count(DISTINCT b.id)::int FROM boxes b JOIN traceability_synthetic_case_origins o ON o.tenant_id=b.tenant_id AND o.box_id=b.id WHERE b.tenant_id=$1) boxes",
        [context.tenantId],
      );
      expect(counts.rows).toEqual([{ roots: 964, finalized: 963, lots: 785, boxes: 15700 }]);
      expect(
        (
          await f.pool.query(
            "WITH roots AS (SELECT tenant_id,id FROM receiving_event_roots UNION ALL SELECT tenant_id,id FROM transformation_event_roots UNION ALL SELECT tenant_id,id FROM shipping_event_roots) SELECT e.type,count(*)::int AS n FROM roots r JOIN traceability_events e ON e.tenant_id=r.tenant_id AND e.id=r.id WHERE r.tenant_id=$1 GROUP BY e.type ORDER BY e.type",
            [context.tenantId],
          )
        ).rows,
      ).toEqual([
        { type: "receiving", n: 262 },
        { type: "shipping", n: 441 },
        { type: "transformation", n: 261 },
      ]);
      expect(
        (
          await f.pool.query(
            "WITH roots AS (SELECT tenant_id,current_event_id FROM receiving_event_roots UNION ALL SELECT tenant_id,current_event_id FROM transformation_event_roots UNION ALL SELECT tenant_id,current_event_id FROM shipping_event_roots) SELECT e.type,e.status,count(*)::int AS n FROM roots r JOIN traceability_events e ON e.tenant_id=r.tenant_id AND e.id=r.current_event_id WHERE r.tenant_id=$1 GROUP BY e.type,e.status ORDER BY e.type,e.status",
            [context.tenantId],
          )
        ).rows,
      ).toEqual([
        { type: "receiving", status: "finalized", n: 261 },
        { type: "shipping", status: "finalized", n: 441 },
        { type: "transformation", status: "finalized", n: 261 },
      ]);
      expect(result).toMatchObject({
        state: "native_chains_shipping_verified",
        datasetComplete: false,
        regular: { range: { startIndex: 0, count: 260 } },
        special: { correction: { shipmentCount: 1 }, orphan: { unitKey: "orphan_0001" } },
      });
      expect(result.regular.chains.map((v) => v.index)).toEqual(
        Array.from({ length: 260 }, (_, i) => i),
      );
      expect(result.regular.chains.reduce((n, v) => n + v.shipmentCount, 0)).toBe(440);
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
      for (const index of [0, 259]) {
        const actual = await new UsDatasetShippingSeedStore(f.db).verify(context, index);
        expect(result.regular.chains[index]?.shippingResultDigest).toBe(
          canonicalExportDigest(actual),
        );
        if (index === 259) {
          expect(actual.shipments.map((v) => v.finalized.snapshot.items[0]?.quantity)).toEqual([
            "100",
          ]);
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
      const correctedShipping = await new UsDatasetCorrectedShippingSeedStore(f.db).verify(context);
      expect(result.special.correction.shippingResultDigest).toBe(
        canonicalExportDigest(correctedShipping),
      );
      const lifecycle = new UsDatasetSpecialSeedStore(f.db);
      const correction = await lifecycle.verify(context, "correction");
      const orphan = await lifecycle.verify(context, "orphan");
      expect(result.special.correction.lifecycleResultDigest).toBe(
        canonicalExportDigest(correction),
      );
      expect(result.special.orphan.lifecycleResultDigest).toBe(canonicalExportDigest(orphan));
      if (
        correction.stage !== "amend_receiving" ||
        correction.finalized.record.content.kind !== "finalized" ||
        correction.original.finalized.record.content.kind !== "finalized" ||
        orphan.stage !== "void_receiving"
      )
        throw new Error("Unexpected native lifecycle");
      expect(correction.finalized.record.revision).toBe(2);
      expect(
        correction.original.finalized.record.content.snapshot.items.map((v) => v.quantity),
      ).toEqual(["250", "400"]);
      expect(correction.finalized.record.content.snapshot.items.map((v) => v.quantity)).toEqual([
        "300",
        "400",
      ]);
      expect(orphan.voided.record.status).toBe("void");
      expect(orphan.lots.map((v) => [v.id, v.status, v.sourceLockedAt])).toEqual(
        orphan.original.lots.map((v) => [v.id, v.status, v.sourceLockedAt]),
      );
      expect(
        (
          await f.pool.query(
            "SELECT r.id,r.current_event_id,r.pending_draft_id,e.id AS latest_id,e.status AS latest_status,e.revision AS latest_revision FROM receiving_event_roots r JOIN LATERAL (SELECT id,status,revision FROM traceability_events WHERE tenant_id=r.tenant_id AND root_event_id=r.id ORDER BY revision DESC LIMIT 1) e ON true WHERE r.tenant_id=$1 AND r.id=$2",
            [context.tenantId, orphan.original.finalized.eventId],
          )
        ).rows,
      ).toEqual([
        {
          id: orphan.original.finalized.eventId,
          current_event_id: null,
          pending_draft_id: null,
          latest_id: orphan.voided.eventId,
          latest_status: "void",
          latest_revision: 1,
        },
      ]);
      for (const value of [
        result,
        result.regular,
        result.regular.range,
        result.regular.chains,
        ...result.regular.chains,
        result.special,
        result.special.correction,
        result.special.orphan,
      ])
        expect(Object.isFrozen(value)).toBe(true);
      expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(256 * 1024);
      const before = await f.snapshot();
      const verifyStarted = performance.now();
      expect(await coordinator.verify(context)).toEqual(result);
      const verifyMs = performance.now() - verifyStarted;
      const replayStarted = performance.now();
      expect(await coordinator.initialize(context)).toEqual(result);
      const replayMs = performance.now() - replayStarted;
      expect(await f.snapshot()).toEqual(before);
      const size = await f.pool.query<{ bytes: string }>(
        "SELECT pg_database_size(current_database())::text AS bytes",
      );
      console.info("Native-only full coordinator measurements", {
        generationMs,
        resumeMs,
        verifyMs,
        replayMs,
        processPeakRssKiB: process.resourceUsage().maxRSS,
        childDatabaseBytesIncludingSchema: size.rows[0]?.bytes,
      });

      await f.pool.query(
        "UPDATE reference_documents SET notes='Owned native drift' WHERE tenant_id=$1",
        [context.tenantId],
      );
      const drift = await f.snapshot();
      await expect(coordinator.verify(context)).rejects.toThrow(/drift|invalid/);
      await expect(coordinator.initialize(context)).rejects.toThrow(/drift|invalid/);
      expect(await f.snapshot()).toEqual(drift);
    }),
    900_000,
  );
});
