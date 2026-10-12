import { expect, it, vi } from "vitest";
import { buildPalletLabelTemplates, warehouseBoxSource } from "@markiro/domain";
import { createCredentialGeneration } from "../src/lib/credential-recovery.js";
import { attemptProductionPalletPrint } from "../src/lib/warehouse-reprint/production-pallet-printing.js";
it("blocks only pallet output when saving its immutable source fails", async () => {
  const template = buildPalletLabelTemplates()[0];
  if (!template) throw new Error("Missing template");
  const print = vi.fn(async () => {});
  const result = await attemptProductionPalletPrint({
    generation: createCredentialGeneration(),
    owner: "owner",
    tenantId: "tenant",
    sscc: "146000000000001231",
    template: template.spec,
    fields: {
      ...warehouseBoxSource().fields,
      sscc: "146000000000001231",
      qty: "1",
      "qty.boxes": "1",
    },
    destination: {
      exec: { all: vi.fn().mockRejectedValue(new Error("storage unavailable")), run: vi.fn() },
      key: {
        scope: "production",
        purpose: "pallet",
        jobId: "146000000000001231",
        attemptId: "label",
      },
    },
    printing: {
      target: { kind: "tcp", host: "127.0.0.1", port: 9100 },
      language: "zpl",
      dpi: 203,
      print,
    },
    render: async () => new TextEncoder().encode("label"),
  });
  expect(result).toEqual({ kind: "failed", code: "persistence_failed" });
  expect(print).not.toHaveBeenCalled();
});
