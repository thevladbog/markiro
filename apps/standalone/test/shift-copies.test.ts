import { readFileSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";

import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  keepCreatedShift,
  keepEnteredShift,
  readShiftCopies,
  readShiftCopy,
  readStoredWork,
  replaceShiftCopies,
} from "../src/floor/shifts/shift-copies.js";
import { checkShiftSnapshot } from "../src/floor/shifts/shift-snapshot.js";
import {
  deviceShiftsSchema,
  enteredShiftSchema,
  type DeviceShift,
  type EnteredShift,
} from "../src/host/protocol.js";
import { DEVICE_ID, HOST_ID, LINE_ID } from "./support/fixtures.js";
import { openLocalDb } from "./support/local-db.js";

// See test/protocol.test.ts: bind import.meta.url before building the URL.
const testModuleUrl = import.meta.url;

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(new URL(`../proto/fixtures/${name}`, testModuleUrl), "utf8"));
}

const PAIRING = { hostId: HOST_ID, deviceId: DEVICE_ID };
const OTHER_PAIRING = { hostId: HOST_ID, deviceId: "0e2b1f7a-6c1d-4b8e-9f3a-2d4c5b6a7e8f" };
const [ACTIVE, PLANNED] = deviceShiftsSchema.parse(fixture("device-shifts.json")).shifts as [
  DeviceShift,
  DeviceShift,
];
const ENTERED: EnteredShift = enteredShiftSchema.parse(fixture("device-shift-entered.json"));
const OTHER_LINE = "0b7e7dcb-3f56-4c43-9a4b-1f0b3b3f8a21";
const SEEN = 1_790_000_000_000;
const AT = "2026-10-09T08:00:00.000Z";

const storedRow = z.object({
  status: z.string(),
  snapshot: z.string().nullable(),
  entered_at: z.string().nullable(),
  seen_at: z.number(),
});

/** Every column of every copy, by pairing and id: what a refresh must leave as it was. */
function dump(db: DatabaseSync) {
  return db.prepare("SELECT * FROM floor_shifts ORDER BY host_id, device_id, id").all();
}

async function stored(local: ReturnType<typeof openLocalDb>["executor"], id: string) {
  return local.query(
    "SELECT status, snapshot, entered_at, seen_at FROM floor_shifts WHERE id = ? ORDER BY device_id",
    [id],
    storedRow,
  );
}

describe("the station's copies of its shifts", () => {
  it("take the host's list as this pairing's, and show the line's open shifts by date", async () => {
    const { executor } = openLocalDb();
    await replaceShiftCopies(executor, PAIRING, [PLANNED, ACTIVE], SEEN);
    const copies = await readShiftCopies(executor, PAIRING, LINE_ID);
    expect(copies.map((copy) => copy.number)).toEqual(["OCT26-004", "OCT26-005/S"]);
    expect(copies[0]).toEqual({
      id: ACTIVE.id,
      number: "OCT26-004",
      status: "active",
      localState: null,
      mode: "aggregation",
      palletsEnabled: false,
      createdFrom: "office",
      lineId: LINE_ID,
      productId: ACTIVE.productId,
      productName: "Молоко 3,2% 0,9 л",
      productGtin14: "04600682000013",
      counterpartyName: "ООО «Северный берег»",
      productionDate: "2026-10-08",
      plannedQty: 1200,
      boxCapacity: 12,
      boxTemplateId: ACTIVE.boxTemplateId,
      ownerDeviceId: ACTIVE.ownerDeviceId,
      openedAt: "2026-10-08T06:02:00Z",
      closedAt: null,
      entered: false,
    });
    expect(await readShiftCopies(executor, PAIRING, OTHER_LINE)).toEqual([]);
    expect(await readShiftCopies(executor, OTHER_PAIRING, LINE_ID)).toEqual([]);
  });

  it("follow a later list: changed fields, and a planned shift that left the list goes", async () => {
    const { executor } = openLocalDb();
    await replaceShiftCopies(executor, PAIRING, [ACTIVE, PLANNED], SEEN);
    const edited = { ...PLANNED, plannedQty: 600, productionDate: "2026-10-10" };
    await replaceShiftCopies(executor, PAIRING, [edited], SEEN + 1);
    expect(await readShiftCopies(executor, PAIRING, LINE_ID)).toMatchObject([
      { id: PLANNED.id, plannedQty: 600, productionDate: "2026-10-10" },
    ]);
    expect(await readShiftCopy(executor, PAIRING, ACTIVE.id)).toBeNull();
    await replaceShiftCopies(executor, PAIRING, [], SEEN + 2);
    expect(await readShiftCopies(executor, PAIRING, LINE_ID)).toEqual([]);
  });

  it("keep a shift this station entered, with its snapshot, whatever a later list says", async () => {
    const { executor } = openLocalDb();
    await replaceShiftCopies(executor, PAIRING, [PLANNED], SEEN);
    await keepEnteredShift(executor, PAIRING, ENTERED, AT, SEEN + 1);
    await replaceShiftCopies(executor, PAIRING, [], SEEN + 2);
    const [row] = await stored(executor, ENTERED.id);
    expect(row).toEqual({
      status: "active",
      snapshot: JSON.stringify(ENTERED.snapshot),
      entered_at: AT,
      seen_at: SEEN + 1,
    });
    // An entered shift the host closed leaves the list but not the copies.
    await replaceShiftCopies(
      executor,
      PAIRING,
      [{ ...ACTIVE, status: "closed", closedAt: "2026-10-08T18:00:00Z" }],
      SEEN + 3,
    );
    expect(await readShiftCopies(executor, PAIRING, LINE_ID)).toEqual([]);
    expect(await readShiftCopy(executor, PAIRING, ENTERED.id)).toMatchObject({
      status: "closed",
      entered: true,
    });
  });

  it("keep the first entry's time and never take an entered shift back to planned", async () => {
    const { executor } = openLocalDb();
    await keepEnteredShift(executor, PAIRING, ENTERED, AT, SEEN);
    await keepEnteredShift(executor, PAIRING, ENTERED, "2026-10-09T09:00:00.000Z", SEEN + 1);
    // A list read before the entry and applied after it.
    await replaceShiftCopies(
      executor,
      PAIRING,
      [{ ...ACTIVE, status: "planned", ownerDeviceId: null, openedAt: null }],
      SEEN + 2,
    );
    expect(await stored(executor, ENTERED.id)).toEqual([
      {
        status: "active",
        snapshot: JSON.stringify(ENTERED.snapshot),
        entered_at: AT,
        seen_at: SEEN + 1,
      },
    ]);
  });

  it("show a shift this station is closing, and neither one it closed nor one the host closed", async () => {
    const { db, executor } = openLocalDb();
    await keepEnteredShift(executor, PAIRING, ENTERED, AT, SEEN);
    await replaceShiftCopies(executor, PAIRING, [ACTIVE, PLANNED], SEEN);
    db.prepare("UPDATE floor_shifts SET local_state = 'closing' WHERE id = ?").run(ACTIVE.id);
    expect(await readShiftCopies(executor, PAIRING, LINE_ID)).toMatchObject([
      { id: ACTIVE.id, localState: "closing", entered: true },
      { id: PLANNED.id, localState: null, entered: false },
    ]);
    db.prepare("UPDATE floor_shifts SET local_state = 'closed' WHERE id = ?").run(ACTIVE.id);
    // A stale `active` from the host does not bring a closed shift back.
    await replaceShiftCopies(executor, PAIRING, [ACTIVE, PLANNED], SEEN + 1);
    expect((await readShiftCopies(executor, PAIRING, LINE_ID)).map((copy) => copy.id)).toEqual([
      PLANNED.id,
    ]);
  });

  it("leave another pairing's rows alone, the same shift ids included", async () => {
    const { executor } = openLocalDb();
    await keepEnteredShift(executor, OTHER_PAIRING, ENTERED, AT, SEEN);
    await replaceShiftCopies(executor, OTHER_PAIRING, [PLANNED], SEEN);
    await replaceShiftCopies(executor, PAIRING, [], SEEN + 1);
    await replaceShiftCopies(executor, PAIRING, [{ ...PLANNED, plannedQty: 5 }], SEEN + 2);
    expect(await readShiftCopies(executor, OTHER_PAIRING, LINE_ID)).toMatchObject([
      { id: ENTERED.id, entered: true },
      { id: PLANNED.id, plannedQty: null },
    ]);
    expect(await readShiftCopies(executor, PAIRING, LINE_ID)).toMatchObject([
      { id: PLANNED.id, plannedQty: 5, entered: false },
    ]);
  });

  it("take a shift the station created before a list brings it", async () => {
    const { executor } = openLocalDb();
    await keepCreatedShift(executor, PAIRING, PLANNED, SEEN);
    expect(await readShiftCopy(executor, PAIRING, PLANNED.id)).toMatchObject({
      number: "OCT26-005/S",
      createdFrom: "station",
      entered: false,
    });
  });
});

describe("a stored shift to work", () => {
  it("is the copy and its snapshot, checked again", async () => {
    const { executor } = openLocalDb();
    await keepEnteredShift(executor, PAIRING, ENTERED, AT, SEEN);
    const work = await readStoredWork(executor, PAIRING, ENTERED.id);
    if (work.kind !== "ready") throw new Error(`not ready: ${work.kind}`);
    expect(work.shift.copy).toMatchObject({ id: ENTERED.id, entered: true });
    expect(work.shift.snapshot).toMatchObject({
      issuerPrefix: "460068200",
      product: { gtin14: "04600682000013", shelfLifeDays: 10 },
      boxTemplate: { rev: 62, spec: { widthMm: 58, language: "tspl" } },
    });
  });

  it("is missing for a shift not entered here or of another pairing", async () => {
    const { executor } = openLocalDb();
    await replaceShiftCopies(executor, PAIRING, [PLANNED], SEEN);
    await keepEnteredShift(executor, OTHER_PAIRING, ENTERED, AT, SEEN);
    expect(await readStoredWork(executor, PAIRING, PLANNED.id)).toEqual({ kind: "missing" });
    expect(await readStoredWork(executor, PAIRING, ENTERED.id)).toEqual({ kind: "missing" });
  });

  it("is unreadable when the stored layout is not one the domain reads", async () => {
    const { db, executor } = openLocalDb();
    await keepEnteredShift(executor, PAIRING, ENTERED, AT, SEEN);
    const broken = {
      ...ENTERED.snapshot,
      boxTemplate: { ...ENTERED.snapshot.boxTemplate, spec: { widthMm: 5 } },
    };
    db.prepare("UPDATE floor_shifts SET snapshot = ?").run(JSON.stringify(broken));
    expect(await readStoredWork(executor, PAIRING, ENTERED.id)).toEqual({
      kind: "unreadable",
      reason: "layout",
    });
  });
});

describe("checkShiftSnapshot", () => {
  const snapshot = ENTERED.snapshot;

  it("reads the host's snapshot with its layout", () => {
    expect(checkShiftSnapshot(snapshot)).toMatchObject({
      ok: true,
      snapshot: { boxTemplate: { spec: { dpi: 203, elements: [{ id: "name" }] } } },
    });
  });

  it("refuses a layout, a GTIN and a prefix the station cannot print from", () => {
    expect(
      checkShiftSnapshot({ ...snapshot, boxTemplate: { ...snapshot.boxTemplate, spec: {} } }),
    ).toEqual({ ok: false, reason: "layout" });
    for (const gtin14 of ["4600682000013", "04600682000014", "0460068200001x"]) {
      expect(checkShiftSnapshot({ ...snapshot, product: { ...snapshot.product, gtin14 } })).toEqual(
        { ok: false, reason: "gtin" },
      );
    }
    for (const issuerPrefix of ["46006820", "4600682000", "46006820a"]) {
      expect(checkShiftSnapshot({ ...snapshot, issuerPrefix })).toEqual({
        ok: false,
        reason: "prefix",
      });
    }
    // A whole shift is no snapshot.
    for (const raw of [{ ...snapshot, product: undefined }, fixture("device-shift-entered.json")]) {
      expect(checkShiftSnapshot(raw)).toEqual({ ok: false, reason: "shape" });
    }
  });
});

describe("a refresh while a shift is worked", () => {
  it("never touches the snapshot, the entry time or the local close of a shift it lists", async () => {
    const { db, executor } = openLocalDb();
    await keepEnteredShift(executor, PAIRING, ENTERED, AT, SEEN);
    db.prepare("UPDATE floor_shifts SET local_state = 'closing' WHERE id = ?").run(ENTERED.id);
    const before = db.prepare("SELECT snapshot, entered_at, local_state FROM floor_shifts").all();
    await replaceShiftCopies(
      executor,
      PAIRING,
      [{ ...ACTIVE, productName: "Другое имя", boxCapacity: 24, ownerDeviceId: null }],
      SEEN + 5,
    );
    await replaceShiftCopies(executor, PAIRING, [], SEEN + 6);
    expect(db.prepare("SELECT snapshot, entered_at, local_state FROM floor_shifts").all()).toEqual(
      before,
    );
    expect(before).toEqual([
      { snapshot: JSON.stringify(ENTERED.snapshot), entered_at: AT, local_state: "closing" },
    ]);
    expect(await readShiftCopy(executor, PAIRING, ENTERED.id)).toMatchObject({
      localState: "closing",
      productName: "Другое имя",
      boxCapacity: 24,
    });
  });

  it("is the same rows when the same list comes twice", async () => {
    const { db, executor } = openLocalDb();
    await keepEnteredShift(executor, PAIRING, ENTERED, AT, SEEN);
    await replaceShiftCopies(executor, PAIRING, [ACTIVE, PLANNED], SEEN + 1);
    const once = dump(db);
    await replaceShiftCopies(executor, PAIRING, [ACTIVE, PLANNED], SEEN + 1);
    expect(dump(db)).toEqual(once);
    expect(once).toHaveLength(2);
  });

  it("is one transaction: a list the table refuses takes nothing, not even the deletions", async () => {
    const { db, executor } = openLocalDb();
    await replaceShiftCopies(executor, PAIRING, [PLANNED], SEEN);
    const before = dump(db);
    // `planned_qty` must be positive: the second statement fails after the first deleted.
    await expect(
      replaceShiftCopies(executor, PAIRING, [{ ...ACTIVE, plannedQty: 0 }], SEEN + 1),
    ).rejects.toMatchObject({ code: "statement_failed" });
    expect(dump(db)).toEqual(before);
  });

  it("takes a long list in one go, and drops what is missing from the next", async () => {
    const { executor } = openLocalDb();
    const many = Array.from({ length: 800 }, (_, index) => ({
      ...PLANNED,
      id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
      number: `OCT26-${String(index).padStart(4, "0")}`,
    }));
    await replaceShiftCopies(executor, PAIRING, many, SEEN);
    expect(await readShiftCopies(executor, PAIRING, LINE_ID)).toHaveLength(800);
    await replaceShiftCopies(executor, PAIRING, many.slice(0, 300), SEEN + 1);
    expect(await readShiftCopies(executor, PAIRING, LINE_ID)).toHaveLength(300);
  });

  it("keeps a shift listed twice once, and never lets the lower status of the pair win", async () => {
    const { db, executor } = openLocalDb();
    const planned = { ...ACTIVE, status: "planned" as const, ownerDeviceId: null, openedAt: null };
    await replaceShiftCopies(executor, PAIRING, [ACTIVE, planned], SEEN);
    await replaceShiftCopies(executor, PAIRING, [planned, ACTIVE], SEEN + 1);
    expect(await stored(executor, ACTIVE.id)).toMatchObject([{ status: "active" }]);
    expect(dump(db)).toHaveLength(1);
  });
});

describe("a shift's status only goes forward", () => {
  const planned = { ...ACTIVE, status: "planned" as const, ownerDeviceId: null, openedAt: null };
  const closed = { ...ACTIVE, status: "closed" as const, closedAt: "2026-10-08T18:00:00Z" };

  it("from a stale list: planned, active and closed shifts are not taken back", async () => {
    const { executor } = openLocalDb();
    await replaceShiftCopies(executor, PAIRING, [planned], SEEN);
    await replaceShiftCopies(executor, PAIRING, [ACTIVE], SEEN + 1);
    await replaceShiftCopies(executor, PAIRING, [planned], SEEN + 2);
    expect(await readShiftCopy(executor, PAIRING, ACTIVE.id)).toMatchObject({
      status: "active",
      ownerDeviceId: ACTIVE.ownerDeviceId,
    });
    await replaceShiftCopies(executor, PAIRING, [closed], SEEN + 3);
    await replaceShiftCopies(executor, PAIRING, [ACTIVE], SEEN + 4);
    expect(await readShiftCopy(executor, PAIRING, ACTIVE.id)).toMatchObject({
      status: "closed",
      closedAt: "2026-10-08T18:00:00Z",
    });
  });

  it("from a stale list for a shift this station entered, the host's close included", async () => {
    const { executor } = openLocalDb();
    await keepEnteredShift(executor, PAIRING, ENTERED, AT, SEEN);
    await replaceShiftCopies(executor, PAIRING, [closed], SEEN + 1);
    await replaceShiftCopies(executor, PAIRING, [ACTIVE], SEEN + 2);
    expect(await readShiftCopy(executor, PAIRING, ENTERED.id)).toMatchObject({
      status: "closed",
      entered: true,
    });
    expect(await readShiftCopies(executor, PAIRING, LINE_ID)).toEqual([]);
  });

  it("from a late answer of an entry: the shift stays closed, the snapshot and entry are kept", async () => {
    const { executor } = openLocalDb();
    await replaceShiftCopies(executor, PAIRING, [closed], SEEN);
    await keepEnteredShift(executor, PAIRING, ENTERED, AT, SEEN + 1);
    expect(await readShiftCopy(executor, PAIRING, ENTERED.id)).toMatchObject({
      status: "closed",
      closedAt: "2026-10-08T18:00:00Z",
      entered: true,
    });
    expect(await stored(executor, ENTERED.id)).toMatchObject([
      { snapshot: JSON.stringify(ENTERED.snapshot), entered_at: AT },
    ]);
  });

  it("from a replayed create: an entered, active shift stays as the entry left it", async () => {
    const { executor } = openLocalDb();
    await keepEnteredShift(executor, PAIRING, ENTERED, AT, SEEN);
    await keepCreatedShift(
      executor,
      PAIRING,
      { ...ACTIVE, status: "planned", openedAt: null },
      SEEN + 1,
    );
    expect(await stored(executor, ENTERED.id)).toEqual([
      {
        status: "active",
        snapshot: JSON.stringify(ENTERED.snapshot),
        entered_at: AT,
        seen_at: SEEN,
      },
    ]);
  });
});

describe("a snapshot, once taken", () => {
  it("is the first one: a later answer of an entry, with other contents, does not replace it", async () => {
    const { executor } = openLocalDb();
    await keepEnteredShift(executor, PAIRING, ENTERED, AT, SEEN);
    const other: EnteredShift = {
      ...ENTERED,
      snapshot: {
        ...ENTERED.snapshot,
        issuerPrefix: "460068299",
        boxTemplate: { ...ENTERED.snapshot.boxTemplate, rev: 99 },
      },
    };
    await keepEnteredShift(executor, PAIRING, other, "2026-10-09T09:00:00.000Z", SEEN + 1);
    expect(await stored(executor, ENTERED.id)).toMatchObject([
      { snapshot: JSON.stringify(ENTERED.snapshot), entered_at: AT },
    ]);
    const work = await readStoredWork(executor, PAIRING, ENTERED.id);
    expect(work).toMatchObject({
      kind: "ready",
      shift: { snapshot: { issuerPrefix: "460068200", boxTemplate: { rev: 62 } } },
    });
  });

  it("is refused before it is stored when this build cannot work from it", async () => {
    const { db, executor } = openLocalDb();
    const broken: EnteredShift = {
      ...ENTERED,
      snapshot: {
        ...ENTERED.snapshot,
        boxTemplate: { ...ENTERED.snapshot.boxTemplate, spec: { widthMm: 5 } },
      },
    };
    await expect(keepEnteredShift(executor, PAIRING, broken, AT, SEEN)).rejects.toThrow(/layout/);
    expect(dump(db)).toEqual([]);
  });

  it("keeps the layout as the host sent it, a large one and keys the domain would drop", async () => {
    const { executor } = openLocalDb();
    const spec = {
      ...ENTERED.snapshot.boxTemplate.spec,
      futureKey: { note: "Кириллица ✓ " + "я".repeat(120_000) },
    };
    const entered: EnteredShift = {
      ...ENTERED,
      snapshot: { ...ENTERED.snapshot, boxTemplate: { ...ENTERED.snapshot.boxTemplate, spec } },
    };
    await keepEnteredShift(executor, PAIRING, entered, AT, SEEN);
    const [row] = await stored(executor, ENTERED.id);
    expect(row?.snapshot).toBe(JSON.stringify(entered.snapshot));
    expect(Buffer.byteLength(row?.snapshot ?? "", "utf8")).toBeGreaterThan(200_000);
    const work = await readStoredWork(executor, PAIRING, ENTERED.id);
    expect(work.kind).toBe("ready");
  });

  it("is read again with the build's check: each way it can be unreadable has its reason", async () => {
    const { db, executor } = openLocalDb();
    await keepEnteredShift(executor, PAIRING, ENTERED, AT, SEEN);
    const cases = [
      ["shape", {}],
      ["shape", { ...ENTERED.snapshot, counterpartyName: 5 }],
      ["gtin", { ...ENTERED.snapshot, product: { ...ENTERED.snapshot.product, gtin14: "1" } }],
      ["prefix", { ...ENTERED.snapshot, issuerPrefix: "" }],
      [
        "shape",
        { ...ENTERED.snapshot, boxTemplate: { ...ENTERED.snapshot.boxTemplate, spec: [] } },
      ],
      [
        "layout",
        { ...ENTERED.snapshot, boxTemplate: { ...ENTERED.snapshot.boxTemplate, spec: {} } },
      ],
    ] as const;
    for (const [reason, snapshot] of cases) {
      db.prepare("UPDATE floor_shifts SET snapshot = ?").run(JSON.stringify(snapshot));
      expect(await readStoredWork(executor, PAIRING, ENTERED.id)).toEqual({
        kind: "unreadable",
        reason,
      });
    }
  });
});

describe("the host's values, kept as they are", () => {
  it("round-trips the mode, the pallet flag, an office shift and a plan, whatever they are", async () => {
    const { executor } = openLocalDb();
    const other = {
      ...PLANNED,
      mode: "validation" as const,
      palletsEnabled: true,
      createdFrom: "office" as const,
      plannedQty: 7,
      boxCapacity: 1,
    };
    await replaceShiftCopies(executor, PAIRING, [other], SEEN);
    expect(await readShiftCopy(executor, PAIRING, other.id)).toMatchObject({
      mode: "validation",
      palletsEnabled: true,
      createdFrom: "office",
      plannedQty: 7,
      boxCapacity: 1,
    });
    await replaceShiftCopies(executor, PAIRING, [{ ...other, palletsEnabled: false }], SEEN + 1);
    expect(await readShiftCopy(executor, PAIRING, other.id)).toMatchObject({
      palletsEnabled: false,
    });
  });

  it("notes when a list last saw a shift, and not when it was skipped as behind", async () => {
    const { executor } = openLocalDb();
    await replaceShiftCopies(executor, PAIRING, [ACTIVE], SEEN);
    await replaceShiftCopies(executor, PAIRING, [ACTIVE], SEEN + 1);
    expect(await stored(executor, ACTIVE.id)).toMatchObject([{ seen_at: SEEN + 1 }]);
    await replaceShiftCopies(executor, PAIRING, [{ ...ACTIVE, status: "planned" }], SEEN + 2);
    expect(await stored(executor, ACTIVE.id)).toMatchObject([{ seen_at: SEEN + 1 }]);
  });
});

describe("the host's text, kept as it is", () => {
  it("round-trips names that look like SQL, JSON, null or markup", async () => {
    const { executor } = openLocalDb();
    const names = [
      "null",
      "'; DROP TABLE floor_shifts; --",
      '{"a":[1,2]}',
      "  пробелы  и\tтабы\n",
      "😀 ООО «Ёж» <b>&amp;</b>",
      "0",
    ];
    for (const [index, name] of names.entries()) {
      const id = `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
      await replaceShiftCopies(
        executor,
        PAIRING,
        [{ ...PLANNED, id, counterpartyName: name, productName: name }],
        SEEN,
      );
      expect(await readShiftCopy(executor, PAIRING, id)).toMatchObject({
        counterpartyName: name,
        productName: name,
      });
    }
  });
});

describe("another pairing's copies", () => {
  const OTHER_HOST = { hostId: "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d", deviceId: DEVICE_ID };

  it("are not read, replaced, kept over or dropped by a pairing of another host with the same device id", async () => {
    const { db, executor } = openLocalDb();
    await keepEnteredShift(executor, OTHER_HOST, ENTERED, AT, SEEN);
    await replaceShiftCopies(executor, OTHER_HOST, [PLANNED], SEEN);
    const theirs = dump(db);
    await replaceShiftCopies(executor, PAIRING, [ACTIVE], SEEN + 1);
    await replaceShiftCopies(executor, PAIRING, [], SEEN + 2);
    await keepCreatedShift(executor, PAIRING, PLANNED, SEEN + 3);
    expect(dump(db).filter((row) => row["host_id"] === OTHER_HOST.hostId)).toEqual(theirs);
    expect(await readShiftCopy(executor, PAIRING, ENTERED.id)).toBeNull();
    expect(await readStoredWork(executor, PAIRING, ENTERED.id)).toEqual({ kind: "missing" });
    expect(await readShiftCopies(executor, OTHER_HOST, LINE_ID)).toHaveLength(2);
  });

  it.each([
    ["the device", OTHER_PAIRING],
    ["the host", OTHER_HOST],
  ])(
    "are not this pairing's when only %s differs: nothing to read, and its own row when it has one",
    async (_name, other) => {
      const { executor } = openLocalDb();
      await keepEnteredShift(executor, other, ENTERED, AT, SEEN);
      expect(await readShiftCopy(executor, PAIRING, ENTERED.id)).toBeNull();
      expect(await readStoredWork(executor, PAIRING, ENTERED.id)).toEqual({ kind: "missing" });
      expect(await readShiftCopies(executor, PAIRING, LINE_ID)).toEqual([]);
      await keepEnteredShift(executor, PAIRING, { ...ENTERED, boxCapacity: 3 }, AT, SEEN);
      expect(await readShiftCopy(executor, PAIRING, ENTERED.id)).toMatchObject({ boxCapacity: 3 });
      expect(await readShiftCopy(executor, other, ENTERED.id)).toMatchObject({ boxCapacity: 12 });
      const work = await readStoredWork(executor, PAIRING, ENTERED.id);
      expect(work).toMatchObject({ kind: "ready", shift: { copy: { boxCapacity: 3 } } });
    },
  );

  it("do not stop this pairing from entering the same shift", async () => {
    const { executor } = openLocalDb();
    await keepEnteredShift(executor, OTHER_PAIRING, ENTERED, AT, SEEN);
    await keepEnteredShift(executor, PAIRING, ENTERED, "2026-10-09T09:00:00.000Z", SEEN + 1);
    expect(await readStoredWork(executor, PAIRING, ENTERED.id)).toMatchObject({ kind: "ready" });
    expect(await stored(executor, ENTERED.id)).toMatchObject([
      { entered_at: AT },
      { entered_at: "2026-10-09T09:00:00.000Z" },
    ]);
  });
});

describe("the floor's list", () => {
  it("is the line's open shifts by production date, then number, and a closing one among them", async () => {
    const { db, executor } = openLocalDb();
    const make = (index: number, patch: Partial<DeviceShift>): DeviceShift => ({
      ...PLANNED,
      id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
      ...patch,
    });
    await keepEnteredShift(executor, PAIRING, ENTERED, AT, SEEN);
    await replaceShiftCopies(
      executor,
      PAIRING,
      [
        make(1, { number: "B", productionDate: "2026-10-09" }),
        make(2, { number: "A", productionDate: "2026-10-09" }),
        make(3, { number: "Z", productionDate: "2026-10-08" }),
        make(4, { number: "C", productionDate: "2026-10-10", lineId: OTHER_LINE }),
        make(5, { number: "D", productionDate: "2026-10-07", status: "closed", closedAt: AT }),
        { ...ACTIVE, productionDate: "2026-10-09", number: "A" },
      ],
      SEEN + 1,
    );
    db.prepare("UPDATE floor_shifts SET local_state = 'closing' WHERE id = ?").run(ACTIVE.id);
    const ids = (await readShiftCopies(executor, PAIRING, LINE_ID)).map((copy) => copy.id);
    expect(ids).toEqual([
      make(3, {}).id,
      // Same date and number "A": by id.
      make(2, {}).id,
      ACTIVE.id,
      make(1, {}).id,
    ]);
  });
});

describe("checkShiftSnapshot, at its edges", () => {
  const snapshot = ENTERED.snapshot;

  it("takes a nine-digit prefix and a GTIN-14 with its check digit, and no other forms", () => {
    expect(checkShiftSnapshot({ ...snapshot, issuerPrefix: "000000000" }).ok).toBe(true);
    for (const issuerPrefix of ["460068200\n", " 460068200", "٤٦٠٠٦٨٢٠٠"]) {
      expect(checkShiftSnapshot({ ...snapshot, issuerPrefix })).toEqual({
        ok: false,
        reason: "prefix",
      });
    }
    for (const gtin14 of ["04600682000013\n", "٠٤٦٠٠٦٨٢٠٠٠٠١٣", "00000000000000x", ""]) {
      expect(checkShiftSnapshot({ ...snapshot, product: { ...snapshot.product, gtin14 } })).toEqual(
        { ok: false, reason: "gtin" },
      );
    }
  });

  it("hands on the domain's reading of the layout and the host's other fields as they are", () => {
    const checked = checkShiftSnapshot({
      ...snapshot,
      boxTemplate: {
        ...snapshot.boxTemplate,
        spec: { ...snapshot.boxTemplate.spec, futureKey: 1 },
      },
    });
    if (!checked.ok) throw new Error(checked.reason);
    expect(checked.snapshot.boxTemplate.spec).not.toHaveProperty("futureKey");
    expect(checked.snapshot).toMatchObject({
      product: snapshot.product,
      issuerPrefix: "460068200",
      counterpartyName: "ООО «Северный берег»",
      boxTemplate: { id: snapshot.boxTemplate.id, name: "Молоко 58×40", rev: 62 },
    });
  });

  it("calls a layout that is no object a damaged snapshot, and an object the domain cannot read a layout", () => {
    for (const spec of [null, [], "x", 5]) {
      expect(
        checkShiftSnapshot({ ...snapshot, boxTemplate: { ...snapshot.boxTemplate, spec } }),
      ).toEqual({ ok: false, reason: "shape" });
    }
    for (const spec of [{}, { ...snapshot.boxTemplate.spec, dpi: 0 }, { widthMm: 5 }]) {
      expect(
        checkShiftSnapshot({ ...snapshot, boxTemplate: { ...snapshot.boxTemplate, spec } }),
      ).toEqual({ ok: false, reason: "layout" });
    }
  });
});
