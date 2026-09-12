// @vitest-environment node
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  applyMigrations,
  upsertBundle,
  readShiftMirror,
  type SqlExecutor,
  type StationBundle,
} from "../src/lib/mirror.js";
import { readDuplicateLabelContext } from "../src/lib/product-labels/context.js";
import { recordProductLabelAcceptance } from "../src/lib/product-labels/acceptance.js";
import { makeRotatingExec, openFileDatabase } from "./support/sqlite-exec.js";
import { productLabelAcceptanceFixture } from "./support/product-labels.js";

function fixture() {
  const acceptance = productLabelAcceptanceFixture();
  const productId = randomUUID();
  const bundle: StationBundle = {
    shift: {
      id: acceptance.shiftId,
      status: "active",
      mode: "validation",
      productId,
      productName: "Кега",
      lineId: null,
      lineName: null,
      counterpartyId: null,
      counterpartyName: null,
      labelTemplateId: null,
      labelTemplateName: null,
      plannedQty: 20,
      plannedDate: "2026-09-08",
      productionDate: "2026-09-08",
      boxCapacity: null,
      palletBoxCapacity: null,
      palletsEnabled: false,
      openedAt: acceptance.acceptedAt,
      number: "SEP26-001",
      validationPrint: acceptance.policy,
    },
    product: {
      id: productId,
      name: "Кега",
      gtin14: acceptance.gtin14,
      productGroup: null,
      boxCapacity: null,
      palletBoxCapacity: null,
      status: "active",
      defaultCounterpartyId: null,
      defaultLabelTemplateId: null,
      printName: null,
      egaisCode: null,
      shelfLifeDays: 30,
    },
    labelTemplate: null,
    boxLabelTemplate: null,
    counterpartyGln: null,
    operators: [],
    sscc: null,
  };
  return { bundle, acceptance };
}

describe("durable duplicate label mirror", () => {
  let folder: string;
  let path: string;
  let databases: DatabaseSync[];
  let exec: SqlExecutor;
  beforeEach(async () => {
    folder = mkdtempSync(join(tmpdir(), "markiro-print-context-"));
    path = join(folder, "station.sqlite");
    databases = [openFileDatabase(path), openFileDatabase(path)];
    exec = makeRotatingExec(databases);
    await applyMigrations(exec);
  });
  afterEach(() => {
    for (const db of databases) db.close();
    rmSync(folder, { recursive: true, force: true });
  });

  it("publishes policy and complete print context in the same SQL statement, surviving restart", async () => {
    const { bundle, acceptance } = fixture();
    const failing = makeRotatingExec(databases, {
      beforeRun(sql) {
        if (/^\s*INSERT INTO product_mirror\b/i.test(sql)) throw new Error("catalog mirror failed");
      },
    });
    await expect(upsertBundle(failing, bundle)).rejects.toThrow("catalog mirror failed");
    const expected = {
      policy: acceptance.policy,
      labelContext: {
        productName: "Кега",
        productPrintName: null,
        gtin14: acceptance.gtin14,
        egaisCode: null,
        shelfLifeDays: 30,
        counterpartyName: null,
        productionDate: "2026-09-08",
        shiftNumber: "SEP26-001",
      },
    };
    expect(await readDuplicateLabelContext(exec, bundle.shift.id)).toEqual(expected);
    expect((await readShiftMirror(exec, bundle.shift.id))?.validationPrint).toEqual(
      acceptance.policy,
    );
    for (const db of databases) db.close();
    databases = [openFileDatabase(path), openFileDatabase(path)];
    exec = makeRotatingExec(databases);
    expect(await readDuplicateLabelContext(exec, bundle.shift.id)).toEqual(expected);
  });

  it("does not publish malformed snapshots or incomplete duplicate context", async () => {
    const { bundle, acceptance } = fixture();
    for (const invalid of [
      {
        ...bundle,
        shift: {
          ...bundle.shift,
          validationPrint: {
            ...acceptance.policy,
            snapshot: { ...acceptance.policy.snapshot, digest: "0".repeat(64) },
          },
        },
      },
      { ...bundle, product: { ...bundle.product, name: "" } },
      { ...bundle, product: { ...bundle.product, id: randomUUID() } },
      { ...bundle, shift: { ...bundle.shift, mode: "aggregation" } },
    ])
      await expect(upsertBundle(exec, invalid)).rejects.toThrow();
    expect(await readShiftMirror(exec, bundle.shift.id)).toBeNull();
  });

  it("rejects an old server response or a different revision after activation", async () => {
    const { bundle, acceptance } = fixture();
    await upsertBundle(exec, bundle);
    const legacy = { ...bundle.shift };
    delete legacy.validationPrint;
    await expect(upsertBundle(exec, { ...bundle, shift: legacy })).rejects.toThrow(
      "PRODUCT_LABEL_POLICY_FROZEN",
    );
    await expect(
      upsertBundle(exec, {
        ...bundle,
        shift: {
          ...bundle.shift,
          validationPrint: { ...acceptance.policy, policyRevision: randomUUID() },
        },
      }),
    ).rejects.toThrow("PRODUCT_LABEL_POLICY_FROZEN");
    expect((await readDuplicateLabelContext(exec, bundle.shift.id))?.policy).toEqual(
      acceptance.policy,
    );
  });

  it("accepts the final snapshot while still planned and rejects a delayed planned response after activation", async () => {
    const { bundle, acceptance } = fixture();
    const planned = { ...bundle, shift: { ...bundle.shift, status: "planned", openedAt: null } };
    await upsertBundle(exec, planned);
    const policy = { ...acceptance.policy, policyRevision: randomUUID() };
    await upsertBundle(exec, { ...bundle, shift: { ...bundle.shift, validationPrint: policy } });
    await expect(upsertBundle(exec, planned)).rejects.toThrow("PRODUCT_LABEL_POLICY_FROZEN");
    expect((await readDuplicateLabelContext(exec, bundle.shift.id))?.policy).toEqual(policy);
  });

  it("also rejects a direct local update that erases a frozen policy", async () => {
    const { bundle, acceptance } = fixture();
    await upsertBundle(exec, bundle);
    await expect(
      exec.run("UPDATE shift_mirror SET validation_print_context=NULL WHERE id=?", [
        bundle.shift.id,
      ]),
    ).rejects.toThrow("PRODUCT_LABEL_POLICY_FROZEN");
    expect((await readDuplicateLabelContext(exec, bundle.shift.id))?.policy).toEqual(
      acceptance.policy,
    );
  });

  it("uses durable accepted jobs to prevent downgrade even after reproducible caches were cleared", async () => {
    const { bundle, acceptance } = fixture();
    await upsertBundle(exec, bundle);
    await recordProductLabelAcceptance(exec, acceptance);
    await exec.run("DELETE FROM shift_mirror");
    const legacy = { ...bundle.shift };
    delete legacy.validationPrint;
    await expect(upsertBundle(exec, { ...bundle, shift: legacy })).rejects.toThrow(
      "PRODUCT_LABEL_POLICY_FROZEN",
    );
    await upsertBundle(exec, bundle);
    expect((await readDuplicateLabelContext(exec, bundle.shift.id))?.policy).toEqual(
      acceptance.policy,
    );
  });

  it("retains ordinary legacy bundle behavior without a print policy", async () => {
    const { bundle } = fixture();
    const legacy = { ...bundle.shift };
    delete legacy.validationPrint;
    await upsertBundle(exec, { ...bundle, shift: legacy });
    expect(await readDuplicateLabelContext(exec, bundle.shift.id)).toBeNull();
    expect((await readShiftMirror(exec, bundle.shift.id))?.validationPrint).toBeNull();
  });
});
