import { DatabaseSync } from "node:sqlite";
import { expect, it, vi } from "vitest";
import {
  makePalletLabelSource,
  buildPalletLabelTemplates,
  warehouseBoxSource,
} from "@markiro/domain";
import { applyMigrations } from "../src/lib/mirror.js";
import { makeRotatingExec } from "./support/sqlite-exec.js";
import { warehousePreparedJobInput } from "./support/warehouse-reprint.js";
import {
  prepareWarehousePalletJob,
  sendWarehousePalletJob,
  recoverWarehousePalletJobs,
} from "../src/lib/warehouse-reprint/pallet-printing.js";
it("persists before RAW send, deduplicates sends, and never retries unknown delivery on restart", async () => {
  const db = new DatabaseSync(":memory:"),
    exec = makeRotatingExec([db, db]);
  await applyMigrations(exec);
  try {
    const template = buildPalletLabelTemplates()[0];
    if (!template) throw new Error("Missing template");
    const source = makePalletLabelSource({
      version: 1,
      sscc: "146000000000001231",
      shiftId: "00000000-0000-4000-8000-000000000001",
      closedAt: "2026-10-11T00:00:00.000Z",
      boxCount: 1,
      itemCount: 1,
      compositionDigest: "a".repeat(64),
      boxSsccs: ["046000000000001234"],
      rendering: {
        kind: "thermal",
        rendererVersion: "thermal-v1",
        template: template.spec,
        fields: {
          ...warehouseBoxSource().fields,
          sscc: "146000000000001231",
          qty: "1",
          "qty.boxes": "1",
        },
        brandingJson: null,
      },
    });
    const input = warehousePreparedJobInput();
    const job = await prepareWarehousePalletJob({
      exec,
      owner: "owner",
      operatorId: input.operatorId,
      reason: "damaged",
      source,
      profile: input.printer,
      tenantId: "tenant",
      render: async () => new TextEncoder().encode("original"),
    });
    const print = vi.fn(async () => {
      expect(
        (await exec.all<{ state: string }>("SELECT state FROM warehouse_pallet_jobs"))[0]?.state,
      ).toBe("sending");
      throw new Error("response lost");
    });
    await Promise.all([
      sendWarehousePalletJob({
        exec,
        owner: "owner",
        operatorId: input.operatorId,
        jobId: job.jobId,
        profile: input.printer,
        isCurrent: () => true,
        print,
      }),
      sendWarehousePalletJob({
        exec,
        owner: "owner",
        operatorId: input.operatorId,
        jobId: job.jobId,
        profile: input.printer,
        isCurrent: () => true,
        print,
      }),
    ]);
    expect(print).toHaveBeenCalledTimes(1);
    await recoverWarehousePalletJobs(exec, "owner", input.operatorId);
    expect(
      (await exec.all<{ state: string }>("SELECT state FROM warehouse_pallet_jobs"))[0]?.state,
    ).toBe("delivery_unknown");
    await sendWarehousePalletJob({
      exec,
      owner: "owner",
      operatorId: input.operatorId,
      jobId: job.jobId,
      profile: input.printer,
      isCurrent: () => true,
      print,
    });
    expect(print).toHaveBeenCalledTimes(1);
    expect(await exec.all("SELECT * FROM warehouse_pallet_events")).toHaveLength(2);
  } finally {
    db.close();
  }
});
