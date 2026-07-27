import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import {
  applyMigrations,
  upsertBundle,
  readShiftMirror,
  readOperatorsMirror,
  replaceOperatorsMirror,
  type SqlExecutor,
  type StationBundle,
} from "../src/lib/mirror.js";

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
  counterpartyGln: "6291041500213",
  operators: [
    {
      operatorId: "op1",
      name: "Ivan",
      login: "1001",
      role: "operator",
      pinHash: "pbkdf2$sha256$1$c2FsdA==$aA==",
      badgeHash: null,
      active: true,
    },
  ],
};

describe("mirror", () => {
  it("applies migrations then upserts a bundle and reads it back offline", async () => {
    const exec = nodeExecutor();
    await applyMigrations(exec);
    await upsertBundle(exec, bundle);

    const shift = await readShiftMirror(exec, "s1");
    expect(shift).toMatchObject({ id: "s1", status: "active", counterpartyGln: "6291041500213" });
    expect(JSON.parse(shift!.labelTemplateSpec!)).toMatchObject({ language: "zpl" });

    const ops = await readOperatorsMirror(exec);
    expect(ops).toHaveLength(1);
    expect(ops[0]).toMatchObject({ operatorId: "op1", active: true });
  });

  it("upserting the same shift twice does not duplicate rows", async () => {
    const exec = nodeExecutor();
    await applyMigrations(exec);
    await upsertBundle(exec, bundle);
    await upsertBundle(exec, bundle);
    const rows = await exec.all<{ n: number }>("SELECT COUNT(*) AS n FROM shift_mirror");
    expect(rows[0]!.n).toBe(1);
  });

  it("re-upserting a shift with a server-edited product updates product_id (regression: ON CONFLICT omitted product_id)", async () => {
    const exec = nodeExecutor();
    await applyMigrations(exec);
    await upsertBundle(exec, bundle);
    await upsertBundle(exec, {
      ...bundle,
      shift: { ...bundle.shift, productId: "p2", productName: "Sprite" },
    });
    const rows = await exec.all<{ product_id: string; product_name: string }>(
      "SELECT product_id, product_name FROM shift_mirror WHERE id = 's1'",
    );
    expect(rows[0]).toEqual({ product_id: "p2", product_name: "Sprite" });
  });

  it("replaces the full operator set: a removed operator is deleted from the mirror", async () => {
    const exec = nodeExecutor();
    await applyMigrations(exec);

    const operatorB = {
      operatorId: "op2",
      name: "Boris",
      login: "1002",
      role: "operator",
      pinHash: "pbkdf2$sha256$1$c2FsdA==$bB==",
      badgeHash: null,
      active: true,
    };

    await upsertBundle(exec, { ...bundle, operators: [...bundle.operators, operatorB] });
    let ops = await readOperatorsMirror(exec);
    expect(ops.map((o) => o.operatorId).sort()).toEqual(["op1", "op2"]);

    // Next refresh's bundle only carries operator A: B was removed server-side
    // and must stop being able to authenticate offline.
    await upsertBundle(exec, bundle);
    ops = await readOperatorsMirror(exec);
    expect(ops.map((o) => o.operatorId)).toEqual(["op1"]);
  });

  it("an empty-operators bundle clears the operators mirror entirely", async () => {
    const exec = nodeExecutor();
    await applyMigrations(exec);
    await upsertBundle(exec, bundle);
    expect(await readOperatorsMirror(exec)).toHaveLength(1);

    await upsertBundle(exec, { ...bundle, operators: [] });
    expect(await readOperatorsMirror(exec)).toEqual([]);
  });

  it("round-trips an operator login and tolerates re-running the migrations", async () => {
    const exec = nodeExecutor();
    await applyMigrations(exec);
    // Re-running must not throw on the non-idempotent ALTER.
    await applyMigrations(exec);

    await replaceOperatorsMirror(exec, [
      {
        operatorId: "op-1",
        name: "Смирнов А.",
        login: "1042",
        role: "operator",
        pinHash: "pbkdf2$sha256$100000$c2FsdA==$aGFzaA==",
        badgeHash: null,
        active: true,
      },
    ]);

    const [op] = await readOperatorsMirror(exec);
    expect(op?.login).toBe("1042");
  });
});

const OPERATOR_A = {
  operatorId: "op-a",
  name: "A",
  login: "1001",
  role: "operator",
  pinHash: "pbkdf2$sha256$100000$c2FsdHNhbHRzYWx0c2Ex$aGFzaGhhc2hoYXNoaGFzaGhhc2hoYXNoaGE=",
  badgeHash: null,
  active: true,
};
const OPERATOR_B = { ...OPERATOR_A, operatorId: "op-b", name: "B", login: "1002" };

describe("roster publication is atomic", () => {
  it("keeps the previous roster when a refresh fails midway", async () => {
    const exec = nodeExecutor();
    await applyMigrations(exec);
    await replaceOperatorsMirror(exec, [OPERATOR_A, OPERATOR_B]);
    expect((await readOperatorsMirror(exec)).map((o) => o.operatorId).sort()).toEqual([
      "op-a",
      "op-b",
    ]);

    // A refresh that removes B but dies before the publish. Only the flip
    // writes to station_meta, so failing that statement models exactly the
    // "everything staged, nothing published" case.
    const failing: SqlExecutor = {
      run: async (sql, params) => {
        if (/station_meta/.test(sql)) throw new Error("write failed");
        return exec.run(sql, params);
      },
      all: (sql, params) => exec.all(sql, params),
    };
    await expect(replaceOperatorsMirror(failing, [OPERATOR_A])).rejects.toThrow();

    // The previous complete roster is still what authenticates.
    expect((await readOperatorsMirror(exec)).map((o) => o.operatorId).sort()).toEqual([
      "op-a",
      "op-b",
    ]);
  });

  it("publishes the new roster once the refresh completes", async () => {
    const exec = nodeExecutor();
    await applyMigrations(exec);
    await replaceOperatorsMirror(exec, [OPERATOR_A, OPERATOR_B]);
    await replaceOperatorsMirror(exec, [OPERATOR_A]);
    expect((await readOperatorsMirror(exec)).map((o) => o.operatorId)).toEqual(["op-a"]);
  });

  it("clears the roster when a completed refresh contains nobody", async () => {
    const exec = nodeExecutor();
    await applyMigrations(exec);
    await replaceOperatorsMirror(exec, [OPERATOR_A]);
    await replaceOperatorsMirror(exec, []);
    expect(await readOperatorsMirror(exec)).toEqual([]);
  });

  it("a device that already has a roster (no operators_slot key) keeps it across the upgrade", async () => {
    const exec = nodeExecutor();
    await applyMigrations(exec);

    // Simulates a pre-existing device: rows already sit in operators_mirror
    // (slot "a") and station_meta has no operators_slot key at all -- this is
    // what a device looked like before the second slot existed, not what
    // replaceOperatorsMirror itself would produce.
    await exec.run(
      `INSERT INTO operators_mirror (operator_id, name, login, role, pin_hash, badge_hash, active)
       VALUES (?,?,?,?,?,?,?)`,
      [
        "op-legacy",
        "Legacy",
        "9001",
        "operator",
        "pbkdf2$sha256$100000$c2FsdA==$bGVnYWN5",
        null,
        1,
      ],
    );

    // The upgraded device still authenticates the pre-existing roster.
    expect((await readOperatorsMirror(exec)).map((o) => o.operatorId)).toEqual(["op-legacy"]);

    // Its next refresh must publish correctly from this state, same as any
    // other device.
    await replaceOperatorsMirror(exec, [OPERATOR_A]);
    expect((await readOperatorsMirror(exec)).map((o) => o.operatorId)).toEqual(["op-a"]);
  });

  it("serializes two overlapping refreshes so the second never resolves the same target slot as the first (regression: concurrent-refresh race)", async () => {
    const exec = nodeExecutor();
    await applyMigrations(exec);

    // Tags every statement issued through this wrapper with `label`, and lets
    // exactly one matching statement (the first refresh's staging DELETE on
    // slot "b" -- the target both refreshes would race for if calls were not
    // serialized) block on `gate` until released.
    const log: string[] = [];
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    function tagged(label: string, gated: RegExp | null): SqlExecutor {
      return {
        run: async (sql, params) => {
          log.push(`${label}:${sql.trim().split("\n")[0]}`);
          if (gated?.test(sql)) await gate;
          return exec.run(sql, params);
        },
        all: async (sql, params) => {
          log.push(`${label}:${sql.trim().split("\n")[0]}`);
          return exec.all(sql, params);
        },
      };
    }
    const exec1 = tagged("1", /^DELETE FROM operators_mirror_b/);
    const exec2 = tagged("2", null);

    // Fired back to back, unawaited -- exactly the "second online flap before
    // the first refresh has flipped" scenario from the finding.
    const first = replaceOperatorsMirror(exec1, [OPERATOR_A]);
    const second = replaceOperatorsMirror(exec2, [OPERATOR_B]);

    // Flush plenty of microtasks so refresh 2 has every opportunity to start
    // if it were (wrongly) not serialized. Refresh 1 is parked on `gate`
    // inside its staging DELETE, so this cannot let it finish.
    for (let i = 0; i < 20; i++) await Promise.resolve();

    // Refresh 2's turn is chained after refresh 1's on the module-level
    // queue, so it must not have issued a single statement yet -- not even
    // its own `activeSlot` read -- while refresh 1 is still in flight.
    expect(log.some((l) => l.startsWith("2:"))).toBe(false);

    release?.();
    await first;
    await second;

    // Every "2:" entry comes strictly after every "1:" entry: the two
    // refreshes never interleaved.
    const firstIndexOf2 = log.findIndex((l) => l.startsWith("2:"));
    const lastIndexOf1 = log.reduce((last, l, i) => (l.startsWith("1:") ? i : last), -1);
    expect(firstIndexOf2).toBeGreaterThan(lastIndexOf1);

    // Both published successfully in strict sequence, each into its own
    // alternating slot -- refresh 2's roster (the later one) is what's live.
    expect((await readOperatorsMirror(exec)).map((o) => o.operatorId)).toEqual(["op-b"]);
  });
});
