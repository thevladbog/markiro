import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { vi } from "vitest";
import type { ProductLabelEventBase, RasterResult, VerificationPolicy } from "@markiro/domain";
import { applyMigrations, upsertBundle } from "../../src/lib/mirror.js";
import { recordProductLabelAcceptance } from "../../src/lib/product-labels/acceptance.js";
import { prepareProductLabelAcceptance } from "../../src/lib/product-labels/fields.js";
import type { ProductLabelPrintingDeps } from "../../src/lib/product-labels/types.js";
import { makeRotatingExec, openFileDatabase } from "./sqlite-exec.js";
import { productLabelAcceptanceFixture } from "./product-labels.js";

export async function openProductLabelWork(verification: VerificationPolicy = "required") {
  const directory = mkdtempSync(join(tmpdir(), "markiro-label-work-"));
  const path = join(directory, "station.sqlite");
  let databases = [openFileDatabase(path), openFileDatabase(path)];
  let exec = makeRotatingExec(databases);
  await applyMigrations(exec);
  const f = productLabelAcceptanceFixture({ verification });
  const context = {
    productName: "Кега",
    productPrintName: null,
    gtin14: f.gtin14,
    egaisCode: null,
    shelfLifeDays: 30,
    operatorName: "Оператор",
    counterpartyName: null,
    productionDate: "2026-09-08",
    shiftNumber: "SEP26-001",
  };
  const input = await prepareProductLabelAcceptance({
    jobId: f.jobId,
    shiftId: f.shiftId,
    deviceId: f.deviceId,
    terminalId: f.terminalId,
    operatorId: f.operatorId,
    credentialOwnership: f.credentialOwnership,
    raw: f.raw,
    acceptedAt: f.acceptedAt,
    policy: f.policy,
    labelContext: context,
    eventId: f.preparedEvent.eventId,
    attemptId: f.preparedEvent.attemptId,
    language: "zpl",
    printerDpi: 203,
    rasterizeText: async (): Promise<RasterResult> => ({
      hex: "00",
      totalBytes: 1,
      bytesPerRow: 1,
      width: 8,
      height: 1,
    }),
  });
  const productId = randomUUID();
  await upsertBundle(exec, {
    shift: {
      id: input.shiftId,
      status: "active",
      mode: "validation",
      productId,
      productName: context.productName,
      lineId: null,
      lineName: null,
      counterpartyId: null,
      counterpartyName: null,
      labelTemplateId: null,
      labelTemplateName: null,
      plannedQty: 20,
      plannedDate: context.productionDate,
      productionDate: context.productionDate,
      boxCapacity: null,
      palletCapacity: null,
      palletsEnabled: false,
      openedAt: input.acceptedAt,
      number: context.shiftNumber,
      validationPrint: input.policy,
    },
    product: {
      id: productId,
      name: context.productName,
      gtin14: context.gtin14,
      productGroup: null,
      boxCapacity: null,
      palletCapacity: null,
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
  });
  await recordProductLabelAcceptance(exec, input);
  let sequence = 0;
  let tick = 0;
  const print = vi.fn(async () => {});
  const actor = {
    operatorId: input.operatorId,
    now: () => new Date(Date.parse(input.acceptedAt) + ++tick * 1000).toISOString(),
    newId: () => `f0000000-0000-4000-8000-${String(++sequence).padStart(12, "0")}`,
  };
  const deps: ProductLabelPrintingDeps = {
    ...actor,
    exec,
    credentialOwnership: input.credentialOwnership,
    target: { kind: "tcp", host: "127.0.0.1", port: 9100 },
    language: "zpl",
    dpi: 203,
    print,
  };
  return {
    input,
    deps,
    print,
    actor,
    get exec() {
      return exec;
    },
    restart() {
      for (const db of databases) db.close();
      databases = [openFileDatabase(path), openFileDatabase(path)];
      exec = makeRotatingExec(databases);
      deps.exec = exec;
    },
    close() {
      for (const db of databases) db.close();
      rmSync(directory, { recursive: true, force: true });
    },
    eventBase(sequence: number): ProductLabelEventBase {
      return {
        eventId: actor.newId(),
        jobId: input.jobId,
        attemptId: input.preparedEvent.attemptId,
        sequence,
        shiftId: input.shiftId,
        codeHash: input.codeHash,
        acceptedAt: input.acceptedAt,
        policyRevision: input.policy.policyRevision,
        templateDigest: input.policy.snapshot.digest,
        payloadDigest: input.preparedEvent.payloadDigest,
        operatorId: actor.operatorId,
        occurredAt: actor.now(),
      };
    },
  };
}
