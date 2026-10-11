import { expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { buildPalletSheetPresets } from "@markiro/domain";
import type { EligibilityDb } from "../src/modules/label-templates/box-label-template-eligibility";
import { snapshotSelectedPalletSheet } from "../src/modules/shifts/pallet-sheet-template-store";
const preset = buildPalletSheetPresets()[0];
if (!preset) throw new Error("Missing preset");
const row = {
  id: "8d47946b-1c1c-4589-8ec4-70a3e7ff0024",
  name: "A4",
  revision: 1,
  spec: preset.spec,
  format: "pallet_sheet_v2",
  purpose: "pallet",
  enabled: true,
  chzProductGroupCodes: [15],
};
function db(value: unknown) {
  const where = vi.fn<(sql: SQL) => unknown>();
  const lock = vi.fn(async () => (value ? [value] : []));
  where.mockReturnValue({ for: lock });
  const select = vi.fn(() => ({ from: () => ({ where }) }));
  return { db: { select } as unknown as EligibilityDb, where, lock };
}
it("captures complete V2 content/revision under the same tenant share lock", async () => {
  const h = db(row);
  const snapshot = await snapshotSelectedPalletSheet(h.db, "tenant", row.id, 15);
  expect(snapshot).toMatchObject({ id: row.id, revision: 1, spec: preset.spec });
  expect(h.lock).toHaveBeenCalledWith("share");
  const condition = h.where.mock.calls[0]?.[0];
  if (!condition) throw new Error("Missing tenant predicate");
  const query = new PgDialect().sqlToQuery(condition);
  expect(query.sql).toContain('"label_templates"."tenant_id"');
  expect(query.params).toContain("tenant");
});
it("refuses missing, V1, disabled or category-ineligible templates", async () => {
  for (const value of [
    null,
    { ...row, format: "label_v1" },
    { ...row, enabled: false },
    { ...row, chzProductGroupCodes: [26] },
  ])
    await expect(snapshotSelectedPalletSheet(db(value).db, "tenant", row.id, 15)).rejects.toThrow();
});
