import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";
import { z } from "zod";

import { readCloseSummary } from "../src/floor/close/shift-close.js";
import {
  readLostSets,
  readSetAssembly,
  recordSetScan,
  undoSetItem,
} from "../src/floor/work/set-assembly.js";
import { openLocalDbFile } from "./support/local-db.js";

const pairing = {
  hostId: "00000000-0000-4000-8000-000000000001",
  deviceId: "00000000-0000-4000-8000-000000000002",
};
const shiftId = "00000000-0000-4000-8000-000000000003";
const setGtin = "04607123456781";
const itemGtin = "04607123456804";
const assembledAt = "2026-11-12T08:00:00.000Z";
const code = (gtin: string, serial: string) =>
  `01${gtin}21${serial}\u001d91ABCD\u001d92ABCDEFGHIJKLM`;

describe("station set assembly", () => {
  it("keeps the draft on a premature set scan and queues the closed set with its complete marks", async () => {
    const dir = mkdtempSync(join(tmpdir(), "markiro-set-assembly-"));
    const path = join(dir, "station.db");
    let { db, executor } = openLocalDbFile(path);
    try {
      const context = {
        local: executor,
        pairing,
        shiftId,
        setGtin,
        recipe: [{ gtin14: itemGtin, productName: "Крем для рук", quantity: 2 }],
        operatorId: "00000000-0000-4000-8000-000000000004",
        now: () => assembledAt,
        newId: () => "00000000-0000-4000-8000-000000000005",
      };
      db.prepare(
        `
        INSERT INTO floor_shifts
        (host_id, device_id, id, number, status, mode, pallets_enabled, created_from, line_id,
         product_id, product_name, product_gtin14, production_date, box_capacity, box_template_id,
         entered_at, snapshot, seen_at)
        VALUES (?, ?, ?, '1', 'active', 'validation', 0, 'station', 'line',
                'product', 'Набор', ?, '2026-11-12', 1, 'box-template', ?, ?, 0)
      `,
      ).run(
        pairing.hostId,
        pairing.deviceId,
        shiftId,
        setGtin,
        assembledAt,
        JSON.stringify({ product: { setItems: context.recipe } }),
      );
      expect(await recordSetScan(context, code(itemGtin, "FIRST01"))).toBe("item");
      expect(await recordSetScan(context, code(setGtin, "SET0001"))).toBe("incomplete");
      db.close();
      ({ db, executor } = openLocalDbFile(path));
      context.local = executor;
      expect((await readSetAssembly(context)).items).toHaveLength(1);
      expect(await readCloseSummary(executor, pairing, shiftId, false)).toMatchObject({
        blocker: { kind: "open_set" },
        actualQty: 0,
      });
      expect(await recordSetScan(context, code(itemGtin, "FIRST01"))).toBe("duplicate");
      await undoSetItem(context);
      expect((await readSetAssembly(context)).items).toEqual([]);
      expect(await recordSetScan(context, code(itemGtin, "FIRST01"))).toBe("item");
      expect(await recordSetScan(context, code(itemGtin, "SECOND1"))).toBe("item");
      expect(await recordSetScan(context, code(setGtin, "SET0001"))).toBe("assembled");
      expect(await readSetAssembly(context)).toEqual({ items: [], completed: 1 });
      expect(
        db.prepare("SELECT count(*) AS n FROM floor_set_marks WHERE code IS NOT NULL").get()?.["n"],
      ).toBe(0);
      expect(await readCloseSummary(executor, pairing, shiftId, false)).toMatchObject({
        blocker: null,
        actualQty: 1,
      });
      const [event] = await executor.query(
        "SELECT kind, payload FROM outbox",
        [],
        z.object({ kind: z.string(), payload: z.string() }),
      );
      expect(event?.kind).toBe("set_assembled");
      expect(await readLostSets(executor, pairing, shiftId)).toBe(0);
      db.prepare("UPDATE outbox SET outcome = 'conflict', acked_at = ?").run(assembledAt);
      expect(await readLostSets(executor, pairing, shiftId)).toBe(1);
      expect(JSON.parse(event?.payload ?? "{}")).toMatchObject({
        data: {
          assembledAt,
          items: [
            { canonical: code(itemGtin, "FIRST01") },
            { canonical: code(itemGtin, "SECOND1") },
          ],
        },
      });
      expect(await recordSetScan(context, code(itemGtin, "FIRST01"))).toBe("duplicate");
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
