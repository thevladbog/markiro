import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { expect, it, vi, beforeAll, afterEach } from "vitest";
import { buildPalletSheetPresets, createPalletSheetSnapshot } from "@markiro/domain";
import i18n from "../src/i18n/index.js";
import { NewShift, type NewShiftDraft } from "../src/pages/NewShift.js";
import { createStationClient } from "../src/lib/api-client.js";
import { DEFAULT_HARDWARE_CONFIG } from "../src/lib/hardware-config.js";
import { parsePrinterProfile, resolvePrinter } from "../src/lib/printer-routing.js";
import { DatabaseSync } from "node:sqlite";
import { applyMigrations, type SqlExecutor } from "../src/lib/mirror.js";
import { createCredentialGeneration } from "../src/lib/credential-recovery.js";
import { refreshOrganizationBranding } from "../src/lib/organization-branding.js";
import { tauriWindowsPrinting } from "../src/lib/hardware.js";
import * as textAdapter from "../src/lib/rasterizer.js";
beforeAll(async () => {
  await i18n.changeLanguage("en");
});
afterEach(() => vi.restoreAllMocks());
const profile = {
  id: "office",
  name: "Office",
  mode: "windows_driver" as const,
  paper: "a4" as const,
  target: { kind: "usb" as const, printer: "Queue" },
  dpi: 300 as const,
  language: "zpl" as const,
};
const box = {
  id: "label",
  name: "Labels",
  mode: "raw" as const,
  target: { kind: "tcp" as const, host: "printer", port: 9100 },
  dpi: 300 as const,
  language: "zpl" as const,
};
const config = {
  ...DEFAULT_HARDWARE_CONFIG,
  printerRouting: {
    printers: [profile, box],
    assignments: { box: "label", duplicate: "label", pallet: "office" },
  },
};
const draft: NewShiftDraft = {
  product: {
    id: "p1",
    gtin14: "04600000000015",
    name: "Cola",
    boxCapacity: 10,
    palletBoxCapacity: 66,
  },
  productionDate: "",
  printEnabled: false,
  verificationRequired: false,
  productTemplateId: null,
  productTemplates: [],
  createdPrintShift: null,
};
it("keeps A4 out of box/duplicate routing and rejects RAW sheet profiles", () => {
  expect(parsePrinterProfile({ ...profile, mode: "raw" })).toBeNull();
  expect(
    resolvePrinter(
      {
        ...config,
        printerRouting: {
          ...config.printerRouting,
          assignments: { box: "office", duplicate: "office", pallet: "office" },
        },
      },
      "box",
    ),
  ).toBeNull();
  expect(resolvePrinter(config, "pallet")?.paper).toBe("a4");
});
it("blocks A4-only start when a selected template has no complete branding or driver readiness", async () => {
  const preset = buildPalletSheetPresets()[0]!;
  const snapshot = createPalletSheetSnapshot({
    id: "a1111111-1111-4111-8111-111111111111",
    name: preset.name,
    revision: 1,
    spec: preset.spec,
  });
  vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
    const path = new URL(String(url)).pathname;
    if (path === "/shifts/box-label-templates")
      return Response.json({
        items: [
          { id: "box", name: "Box label", widthMm: 58, heightMm: 40, dpi: 203, language: "zpl" },
        ],
        defaultBoxLabelTemplateId: "box",
      });
    if (path === "/shifts/pallet-sheet-templates")
      return Response.json({
        items: [{ id: snapshot.id, name: snapshot.name, revision: 1, page: snapshot.spec.page }],
        defaultPalletSheetTemplateId: snapshot.id,
      });
    if (path === "/shifts/pallet-sheet-template-preview") return Response.json(snapshot);
    return Response.json({});
  });
  const client = createStationClient(
    { machineId: "machine", serverUrl: "http://localhost:3000", apiKey: "test-key" },
    { palletSheetSupported: true },
  );
  render(
    <NewShift
      client={client}
      hardwareConfig={config}
      initialDraft={draft}
      source={{ start: () => () => {} }}
      onStarted={() => {}}
      onBack={() => {}}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Aggregation" }));
  fireEvent.click(screen.getByRole("button", { name: "With pallets" }));
  fireEvent.click(screen.getByRole("button", { name: "Start" }));
  await screen.findByText("Box label template");
  fireEvent.click(screen.getByRole("button", { name: "Next" }));
  await screen.findByRole("button", { name: new RegExp(preset.name) });
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Start" }).hasAttribute("disabled")).toBe(true),
  );
});
it("uses the separate A4 library and sends explicit sheet selection without a V1 fallback", async () => {
  const preset = buildPalletSheetPresets()[2]!;
  const snapshot = createPalletSheetSnapshot({
    id: "a1111111-1111-4111-8111-111111111111",
    name: preset.name,
    revision: 2,
    spec: preset.spec,
  });
  const posts: unknown[] = [];
  const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
    const path = new URL(String(url)).pathname;
    if (path === "/shifts/box-label-templates")
      return Response.json({
        items: [
          { id: "box", name: "Box label", widthMm: 58, heightMm: 40, dpi: 203, language: "zpl" },
        ],
        defaultBoxLabelTemplateId: "box",
      });
    if (path === "/shifts/pallet-sheet-templates")
      return Response.json({
        items: [
          {
            id: snapshot.id,
            name: snapshot.name,
            revision: snapshot.revision,
            page: snapshot.spec.page,
          },
        ],
        defaultPalletSheetTemplateId: snapshot.id,
      });
    if (path === "/shifts/pallet-sheet-template-preview") return Response.json(snapshot);
    if (path === "/shifts/label-template-preview") return Response.json({});
    if (path === "/shifts" && init?.method === "POST") {
      posts.push(JSON.parse(String(init.body)));
      return Response.json({ id: "shift", status: "planned", mode: "aggregation" });
    }
    if (path === "/shifts/shift/open")
      return Response.json({ id: "shift", status: "active", mode: "aggregation" });
    throw new Error(`Unexpected ${path}`);
  });
  const client = createStationClient(
    { machineId: "machine", serverUrl: "http://localhost:3000", apiKey: "test-key" },
    { palletSheetSupported: true },
  );
  const started = vi.fn();
  const db = new DatabaseSync(":memory:");
  const exec: SqlExecutor = {
    run: async (sql, params = []) => {
      db.prepare(sql).run(...(params as never[]));
    },
    all: async <T,>(sql: string, params: unknown[] = []) =>
      db.prepare(sql).all(...(params as never[])) as T[],
  };
  await applyMigrations(exec);
  const owner = {
    exec,
    tenantId: "tenant",
    generation: createCredentialGeneration("test-key"),
    isCurrent: () => true,
  };
  const bitmap = { width: 4, height: 1, stride: 1, pixels: Uint8Array.of(128) };
  await refreshOrganizationBranding(
    {
      ...owner,
      client: {
        get: async () => ({
          organizationName: "Plant",
          logoRevision: null,
          logoUrl: null,
          logo: null,
        }),
        download: async () => new Blob(),
      },
    },
    { decodeLogo: async () => bitmap, loadMarkiroLogo: async () => bitmap },
  );
  const geometry = vi
    .spyOn(tauriWindowsPrinting, "getWindowsPageGeometry")
    .mockRejectedValueOnce(new Error("Driver unavailable"))
    .mockResolvedValue({
      widthMm: 297,
      heightMm: 210,
      printableBoundsMm: { left: 3, top: 3, right: 294, bottom: 207 },
      guardMm: 0.5,
      deviceDpiX: 600,
      deviceDpiY: 600,
      fingerprint: "driver-1",
    });
  vi.spyOn(textAdapter, "rasterizeDriverText").mockResolvedValue({
    hex: "80",
    bytesPerRow: 1,
    totalBytes: 1,
    width: 1,
    height: 1,
  });
  try {
    render(
      <NewShift
        client={client}
        hardwareConfig={config}
        sheetBrandingOwner={owner}
        initialDraft={draft}
        source={{ start: () => () => {} }}
        onStarted={started}
        onBack={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Aggregation" }));
    fireEvent.click(screen.getByRole("button", { name: "With pallets" }));
    fireEvent.click(screen.getByRole("button", { name: "Start" }));
    await screen.findByText("Box label template");
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    await screen.findByRole("button", { name: new RegExp(preset.name) });
    await screen.findByRole("alert");
    expect(geometry).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "Start" }).hasAttribute("disabled")).toBe(true);
    expect(posts).toEqual([]);
    fireEvent.click(screen.getByRole("button", { name: "Retry preview" }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Start" }).hasAttribute("disabled")).toBe(false),
    );
    fireEvent.click(screen.getByRole("button", { name: "Start" }));
    await waitFor(() => expect(started).toHaveBeenCalled());
    expect(posts).toEqual([
      expect.objectContaining({
        palletSheetTemplateId: snapshot.id,
        palletLabelTemplateId: null,
        boxLabelTemplateId: "box",
      }),
    ]);
    expect(
      fetch.mock.calls.some((call) => String(call[0]).includes("/shifts/pallet-label-templates")),
    ).toBe(false);
  } finally {
    db.close();
  }
});
