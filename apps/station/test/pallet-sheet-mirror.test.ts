import {
  readShiftExecutionProjection,
  assertExecutionScopeMatches,
} from "../src/lib/offline-grants/semantic.js";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { buildPalletSheetPresets, createPalletSheetSnapshot } from "@markiro/domain";
import {
  applyMigrations,
  upsertBundle,
  readShiftMirror,
  type SqlExecutor,
  type StationBundle,
} from "../src/lib/mirror.js";
const preset = buildPalletSheetPresets()[0];
if (!preset) throw new Error("Missing preset");
const snapshot = createPalletSheetSnapshot({
  id: "8d47946b-1c1c-4589-8ec4-70a3e7ff0024",
  name: "A4",
  revision: 1,
  spec: preset.spec,
});
function database() {
  const db = new DatabaseSync(":memory:");
  const exec: SqlExecutor = {
    async run(sql, params = []) {
      db.prepare(sql).run(...(params as never[]));
    },
    async all<T>(sql: string, params: unknown[] = []) {
      return db.prepare(sql).all(...(params as never[])) as T[];
    },
  };
  return { db, exec };
}
function base(): StationBundle {
  return {
    shift: {
      id: "shift",
      status: "active",
      mode: "aggregation",
      productId: "product",
      productName: "Beer",
      lineId: null,
      lineName: null,
      counterpartyId: null,
      counterpartyName: null,
      labelTemplateId: null,
      labelTemplateName: null,
      plannedQty: null,
      plannedDate: null,
      boxCapacity: 20,
      palletBoxCapacity: 48,
      palletsEnabled: true,
      openedAt: null,
      number: "OCT26-001",
      validationPrint: {
        mode: "none",
        verification: "none",
        templateId: null,
        snapshot: null,
        policyRevision: null,
      },
      ssccIssuerCounterpartyId: null,
      boxLabelTemplateId: null,
      palletLabelTemplateId: null,
      createdFrom: "admin",
      productionDate: null,
    },
    product: {
      id: "product",
      gtin14: "04600000000015",
      name: "Beer",
      productGroup: null,
      boxCapacity: 20,
      palletBoxCapacity: 48,
      status: "active",
      defaultCounterpartyId: null,
      defaultLabelTemplateId: null,
      printName: "Beer",
      egaisCode: null,
      shelfLifeDays: null,
    },
    labelTemplate: null,
    boxLabelTemplate: null,
    palletLabelTemplate: null,
    counterpartyGln: null,
    operators: [],
    sscc: null,
  };
}
function withSheet() {
  return {
    ...base(),
    shift: { ...base().shift, palletSheetTemplateId: snapshot.id },
    palletSheetTemplate: snapshot,
  };
}
describe("offline pallet sheet snapshot mirror", () => {
  it("publishes the exact selected revision atomically and preserves it through a legacy bundle replay", async () => {
    const { db, exec } = database();
    try {
      await applyMigrations(exec);
      await upsertBundle(exec, withSheet());
      expect((await readShiftMirror(exec, "shift"))?.palletSheetTemplate).toEqual(snapshot);
      const scope = db.prepare("SELECT execution_scope_json FROM shift_mirror").get();
      await upsertBundle(exec, base());
      expect(db.prepare("SELECT execution_scope_json FROM shift_mirror").get()).toEqual(scope);
      expect((await readShiftMirror(exec, "shift"))?.palletSheetTemplate).toEqual(snapshot);
    } finally {
      db.close();
    }
  });
  it("rejects malformed digest or id before changing any mirrored shift", async () => {
    const { db, exec } = database();
    try {
      await applyMigrations(exec);
      await upsertBundle(exec, withSheet());
      const before = db.prepare("SELECT * FROM shift_mirror").all();
      for (const invalid of [
        { ...withSheet(), palletSheetTemplate: { ...snapshot, digest: "a".repeat(64) } },
        { ...withSheet(), shift: { ...withSheet().shift, palletSheetTemplateId: "foreign" } },
      ])
        await expect(upsertBundle(exec, invalid)).rejects.toThrow();
      expect(db.prepare("SELECT * FROM shift_mirror").all()).toEqual(before);
    } finally {
      db.close();
    }
  });
  it("does not replace the snapshot after a durable local close", async () => {
    const { db, exec } = database();
    try {
      await applyMigrations(exec);
      await upsertBundle(exec, withSheet());
      db.prepare("UPDATE shift_mirror SET status='closed' WHERE id='shift'").run();
      const changed = createPalletSheetSnapshot({
        id: snapshot.id,
        name: snapshot.name,
        revision: 2,
        spec: { ...snapshot.spec, body: [] },
      });
      await upsertBundle(exec, { ...withSheet(), palletSheetTemplate: changed });
      expect((await readShiftMirror(exec, "shift"))?.palletSheetTemplate).toEqual(snapshot);
    } finally {
      db.close();
    }
  });
  it("refuses a V2 snapshot without complete atomic execution facts before any write", async () => {
    const { db, exec } = database();
    try {
      await applyMigrations(exec);
      const incoming = withSheet();
      delete incoming.shift.number;
      await expect(upsertBundle(exec, incoming)).rejects.toThrow();
      expect(db.prepare("SELECT * FROM shift_mirror").all()).toEqual([]);
    } finally {
      db.close();
    }
  });
  it("keeps the selected A4 revision in the complete offline grant execution projection", async () => {
    const { db, exec } = database();
    try {
      await applyMigrations(exec);
      await upsertBundle(exec, withSheet());
      const projected = await readShiftExecutionProjection(exec, "shift");
      expect(projected.scope.shift).toMatchObject({
        palletSheetTemplateId: snapshot.id,
        palletSheetTemplateSnapshot: snapshot,
      });
      const signed = {
        ...projected,
        scope: {
          ...projected.scope,
          shift: {
            ...projected.scope.shift,
            numberMonthKey: "OCT26",
            numberSeq: 1,
            createdFrom: "admin",
          },
        },
      };
      expect(() => assertExecutionScopeMatches(signed, projected)).not.toThrow();
      const changed = createPalletSheetSnapshot({
        id: snapshot.id,
        name: snapshot.name,
        revision: 2,
        spec: snapshot.spec,
      });
      expect(() =>
        assertExecutionScopeMatches(
          {
            ...signed,
            scope: {
              ...signed.scope,
              shift: { ...signed.scope.shift, palletSheetTemplateSnapshot: changed },
            },
          },
          projected,
        ),
      ).toThrow("offline grant active shift mismatch");
    } finally {
      db.close();
    }
  });
  it("explicit null clears an active selection; old bundles leave old shifts without A4", async () => {
    const { db, exec } = database();
    try {
      await applyMigrations(exec);
      await upsertBundle(exec, base());
      expect((await readShiftMirror(exec, "shift"))?.palletSheetTemplate).toBeNull();
      await upsertBundle(exec, withSheet());
      await upsertBundle(exec, {
        ...base(),
        shift: { ...base().shift, palletSheetTemplateId: null },
        palletSheetTemplate: null,
      });
      expect((await readShiftMirror(exec, "shift"))?.palletSheetTemplate).toBeNull();
    } finally {
      db.close();
    }
  });
});
