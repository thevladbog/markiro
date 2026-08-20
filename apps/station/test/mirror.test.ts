import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import {
  applyMigrations,
  upsertBundle,
  readShiftContext,
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
    labelTemplateId: null,
    labelTemplateName: null,
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
    defaultLabelTemplateId: null,
  },
  labelTemplate: null,
  // No box template configured by default (CodeRabbit PR33 review, Finding
  // 3) -- see the dedicated round-trip test below for the non-null case.
  boxLabelTemplate: null,
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
  // validation-mode shift -- no box serial block (Task 7).
  sscc: null,
};

describe("mirror", () => {
  it("applies migrations then upserts a bundle and reads it back offline", async () => {
    const exec = nodeExecutor();
    await applyMigrations(exec);
    await replaceOperatorsMirror(exec, bundle.operators);
    await upsertBundle(exec, bundle);

    const shift = await readShiftMirror(exec, "s1");
    expect(shift).toMatchObject({ id: "s1", status: "active", counterpartyGln: "6291041500213" });
    expect(shift?.labelTemplateSpec).toBeNull();

    const ops = await readOperatorsMirror(exec);
    expect(ops).toHaveLength(1);
    expect(ops[0]).toMatchObject({ operatorId: "op1", active: true });
  });

  // Task 8: «Код ЕГАИС» / «Годен до» box-label inputs, mirrored off the
  // product's bundle fields and joined out by readShiftContext.
  it("round-trips a product's egaisCode and shelfLifeDays through readShiftContext", async () => {
    const exec = nodeExecutor();
    await applyMigrations(exec);
    await upsertBundle(exec, {
      ...bundle,
      product: { ...bundle.product, egaisCode: "0101234567890123456", shelfLifeDays: 184 },
    });

    const ctx = await readShiftContext(exec, "s1");
    expect(ctx?.egaisCode).toBe("0101234567890123456");
    expect(ctx?.shelfLifeDays).toBe(184);
  });

  // Rolling-deployment case: an older server's bundle omits both fields
  // entirely (not even an explicit null) -- the mirror must still upsert
  // cleanly and degrade to null rather than error or keep a stale value.
  it("mirrors null egaisCode/shelfLifeDays when a bundle omits them (older server)", async () => {
    const exec = nodeExecutor();
    await applyMigrations(exec);
    await upsertBundle(exec, bundle);

    const ctx = await readShiftContext(exec, "s1");
    expect(ctx?.egaisCode).toBeNull();
    expect(ctx?.shelfLifeDays).toBeNull();
  });

  // Rolling-deployment case, part 2: a station that previously mirrored real
  // values must not KEEP them once a later bundle (a replayed older cached
  // bundle, or a station that started talking to an older server mid-rollout)
  // omits the fields entirely. The test above only ever upserts into an empty
  // database, so it cannot catch an upsert that silently retains a stale
  // egaisCode/shelfLifeDays instead of clearing it.
  it("clears a previously-mirrored egaisCode/shelfLifeDays when a later bundle omits them (rolling deployment)", async () => {
    const exec = nodeExecutor();
    await applyMigrations(exec);
    await upsertBundle(exec, {
      ...bundle,
      product: { ...bundle.product, egaisCode: "0101234567890123456", shelfLifeDays: 184 },
    });

    const before = await readShiftContext(exec, "s1");
    expect(before?.egaisCode).toBe("0101234567890123456");
    expect(before?.shelfLifeDays).toBe(184);

    await upsertBundle(exec, bundle);

    const after = await readShiftContext(exec, "s1");
    expect(after?.egaisCode).toBeNull();
    expect(after?.shelfLifeDays).toBeNull();
  });

  it("explicit nulls clear a prior legacy item spec without changing the box spec", async () => {
    const exec = nodeExecutor();
    await applyMigrations(exec);
    const boxLabelTemplate = {
      id: "boxlt1",
      name: "Box T",
      spec: { widthMm: 100, heightMm: 100, dpi: 300, language: "tspl", elements: [] },
    };
    const legacyBundle: StationBundle = {
      ...bundle,
      shift: {
        ...bundle.shift,
        labelTemplateId: "lt1",
        labelTemplateName: "Legacy Item T",
      },
      product: { ...bundle.product, defaultLabelTemplateId: "lt1" },
      labelTemplate: {
        id: "lt1",
        name: "Legacy Item T",
        spec: { widthMm: 58, heightMm: 40, dpi: 203, language: "zpl", elements: [] },
      },
      boxLabelTemplate,
    };
    await upsertBundle(exec, legacyBundle);

    const before = await readShiftMirror(exec, "s1");
    expect(JSON.parse(before!.labelTemplateSpec!)).toMatchObject({ language: "zpl" });
    const boxSpecBefore = before!.boxLabelTemplateSpec;

    await upsertBundle(exec, { ...bundle, boxLabelTemplate });

    const shift = await readShiftMirror(exec, "s1");
    expect(shift?.labelTemplateSpec).toBeNull();
    expect(JSON.parse(shift!.boxLabelTemplateSpec!)).toMatchObject({ language: "tspl" });
    expect(shift?.boxLabelTemplateSpec).toBe(boxSpecBefore);
    expect(
      await exec.all(
        "SELECT label_template_id, label_template_name FROM shift_mirror WHERE id = ?",
        ["s1"],
      ),
    ).toEqual([{ label_template_id: null, label_template_name: null }]);
    expect(
      await exec.all("SELECT default_label_template_id FROM product_mirror WHERE id = ?", ["p1"]),
    ).toEqual([{ default_label_template_id: null }]);
  });

  it("mirrors null item and box templates into their independent null columns", async () => {
    const exec = nodeExecutor();
    await applyMigrations(exec);
    await upsertBundle(exec, bundle);

    const shift = await readShiftMirror(exec, "s1");
    expect(shift?.boxLabelTemplateSpec).toBeNull();
    expect(shift?.labelTemplateSpec).toBeNull();
  });

  // Task 13 review, Finding 1: `boxCapacity` was already a `shift_mirror`
  // column, simply absent from `readShiftMirror`'s SELECT; `issuerPrefix` had
  // no durable home at all until this fix. Both must round-trip through
  // `upsertBundle`/`readShiftMirror` -- this is what App.tsx now reads to
  // wire WorkScreen's box UI.
  it("round-trips boxCapacity and issuerPrefix for an aggregation-mode bundle", async () => {
    const exec = nodeExecutor();
    await applyMigrations(exec);
    const aggregationBundle: StationBundle = {
      ...bundle,
      shift: { ...bundle.shift, mode: "aggregation", boxCapacity: 12 },
      sscc: {
        issuerPrefix: "460123456",
        extensionDigit: 0,
        fromSerial: 1,
        toSerial: 5,
        consumedThroughSerial: null,
      },
    };
    await upsertBundle(exec, aggregationBundle);

    const shift = await readShiftMirror(exec, "s1");
    expect(shift?.boxCapacity).toBe(12);
    expect(shift?.issuerPrefix).toBe("460123456");
  });

  // The validation-mode counterpart: `bundle.sscc` is null, and the stored
  // value must be null too -- never an invented fallback prefix.
  it("stores a null issuerPrefix for a validation-mode bundle (no sscc block)", async () => {
    const exec = nodeExecutor();
    await applyMigrations(exec);
    await upsertBundle(exec, bundle);

    const shift = await readShiftMirror(exec, "s1");
    expect(shift?.issuerPrefix).toBeNull();
    expect(shift?.boxCapacity).toBe(12);
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

  it("does not publish the unversioned operator set carried by a shift bundle", async () => {
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

    await replaceOperatorsMirror(exec, [operatorB]);
    await upsertBundle(exec, bundle);
    const ops = await readOperatorsMirror(exec);
    expect(ops.map((o) => o.operatorId)).toEqual(["op2"]);
  });

  it("an empty-operators bundle leaves the authoritative roster intact", async () => {
    const exec = nodeExecutor();
    await applyMigrations(exec);
    await replaceOperatorsMirror(exec, bundle.operators);
    expect(await readOperatorsMirror(exec)).toHaveLength(1);

    await upsertBundle(exec, { ...bundle, operators: [] });
    expect(await readOperatorsMirror(exec)).toEqual(bundle.operators);
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
const OPERATOR_C = { ...OPERATOR_A, operatorId: "op-c", name: "C", login: "1003" };

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

  it("a read cannot straddle a concurrent publish (regression: two-round-trip read racing the pointer flip)", async () => {
    const exec = nodeExecutor();
    await applyMigrations(exec);

    // Slot "b" is active and holds A+B.
    await replaceOperatorsMirror(exec, [OPERATOR_A, OPERATOR_B]);
    expect((await readOperatorsMirror(exec)).map((o) => o.operatorId).sort()).toEqual([
      "op-a",
      "op-b",
    ]);

    // Delays the roster-rows query specifically (its SQL starts with
    // "SELECT operator_id", unlike the old two-query read's pointer lookup,
    // "SELECT value FROM station_meta ..."). Under the current single-
    // statement read this is its one and only query; under the old
    // two-query shape it is the second one, fired only after the pointer has
    // already been resolved -- exactly the point a sign-in can straddle a
    // publish.
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const delayedRead: SqlExecutor = {
      run: (sql, params) => exec.run(sql, params),
      all: async (sql, params) => {
        if (/^SELECT operator_id/.test(sql.trim())) await gate;
        return exec.all(sql, params);
      },
    };

    // A sign-in starts reading the roster, but its row query is parked on
    // `gate` before it can run.
    const readPromise = readOperatorsMirror(delayedRead);

    // While that read is parked, a full refresh publishes a brand-new roster
    // (C only) into slot "a", flips the pointer, and cleans up the
    // now-superseded slot "b" -- all the way to completion.
    await replaceOperatorsMirror(exec, [OPERATOR_C]);

    // Now let the parked read's row query actually run.
    release?.();
    const ops = await readPromise;

    // Must be exactly the new, complete generation: never the pre-flip
    // roster (A+B) that was active when the read started, and never empty
    // (which is what the superseded-slot cleanup -- having already deleted
    // slot "b" -- would produce from a read still targeting the stale
    // resolved slot).
    expect(ops.map((o) => o.operatorId)).toEqual(["op-c"]);
  });
});
