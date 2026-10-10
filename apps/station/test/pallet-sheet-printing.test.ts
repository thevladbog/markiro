// @vitest-environment node
import { expect, it, vi, afterEach } from "vitest";
import { openProductLabelWork } from "./support/product-label-work.js";
import { printPalletSheet } from "../src/lib/pallet-sheet-printing.js";
import { readPrintDelivery } from "../src/lib/print-deliveries.js";
import * as textAdapter from "../src/lib/rasterizer.js";
import type { WindowsPrinting } from "../src/lib/hardware.js";
import {
  initializeDeviceRecovery,
  sealDeviceRecovery,
  restoreDeviceRecovery,
} from "../src/lib/device-recovery.js";
import {
  createCredentialGeneration,
  credentialGenerationOwnership,
} from "../src/lib/credential-recovery.js";
import { parseOrganizationBranding } from "../src/lib/organization-branding.js";
afterEach(() => vi.restoreAllMocks());
it("allows same-device restored credentials to replay retained A4 work without rewriting historical ownership", async () => {
  const generation = createCredentialGeneration("key-a");
  const original = await credentialGenerationOwnership(generation);
  if (!original) throw new Error("missing owner");
  const w = await openProductLabelWork("required", original, true, true);
  try {
    const config = {
      machineId: "local",
      tenantId: "tenant",
      deviceId: w.input.deviceId,
      serverUrl: "https://api.example/api",
      apiKey: "key-a",
    };
    const recovery = await initializeDeviceRecovery(w.exec, config);
    if (!recovery.owner) throw new Error("missing durable owner");
    const { digest: ignored, ...oldContent } = JSON.parse(serializeOrganizationBranding(branding));
    void ignored;
    oldContent.ownerDigest = original;
    const oldBranding = parseOrganizationBranding(
      JSON.stringify({ ...oldContent, digest: productLabelValueDigest(oldContent) }),
    );
    const prepared = await preparePalletSheet(
      { profile, template: template(), facts, branding: oldBranding, geometry },
      rasterize,
    );
    const send = vi.fn<WindowsPrinting["printWindowsRaster"]>().mockResolvedValue({
      ok: false,
      error: { code: "driver_failure", phase: "delivery_unknown" },
    });
    const hardware: WindowsPrinting = {
      supportsWindowsPrinting: async () => true,
      preflightWindowsRaster: async () => ({ ok: true }),
      printWindowsRaster: send,
      getWindowsPrintJob: async () => ({ state: "unavailable" }),
    };
    const input = {
      exec: w.exec,
      key: {
        scope: "restored-pallet",
        purpose: "pallet" as const,
        jobId: facts.sscc,
        attemptId: "label",
      },
      profile,
      owner: { tenantId: "tenant", ownerDigest: original },
      prepare: async () => prepared,
      explicitRetry: false,
      isCurrent: () => true,
      hardware,
    };
    await expect(printPalletSheet(input)).rejects.toThrow("driver_failure");
    await sealDeviceRecovery(w.exec, config, generation);
    await restoreDeviceRecovery(
      w.exec,
      recovery.owner,
      {
        deviceId: w.input.deviceId,
        tenantId: "tenant",
        serverUrl: "https://api.example/api",
        apiKey: "key-b",
        deviceName: "Station",
        organizationName: "Plant",
        operators: [],
      },
      async () => {},
    );
    const current = await credentialGenerationOwnership(createCredentialGeneration("key-b"));
    if (!current) throw new Error("missing restored owner");
    await expect(
      printPalletSheet({
        ...input,
        explicitRetry: true,
        owner: { tenantId: "tenant", ownerDigest: current },
      }),
    ).rejects.toThrow("driver_failure");
    expect(send).toHaveBeenCalledTimes(2);
    const rows = await w.exec.all<{ render_snapshot_json: string }>(
      "SELECT render_snapshot_json FROM printer_deliveries WHERE scope='restored-pallet'",
    );
    for (const row of rows)
      expect(
        parseOrganizationBranding(
          parsePalletSheetPrintSnapshot(row.render_snapshot_json).brandingJson,
        ).ownerDigest,
      ).toBe(original);
  } finally {
    w.close();
  }
});
it("keeps the original geometry locked when a replay of unknown output itself fails before send", async () => {
  vi.spyOn(textAdapter, "rasterizeDriverText").mockImplementation(rasterize);
  const w = await openProductLabelWork();
  try {
    const prepared = await preparePalletSheet(
      { profile, template: template(), facts, branding, geometry },
      rasterize,
    );
    const key = {
      scope: "replay-owner",
      purpose: "pallet" as const,
      jobId: facts.sscc,
      attemptId: "label",
    };
    const getGeometry = vi.fn(async () => ({ ...geometry, fingerprint: "changed-driver" }));
    const preflight = vi
      .fn<WindowsPrinting["preflightWindowsRaster"]>()
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({
        ok: false,
        error: { code: "geometry_mismatch", phase: "before_start" },
      })
      .mockResolvedValue({ ok: true });
    const send = vi.fn<WindowsPrinting["printWindowsRaster"]>().mockResolvedValue({
      ok: false,
      error: { code: "driver_failure", phase: "delivery_unknown" },
    });
    const hardware: WindowsPrinting = {
      supportsWindowsPrinting: async () => true,
      getWindowsPageGeometry: getGeometry,
      preflightWindowsRaster: preflight,
      printWindowsRaster: send,
      getWindowsPrintJob: async () => ({ state: "unavailable" }),
    };
    const input = {
      exec: w.exec,
      key,
      profile,
      owner: { tenantId: branding.tenantId, ownerDigest: branding.ownerDigest },
      prepare: async () => prepared,
      explicitRetry: false,
      isCurrent: () => true,
      hardware,
    };
    await expect(printPalletSheet(input)).rejects.toThrow("driver_failure");
    await expect(printPalletSheet({ ...input, explicitRetry: true })).rejects.toThrow(
      "geometry_mismatch",
    );
    await expect(printPalletSheet({ ...input, explicitRetry: true })).rejects.toThrow(
      "driver_failure",
    );
    expect(getGeometry).not.toHaveBeenCalled();
    expect(send.mock.calls[1]?.[3]?.geometryFingerprint).toBe("driver-1");
  } finally {
    w.close();
  }
});
import {
  buildPalletSheetPresets,
  createPalletSheetSnapshot,
  productLabelValueDigest,
  sheetLogoFingerprint,
} from "@markiro/domain";
import {
  preparePalletSheet,
  parsePalletSheetPrintSnapshot,
  rebuildPalletSheet,
} from "../src/lib/pallet-sheet-print-snapshot.js";
import {
  serializeOrganizationBranding,
  type BrandingSnapshot,
} from "../src/lib/organization-branding.js";
const bitmap = { width: 4, height: 1, stride: 1, pixels: Uint8Array.of(128) };
const content = {
  schemaVersion: 1 as const,
  producerVersion: "logo-raster-v1" as const,
  tenantId: "tenant",
  ownerDigest: "a".repeat(64),
  organizationName: "Plant",
  logoRevision: null,
  sourceChecksum: null,
  logo: { ...bitmap, digest: sheetLogoFingerprint(bitmap), source: "markiro" as const },
};
const branding: BrandingSnapshot = {
  ...content,
  digest: productLabelValueDigest({
    ...content,
    logo: {
      width: 4,
      height: 1,
      stride: 1,
      pixelsBase64: "gA==",
      digest: content.logo.digest,
      source: "markiro",
    },
  }),
};
const profile = {
  id: "a4",
  name: "Office",
  mode: "windows_driver" as const,
  paper: "a4" as const,
  target: { kind: "usb" as const, printer: "Queue" },
  dpi: 300 as const,
  language: "zpl" as const,
};
const geometry = {
  widthMm: 210,
  heightMm: 297,
  printableBoundsMm: { left: 3, top: 7, right: 205, bottom: 293 },
  guardMm: 0.5,
  deviceDpiX: 600,
  deviceDpiY: 600,
  fingerprint: "driver-1",
};
const facts = {
  sscc: "146000000000001231",
  productPrintName: "Продукт",
  gtin14: "04600000000015",
  egaisCode: null,
  productionDate: null,
  shelfLifeDays: 30,
  boxCount: 3,
  itemCount: 30,
  shiftNumber: "OCT26-001",
};
const rasterize = async () => ({ hex: "80", bytesPerRow: 1, totalBytes: 1, width: 1, height: 1 });
function template() {
  const preset = buildPalletSheetPresets()[0]!;
  return createPalletSheetSnapshot({
    id: "a1111111-1111-4111-8111-111111111111",
    name: preset.name,
    revision: 1,
    spec: preset.spec,
  });
}
it("freezes complete saved facts/spec/logo/geometry and rebuilds equal bytes after resource deletion", async () => {
  const saved = await preparePalletSheet(
    { profile, template: template(), facts, branding, geometry },
    rasterize,
  );
  const parsed = parsePalletSheetPrintSnapshot(JSON.stringify(saved.renderSnapshot));
  expect(parsed.brandingJson).toBe(serializeOrganizationBranding(branding));
  expect(await rebuildPalletSheet(parsed, rasterize)).toEqual(saved.bytes);
  expect(() =>
    parsePalletSheetPrintSnapshot(JSON.stringify({ ...parsed, rendererVersion: "future" })),
  ).toThrow();
  expect(() =>
    parsePalletSheetPrintSnapshot(JSON.stringify({ ...parsed, facts: { ...facts, itemCount: 0 } })),
  ).toThrow();
});
it("rejects RAW and missing counts rather than choosing a built-in template or printing zero", async () => {
  await expect(
    preparePalletSheet(
      { profile: { ...profile, mode: "raw" }, template: template(), facts, branding, geometry },
      rasterize,
    ),
  ).rejects.toThrow();
  await expect(
    preparePalletSheet(
      { profile, template: template(), facts: { ...facts, itemCount: NaN }, branding, geometry },
      rasterize,
    ),
  ).rejects.toThrow();
});
it("persists bytes and resources before IPC, survives restart without resend, and explicitly replays unknown bytes", async () => {
  const w = await openProductLabelWork();
  try {
    const prepared = await preparePalletSheet(
      { profile, template: template(), facts, branding, geometry },
      rasterize,
    );
    const key = {
      scope: "owner",
      purpose: "pallet" as const,
      jobId: facts.sscc,
      attemptId: "label",
    };
    const prepare = vi.fn(async () => prepared);
    const send = vi
      .fn<WindowsPrinting["printWindowsRaster"]>()
      .mockImplementation(async (queue, bytes, documentName, sheet) => {
        const [row] = await w.exec.all<{
          state: string;
          artifact_base64: string;
          render_snapshot_json: string;
        }>(
          "SELECT state,artifact_base64,render_snapshot_json FROM printer_deliveries WHERE document_name=?",
          [documentName],
        );
        expect(row?.state).toBe("sending");
        expect(row?.artifact_base64).toBeTruthy();
        const persisted = parsePalletSheetPrintSnapshot(row!.render_snapshot_json);
        expect(persisted.template).toEqual(prepared.renderSnapshot.template);
        expect(persisted.facts).toEqual(prepared.renderSnapshot.facts);
        expect(persisted.brandingJson).toEqual(prepared.renderSnapshot.brandingJson);
        expect(persisted.geometry).toEqual(prepared.renderSnapshot.geometry);
        expect(bytes).toEqual(prepared.bytes);
        expect(sheet?.geometryFingerprint).toBe("driver-1");
        return { ok: false, error: { code: "driver_failure", phase: "delivery_unknown" } };
      });
    const hardware: WindowsPrinting = {
      supportsWindowsPrinting: async () => true,
      preflightWindowsRaster: vi.fn(async () => ({ ok: true as const })),
      printWindowsRaster: send,
      getWindowsPrintJob: async () => ({ state: "unavailable" }),
    };
    const input = {
      exec: w.exec,
      key,
      profile,
      prepare,
      explicitRetry: false,
      isCurrent: () => true,
      owner: { tenantId: branding.tenantId, ownerDigest: branding.ownerDigest },
      hardware,
    };
    await expect(printPalletSheet(input)).rejects.toThrow();
    expect(prepare).toHaveBeenCalledTimes(1);
    expect((await readPrintDelivery(w.exec, key))?.state).toBe("delivery_unknown");
    w.restart();
    await expect(
      printPalletSheet({
        ...input,
        exec: w.exec,
        explicitRetry: true,
        owner: { tenantId: "other", ownerDigest: branding.ownerDigest },
      }),
    ).rejects.toThrow("Sheet owner changed");
    expect(send).toHaveBeenCalledTimes(1);
    await expect(printPalletSheet({ ...input, exec: w.exec })).rejects.toThrow(
      "PRINT_DELIVERY_REQUIRES_RECOVERY",
    );
    expect(send).toHaveBeenCalledTimes(1);
    prepare.mockRejectedValue(new Error("catalog/logo removed"));
    await expect(
      printPalletSheet({ ...input, exec: w.exec, explicitRetry: true }),
    ).rejects.toThrow();
    expect(send).toHaveBeenCalledTimes(2);
    expect(prepare).toHaveBeenCalledTimes(1);
    const rows = await w.exec.all<{ state: string; resolved_at: string | null }>(
      "SELECT state,resolved_at FROM printer_deliveries WHERE scope='owner' ORDER BY rowid",
    );
    expect(rows).toHaveLength(2);
    expect(rows[0]?.resolved_at).toBeTruthy();
    expect(rows[1]?.state).toBe("delivery_unknown");
  } finally {
    w.close();
  }
});
it("rebuilds tombstoned settled bytes from its own resources and retains a failed-before-send geometry change", async () => {
  vi.spyOn(textAdapter, "rasterizeDriverText").mockImplementation(rasterize);
  const w = await openProductLabelWork();
  try {
    const prepared = await preparePalletSheet(
      { profile, template: template(), facts, branding, geometry },
      rasterize,
    );
    const key = {
      scope: "owner",
      purpose: "pallet" as const,
      jobId: facts.sscc,
      attemptId: "label",
    };
    const prepare = vi.fn(async () => prepared);
    const preflight = vi
      .fn<WindowsPrinting["preflightWindowsRaster"]>()
      .mockResolvedValueOnce({
        ok: false,
        error: { code: "geometry_mismatch", phase: "before_start" },
      })
      .mockResolvedValue({ ok: true });
    const hardware: WindowsPrinting = {
      supportsWindowsPrinting: async () => true,
      getWindowsPageGeometry: async () => ({ ...geometry, fingerprint: "driver-2" }),
      preflightWindowsRaster: preflight,
      printWindowsRaster: vi.fn(async (queue, bytes, documentName) => ({
        ok: true as const,
        receipt: { queue, jobId: 12, documentName },
      })),
      getWindowsPrintJob: async () => ({ state: "unavailable" }),
    };
    const input = {
      exec: w.exec,
      key,
      profile,
      prepare,
      explicitRetry: false,
      isCurrent: () => true,
      owner: { tenantId: branding.tenantId, ownerDigest: branding.ownerDigest },
      hardware,
    };
    await expect(printPalletSheet(input)).rejects.toThrow("geometry_mismatch");
    prepare.mockRejectedValue(new Error("no live resources"));
    expect(await printPalletSheet({ ...input, explicitRetry: true })).toEqual(prepared.bytes);
    const [latest] = await w.exec.all<{ artifact_base64: string; render_snapshot_json: string }>(
      "SELECT artifact_base64,render_snapshot_json FROM printer_deliveries WHERE scope='owner' ORDER BY rowid DESC LIMIT 1",
    );
    expect(latest?.artifact_base64).toBe("");
    expect(JSON.parse(latest!.render_snapshot_json).geometry.fingerprint).toBe("driver-2");
    expect(await printPalletSheet({ ...input, explicitRetry: true })).toEqual(prepared.bytes);
    expect(prepare).toHaveBeenCalledTimes(1);
  } finally {
    w.close();
  }
});
