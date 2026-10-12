import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { makePalletLabelSource, palletCompositionDigest } from "@markiro/domain";
import { thermalPalletSource } from "../../../packages/domain/test/support/pallet-reprint.js";
import { applyMigrations } from "../src/lib/mirror.js";
import { makeRotatingExec } from "./support/sqlite-exec.js";
import {
  createCredentialGeneration,
  credentialGenerationOwnership,
} from "../src/lib/credential-recovery.js";
import { seedWarehouseOperator, warehousePreparedJobInput } from "./support/warehouse-reprint.js";
import { savePalletLabelSource } from "../src/lib/warehouse-reprint/pallet-sources.js";
import {
  resolveOriginalPalletDelivery,
  palletOriginalIsResolved,
} from "../src/lib/warehouse-reprint/pallet-resolutions.js";
it("journals an offline decision on the exact source/attempt/sequence, rejects wrong scan and later claim", async () => {
  const db = new DatabaseSync(":memory:"),
    exec = makeRotatingExec([db, db]);
  await applyMigrations(exec);
  try {
    const generation = createCredentialGeneration("resolution-key"),
      owner = await credentialGenerationOwnership(generation);
    if (!owner) throw new Error("No owner");
    const input = warehousePreparedJobInput();
    await seedWarehouseOperator(exec, input.operatorId);
    const old = thermalPalletSource(),
      { revision, ...body } = old;
    expect(revision).toHaveLength(64);
    const at = "2026-10-11T00:00:00.000Z",
      codeHash = "a".repeat(64),
      boxSscc = old.boxSsccs[0];
    if (!boxSscc) throw new Error("No box");
    const source = makePalletLabelSource({
      ...body,
      boxCount: 1,
      itemCount: 1,
      boxSsccs: [boxSscc],
      compositionDigest: palletCompositionDigest([{ boxSscc, codeHash, acceptedAt: at }]),
    });
    await exec.run(
      "INSERT INTO product_mirror(id,gtin14,name,status) VALUES('prod','04600682000013','Saved','active')",
    );
    await exec.run(
      "INSERT INTO shift_mirror(id,status,mode,product_id) VALUES(?,'closed','aggregation','prod')",
      [source.shiftId],
    );
    await exec.run(
      "INSERT INTO pallets_mirror(pallet_id,shift_id,terminal_id,sscc,opened_at,closed_at,print_state) VALUES('pallet',?,?,?, ?,?,'printed')",
      [source.shiftId, input.deviceId, source.sscc, at, source.closedAt],
    );
    await exec.run(
      "INSERT INTO boxes_mirror(box_id,shift_id,sscc,opened_at,closed_at,pallet_id) VALUES('box',?,?,?,?,'pallet')",
      [source.shiftId, boxSscc, at, at],
    );
    await exec.run(
      "INSERT INTO codes_mirror(code_hash,shift_id,gtin14,serial,scanned_at,box_id) VALUES(?,?,'04600682000013','synthetic',?,'box')",
      [codeHash, source.shiftId, at],
    );
    await savePalletLabelSource(exec, owner, source);
    const receipt = {
      sourceRevision: source.revision,
      attemptId: "original",
      sequence: 2,
      bytesDigest: "b".repeat(64),
      state: "delivery_unknown",
      occurredAt: at,
    };
    await exec.run("UPDATE warehouse_pallet_sources SET production_delivery_json=?", [
      JSON.stringify(receipt),
    ]);
    const diagnostic = {
      sscc: source.sscc,
      sourceRevision: source.revision,
      attemptId: "original",
      productionSequence: 2,
      originDeviceId: input.deviceId,
      shiftId: source.shiftId,
      kind: "delivery_unknown" as const,
    };
    const options = {
      exec,
      owner,
      generation,
      deviceId: input.deviceId,
      operatorId: input.operatorId,
      diagnostic,
      outcome: "confirmed" as const,
      reason: "not_printed" as const,
    };
    await expect(
      resolveOriginalPalletDelivery({ ...options, scannedSscc: boxSscc }),
    ).rejects.toThrow("WAREHOUSE_VERIFY_MISMATCH");
    await resolveOriginalPalletDelivery({ ...options, scannedSscc: "]C100" + source.sscc });
    expect(await palletOriginalIsResolved(exec, owner, source.sscc, receipt)).toMatchObject({
      receiveStatus: "pending",
    });
    expect(
      await palletOriginalIsResolved(exec, owner, source.sscc, { ...receipt, sequence: 3 }),
    ).toBeNull();
  } finally {
    db.close();
  }
});
