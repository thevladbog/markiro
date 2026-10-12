import { randomUUID } from "node:crypto";
import { canonicalExportDigest } from "@markiro/domain";
import { describe, expect, it } from "vitest";
import { UsDatasetRegularSeedStore } from "../src/modules/traceability/demo/us-dataset-regular-seed";
import { UsDatasetSpecialChainsSeedStore } from "../src/modules/traceability/demo/us-dataset-special-chains-seed";
import {
  captureCounterPreservation,
  checkCounterPreservation,
} from "./support/us-dataset-counter-preservation";
import { specialFault, specialFixture } from "./support/us-dataset-special-fixture";
import { outcome } from "./support/us-transformation-lock-fixture";

describe.skipIf(!process.env.US_TEST_DATABASE_URL)("native exact counter preservation", () => {
  const h = specialFixture(process.env.US_TEST_DATABASE_URL);
  // A rollback leak, reset/reuse, widened allocator allowance or mutation of old facts fails.
  it(
    "rolls back one 40001, resumes exact allocations, preserves business rows and rejects counter tampering",
    h.phase(async () => {
      const { f, context } = h;
      const regular = new UsDatasetRegularSeedStore(f.db);
      const regularResult = await regular.initialize(context, { startIndex: 0, count: 1 });
      const baseline = await captureCounterPreservation(f.pool);
      expect(baseline.counters.map((row) => [row.table, row.body.sequence])).toEqual([
        ["receiving_counters", 1],
        ["transformation_counters", 1],
        ["shipping_counters", 2],
      ]);
      const tables = (
        await f.pool.query<{ name: string; columns: string[] }>(
          "SELECT c.relname AS name, array_agg(a.attname::text ORDER BY u.ordinality) AS columns FROM pg_index i JOIN pg_class c ON c.oid=i.indrelid JOIN pg_namespace n ON n.oid=c.relnamespace CROSS JOIN LATERAL unnest(i.indkey) WITH ORDINALITY u(attnum,ordinality) JOIN pg_attribute a ON a.attrelid=c.oid AND a.attnum=u.attnum WHERE i.indisprimary AND n.nspname='public' GROUP BY c.relname ORDER BY c.relname",
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
            "SELECT to_jsonb(t) AS body FROM traceability_demo_dataset_stages t WHERE unit_key ~ '^chain_[0-9]{4}$' ORDER BY tenant_id,unit_key,stage",
          )
        ).rows;
      const regularStages = await stages();
      const special = new UsDatasetSpecialChainsSeedStore(f.db);
      const attempts = "native_attempts_" + randomUUID().replaceAll("-", "");
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
        expect((await f.pool.query(`SELECT last_value::int AS n FROM ${attempts}`)).rows).toEqual([
          { n: 1 },
        ]);
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
      expect(result.state).toBe("special_chains_shipping_verified");
      const expectedDigests = await checkCounterPreservation(f.pool, baseline, context.tenantId);
      expect([...expectedDigests.keys()]).toEqual([
        "receiving_counters",
        "transformation_counters",
        "shipping_counters",
      ]);
      const resumed = await captureCounterPreservation(f.pool);
      expect(resumed.roots.length - baseline.roots.length).toBe(4);
      expect(resumed.counters.map((row) => [row.table, row.body.sequence])).toEqual([
        ["receiving_counters", 3],
        ["transformation_counters", 2],
        ["shipping_counters", 3],
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
      const settled = await f.snapshot();
      expect(await special.verify(context)).toEqual(result);
      expect(await f.snapshot()).toEqual(settled);
      expect(await special.initialize(context)).toEqual(result);
      expect(await f.snapshot()).toEqual(settled);
      expect(await regular.verify(context, { startIndex: 0, count: 1 })).toEqual(regularResult);
      expect(await f.snapshot()).toEqual(settled);
      const tampering = [
        "UPDATE receiving_counters SET sequence=sequence-1",
        "UPDATE receiving_counters SET sequence=sequence+1",
        "DELETE FROM transformation_counters",
        "UPDATE shipping_counters SET year=year+1",
        "INSERT INTO receiving_counters SELECT tenant_id,year+1,1 FROM receiving_counters",
        "ALTER TABLE receiving_counters ADD COLUMN unexpected text DEFAULT 'changed'",
      ];
      for (const statement of tampering) {
        const client = await f.pool.connect();
        try {
          await client.query("BEGIN");
          await client.query(statement);
          await expect(
            checkCounterPreservation(client, baseline, context.tenantId),
            statement,
          ).rejects.toThrow();
        } finally {
          try {
            await client.query("ROLLBACK");
          } finally {
            client.release();
          }
        }
      }
      expect(await f.snapshot()).toEqual(settled);
      console.info("Counter transition native proof", {
        regularChains: 1,
        faultAttempts: 1,
        newRoots: 4,
        checkedPrimaryKeyTables: owned.length,
        exactCounterTables: expectedDigests.size,
        tamperingCases: tampering.length,
      });
    }),
    60_000,
  );
});
