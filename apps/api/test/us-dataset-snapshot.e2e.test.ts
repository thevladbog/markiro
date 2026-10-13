import { createHash } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createUsDatasetJournalFixture } from "./support/us-dataset-journal-fixture";
import { createUsRequestResourceTestScope } from "./support/us-request-resource-test-scope";

type Fixture = Awaited<ReturnType<typeof createUsDatasetJournalFixture>>;
type Client = NonNullable<Parameters<Parameters<Fixture["pool"]["connect"]>[0]>[1]>;
const base = process.env.US_TEST_DATABASE_URL;
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

// The legacy oracle is deliberately restricted to this small owned fixture.
async function legacySnapshot(f: Fixture) {
  const tables = await f.pool.query<{ tablename: string }>(
    "SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename",
  );
  const selects = tables.rows.map(({ tablename }) => {
    if (!/^[a-z_][a-z0-9_]*$/.test(tablename)) throw new Error("Invalid oracle table");
    return `SELECT '${tablename}' AS name, coalesce(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text), '[]'::jsonb) AS body FROM "${tablename}" t`;
  });
  const result = await f.pool.query<{ name: string; body: unknown }>(selects.join(" UNION ALL "));
  return Object.fromEntries(result.rows.map(({ name, body }) => [name, digest(body)]));
}

function observe(
  f: Fixture,
  hook?: (client: Client, text: string) => Promise<void>,
  after?: (client: Client, text: string) => Promise<void>,
) {
  const statements: string[] = [];
  const batches: number[] = [];
  const clients = new Set<Client>();
  const restores: (() => void)[] = [];
  const pending = new Set<Promise<unknown>>();
  function acquire(client: Client) {
    if (clients.has(client)) return;
    clients.add(client);
    const original = client.query;
    client.query = new Proxy(original, {
      apply(target, receiver, args: unknown[]) {
        const text = typeof args[0] === "string" ? args[0] : "";
        statements.push(text);
        // Preserve callback calls too: the old pool.query path uses them.
        if (args.some((arg) => typeof arg === "function"))
          return Reflect.apply(target, receiver, args);
        const work = (async () => {
          if (hook) await hook(client, text);
          const result: unknown = await Reflect.apply(target, receiver, args);
          if (after) await after(client, text);
          if (/^FETCH /i.test(text) && result && typeof result === "object" && "rows" in result) {
            if (!Array.isArray(result.rows)) throw new Error("Unexpected native result");
            batches.push(result.rows.length);
          }
          return result;
        })();
        pending.add(work);
        void work.then(
          () => pending.delete(work),
          () => pending.delete(work),
        );
        return work;
      },
    });
    restores.push(() => {
      client.query = original;
    });
  }
  f.pool.on("acquire", acquire);
  return {
    statements,
    batches,
    clients,
    async restore() {
      while (pending.size) await Promise.allSettled([...pending]);
      f.pool.off("acquire", acquire);
      restores.forEach((restore) => restore());
    },
  };
}

describe.skipIf(!base)("bounded complete dataset snapshots on owned PostgreSQL", () => {
  let f: Fixture;
  const scope = createUsRequestResourceTestScope();
  beforeAll(async () => {
    await scope.phase(async () => {
      if (!base) throw new Error("Missing US test database");
      f = await createUsDatasetJournalFixture(base);
      await f.provision();
      await f.pool.query(`CREATE TABLE snapshot_a_rows (
      tenant_id text, label text, amount numeric, details jsonb, optional text);
      CREATE TABLE snapshot_z_rows (value text);
      CREATE TABLE snapshot_empty (value text);
      CREATE TABLE "__proto__" (value text)`);
    })();
  }, 60000);
  beforeEach(async () => {
    scope.assertIdle();
    await scope.phase(async () => {
      await f.pool.query("TRUNCATE snapshot_a_rows, snapshot_z_rows, snapshot_empty");
      await f.pool.query(`INSERT INTO snapshot_a_rows
      SELECT CASE WHEN n % 2 = 0 THEN 'tenant-a' ELSE 'tenant-b' END,
        'Жёлтый 🥬 / ' || (n % 7)::text,
        CASE WHEN n % 3 = 0 THEN NULL ELSE 9007199254740993.125 END,
        '{"10":"ten","2":"two","unicode":"ñ\\n雪","nested":{"z":null,"a":[true,false,0.0000001]}}'::jsonb,
        NULL
      FROM generate_series(1, 130) n;
      INSERT INTO snapshot_a_rows SELECT * FROM snapshot_a_rows LIMIT 2;
      INSERT INTO snapshot_z_rows VALUES ('before')`);
    })();
  });
  afterAll(async () => {
    await scope.drain();
    await f?.close();
  }, 60000);

  it(
    "matches every legacy all-column table hash including duplicates, numbers and empty tables",
    scope.phase(async () => {
      const expected = await legacySnapshot(f);
      const actual = await f.snapshot();
      expect(actual).toEqual(expected);
      expect(Object.keys(actual).length).toBeGreaterThan(198);
      expect(actual.snapshot_empty).toBe(digest([]));
      expect(Object.hasOwn(actual, "__proto__")).toBe(true);
    }),
  );

  it(
    "uses one read-only repeatable-read client and exhausts real batches of at most 64 without aggregates",
    scope.phase(async () => {
      const tables = await f.pool.query<{ tablename: string }>(
        "SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename",
      );
      const counts = tables.rows.map(({ tablename }) => {
        if (!/^[a-z_][a-z0-9_]*$/.test(tablename)) throw new Error("Invalid owned count table");
        return `SELECT count(*) AS n FROM public."${tablename}"`;
      });
      const total = await f.pool.query<{ n: number }>(
        `SELECT sum(n)::int AS n FROM (${counts.join(" UNION ALL ")}) snapshot_counts`,
      );
      const rowCount = total.rows[0]?.n;
      if (rowCount === undefined) throw new Error("Missing complete snapshot row count");
      const witness = observe(f);
      try {
        await f.snapshot();
        expect(witness.statements.some((text) => /jsonb_agg|json_agg|array_agg/i.test(text))).toBe(
          false,
        );
        expect(witness.clients.size).toBe(1);
        expect(witness.statements[0]).toBe("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
        expect(witness.statements.at(-1)).toBe("COMMIT");
        expect(witness.batches.filter((count) => count === 64).length).toBeGreaterThanOrEqual(2);
        expect(witness.batches.every((count) => count <= 64)).toBe(true);
        expect(witness.batches.reduce((sum, count) => sum + count, 0)).toBe(rowCount);
        expect(witness.batches.at(-2)).toBe(rowCount % 64 || 64);
        const declarations = witness.statements.filter((text) => /^DECLARE /i.test(text));
        expect(witness.batches.filter((count) => count === 0)).toHaveLength(declarations.length);
        expect(declarations).toHaveLength(1);
        expect(tables.rows.length).toBeGreaterThan(198);
        expect(declarations[0]?.match(/FROM public\."/g)).toHaveLength(tables.rows.length);
        for (const { tablename } of tables.rows)
          expect(declarations[0]).toContain(`FROM public."${tablename}" t`);
        expect(witness.statements.filter((text) => /^CLOSE /i.test(text))).toHaveLength(
          declarations.length,
        );
      } finally {
        await witness.restore();
      }
    }),
  );

  it(
    "detects row updates, duplicate insertion, deletion and an additional public table",
    scope.phase(async () => {
      let previous = await f.snapshot();
      for (const query of [
        "UPDATE snapshot_a_rows SET optional = 'changed' WHERE tenant_id = 'tenant-b'",
        "INSERT INTO snapshot_a_rows SELECT * FROM snapshot_a_rows LIMIT 1",
        "DELETE FROM snapshot_a_rows WHERE tenant_id = 'tenant-a'",
      ]) {
        await f.pool.query(query);
        const actual = await f.snapshot();
        expect(actual.snapshot_a_rows).not.toBe(previous.snapshot_a_rows);
        expect(actual).toEqual(await legacySnapshot(f));
        previous = actual;
      }
      try {
        await f.pool.query("CREATE TABLE snapshot_added (value text)");
        const actual = await f.snapshot();
        expect(actual).toEqual({ ...previous, snapshot_added: digest([]) });
      } finally {
        await f.pool.query("DROP TABLE IF EXISTS snapshot_added");
      }
    }),
  );

  it(
    "excludes concurrent commits across tables and batches until the next snapshot",
    scope.phase(async () => {
      const before = await legacySnapshot(f);
      // Pre-acquire the independent writer so only the snapshot client is witnessed.
      const writer = await f.pool.connect();
      let changed = false;
      let fetchingRows = false;
      let fetchCount = 0;
      const witness = observe(f, async (_client, text) => {
        if (/^DECLARE /i.test(text)) fetchingRows = text.includes('"snapshot_a_rows"');
        if (fetchingRows && /^FETCH /i.test(text)) fetchCount++;
        if (!changed && fetchingRows && /^FETCH /i.test(text) && fetchCount === 2) {
          changed = true;
          await writer.query("BEGIN");
          try {
            await writer.query(
              "UPDATE snapshot_a_rows SET optional='concurrent'; UPDATE snapshot_z_rows SET value='after'",
            );
            await writer.query("COMMIT");
          } catch (error) {
            await writer.query("ROLLBACK");
            throw error;
          }
        }
      });
      try {
        expect(await f.snapshot()).toEqual(before);
        expect(changed).toBe(true);
      } finally {
        await witness.restore();
        writer.release();
      }
      const after = await f.snapshot();
      expect(after.snapshot_a_rows).not.toBe(before.snapshot_a_rows);
      expect(after.snapshot_z_rows).not.toBe(before.snapshot_z_rows);
      expect(after).toEqual(await legacySnapshot(f));
    }),
  );

  it(
    "rejects an unsupported real table identifier without leaking a transaction",
    scope.phase(async () => {
      await f.pool.query('CREATE TABLE "snapshot-invalid" (value text)');
      const witness = observe(f);
      try {
        await expect(f.snapshot()).rejects.toThrow("us_dataset_fixture_table_invalid");
        expect(witness.statements.at(-1)).toBe("ROLLBACK");
        expect(f.pool.totalCount - f.pool.idleCount).toBe(0);
      } finally {
        await witness.restore();
        await f.pool.query('DROP TABLE "snapshot-invalid"');
      }
    }),
  );

  it.each(["BEGIN", "SELECT tablename", "DECLARE", "FETCH", "CLOSE", "COMMIT"])(
    "preserves the actual driver failure after %s and releases the client",
    scope.phase(async (boundary) => {
      let driverError: unknown;
      let injected = false;
      const witness = observe(f, undefined, async (client, text) => {
        if (injected || !text.startsWith(boundary)) return;
        injected = true;
        try {
          await client.query("SELECT 1 / 0");
        } catch (error) {
          driverError = error;
          throw error;
        }
      });
      try {
        await expect(f.snapshot()).rejects.toSatisfy((error: unknown) => error === driverError);
        expect(driverError).toMatchObject({ code: "22012" });
        expect(witness.statements.at(-1)).toBe("ROLLBACK");
        expect(f.pool.totalCount - f.pool.idleCount).toBe(0);
      } finally {
        await witness.restore();
      }
      expect(await f.snapshot()).toEqual(await legacySnapshot(f));
    }),
  );

  it(
    "keeps the original native error when forwarded rollback and release also fail",
    scope.phase(async () => {
      let driverError: unknown;
      let injected = false;
      let rolledBack = false;
      let released = false;
      const witness = observe(f, undefined, async (client, text) => {
        if (text === "ROLLBACK") {
          rolledBack = true;
          throw new Error("Injected cleanup failure after native rollback");
        }
        if (injected || !text.startsWith("FETCH")) return;
        injected = true;
        const release = client.release.bind(client);
        client.release = (error) => {
          release(error);
          released = true;
          throw new Error("Injected cleanup failure after native release");
        };
        try {
          await client.query("SELECT 1 / 0");
        } catch (error) {
          driverError = error;
          throw error;
        }
      });
      try {
        await expect(f.snapshot()).rejects.toSatisfy((error: unknown) => error === driverError);
        expect(driverError).toMatchObject({ code: "22012" });
        expect(rolledBack).toBe(true);
        expect(released).toBe(true);
        expect(f.pool.totalCount - f.pool.idleCount).toBe(0);
      } finally {
        await witness.restore();
      }
      expect(await f.snapshot()).toEqual(await legacySnapshot(f));
    }),
  );
});
