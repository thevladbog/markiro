import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import { applyMigrations, type SqlExecutor, type StationBundle } from "../src/lib/mirror.js";
import { mirrorShiftBundle } from "../src/lib/shift-bundle.js";
import { remaining } from "../src/lib/sscc-pool.js";

function nodeExecutor(): SqlExecutor {
  const db = new DatabaseSync(":memory:");
  return {
    async run(sql, params = []) {
      db.prepare(sql).run(...(params as never[]));
    },
    async all<T>(sql: string, params: unknown[] = []): Promise<T[]> {
      return db.prepare(sql).all(...(params as never[])) as T[];
    },
  };
}

const bundle: StationBundle = {
  shift: {
    id: "s1",
    status: "active",
    mode: "validation",
    productId: "p1",
    productName: "Cola",
    lineId: null,
    lineName: null,
    counterpartyId: "c1",
    counterpartyName: "Buyer",
    labelTemplateId: "lt1",
    labelTemplateName: "T",
    plannedQty: 100,
    plannedDate: "2026-07-23",
    boxCapacity: 12,
    palletCapacity: 48,
    palletsEnabled: false,
    openedAt: "2026-07-23T08:00:00Z",
  },
  product: {
    id: "p1",
    gtin14: "04600000000017",
    name: "Cola",
    productGroup: "Beverages",
    boxCapacity: 12,
    palletCapacity: 48,
    status: "active",
    defaultCounterpartyId: "c1",
    defaultLabelTemplateId: "lt1",
  },
  labelTemplate: {
    id: "lt1",
    name: "T",
    spec: { widthMm: 58, heightMm: 40, dpi: 203, language: "zpl", elements: [] },
  },
  boxLabelTemplate: null,
  counterpartyGln: "6291041500213",
  // The server bundle returns `operators: []` in 05a — the server operators
  // table is a parallel 05b workstream (see plan decision #4).
  operators: [],
  // validation-mode shift -- no box serial block (Task 7).
  sscc: null,
};

describe("mirrorShiftBundle", () => {
  it("downloads the bundle via the client and mirrors it into shift_mirror/product_mirror", async () => {
    const exec = nodeExecutor();
    await applyMigrations(exec);
    const get = vi.fn().mockResolvedValue(bundle);

    await mirrorShiftBundle({ get }, exec, "s1");

    expect(get).toHaveBeenCalledWith("/shifts/s1/bundle");
    const shiftRows = await exec.all<{ id: string; product_id: string }>(
      "SELECT id, product_id FROM shift_mirror WHERE id = ?",
      ["s1"],
    );
    expect(shiftRows).toEqual([{ id: "s1", product_id: "p1" }]);
    const productRows = await exec.all<{ id: string }>(
      "SELECT id FROM product_mirror WHERE id = ?",
      ["p1"],
    );
    expect(productRows).toHaveLength(1);
  });

  it("adds the bundle's box serial block to the local pool when present (Task 11)", async () => {
    const exec = nodeExecutor();
    await applyMigrations(exec);
    const aggregationBundle: StationBundle = {
      ...bundle,
      sscc: {
        issuerPrefix: "460123456",
        extensionDigit: 0,
        fromSerial: 1,
        toSerial: 5,
        consumedThroughSerial: null,
      },
    };
    const get = vi.fn().mockResolvedValue(aggregationBundle);

    await mirrorShiftBundle({ get }, exec, "s1");

    expect(await remaining(exec, "460123456", 0)).toBe(5);
  });

  it("is resilient: a download failure is logged, not thrown, and mirrors nothing", async () => {
    const exec = nodeExecutor();
    await applyMigrations(exec);
    const get = vi.fn().mockRejectedValue(new Error("network down"));
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(mirrorShiftBundle({ get }, exec, "s1")).resolves.toBeUndefined();

    expect(consoleError).toHaveBeenCalled();
    const rows = await exec.all("SELECT id FROM shift_mirror");
    expect(rows).toHaveLength(0);
    consoleError.mockRestore();
  });

  // CodeRabbit PR33 review, Finding 10: `addRange` used to run AFTER
  // `upsertBundle`, whose very first statement publishes
  // `shift_mirror.issuer_prefix` -- the column `WorkScreen` polls to decide
  // whether to show the box UI at all, with no check that the pool actually
  // has anything in it. A poll landing between the two writes (or a failed
  // `addRange`, as here) could enable box aggregation before -- or without
  // ever -- a usable pool existing, closing a box as `no-serials` for a
  // range that was never actually missing. This pins the fix: `addRange`
  // running FIRST means a failure there must leave `issuer_prefix`
  // unpublished (no shift_mirror row at all, on this first-ever fetch)
  // rather than committed and orphaned.
  it(
    "leaves issuerPrefix unpublished (no shift_mirror row) when addRange fails, instead of " +
      "committing it ahead of a pool that was never actually populated (Finding 10)",
    async () => {
      const exec = nodeExecutor();
      await applyMigrations(exec);
      const aggregationBundle: StationBundle = {
        ...bundle,
        sscc: {
          issuerPrefix: "460123456",
          extensionDigit: 0,
          fromSerial: 1,
          toSerial: 5,
          consumedThroughSerial: null,
        },
      };
      const get = vi.fn().mockResolvedValue(aggregationBundle);
      // Simulates addRange failing -- e.g. a locked device DB -- by making
      // its own target table's write throw. `shift_mirror`/`product_mirror`
      // writes are left untouched by this wrapper, so if `upsertBundle` ran
      // anyway (the bug this fix closes), it would succeed and this test
      // would fail to catch the regression.
      const failingExec: SqlExecutor = {
        ...exec,
        run: async (sql, params) => {
          if (sql.includes("INSERT INTO sscc_pool")) {
            throw new Error("device database is locked");
          }
          return exec.run(sql, params);
        },
      };
      const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

      await expect(mirrorShiftBundle({ get }, failingExec, "s1")).resolves.toBeUndefined();

      expect(consoleError).toHaveBeenCalled();
      // The fix under test: NOT published. A concurrent reader (WorkScreen's
      // own `readShiftMirror` poll) sees no row at all, never a non-null
      // issuerPrefix ahead of a pool that failed to populate.
      const shiftRows = await exec.all("SELECT id FROM shift_mirror WHERE id = ?", ["s1"]);
      expect(shiftRows).toHaveLength(0);
      expect(await remaining(exec, "460123456", 0)).toBe(0);
      consoleError.mockRestore();

      // Recovery: the next fetch, with a working device database, mirrors
      // everything normally.
      await mirrorShiftBundle({ get }, exec, "s1");
      const recovered = await exec.all<{ issuer_prefix: string | null }>(
        "SELECT issuer_prefix FROM shift_mirror WHERE id = ?",
        ["s1"],
      );
      expect(recovered[0]?.issuer_prefix).toBe("460123456");
      expect(await remaining(exec, "460123456", 0)).toBe(5);
    },
  );
});
