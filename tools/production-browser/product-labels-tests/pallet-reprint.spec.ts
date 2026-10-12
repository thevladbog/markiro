import { expect, test } from "@playwright/test";
import { randomUUID } from "node:crypto";
import {
  buildPalletSheetPresets,
  createPalletSheetSnapshot,
  makePalletLabelSource,
  productLabelValueDigest,
  sheetLogoFingerprint,
  PALLET_REPRINT_PROTOCOL,
} from "../../../packages/domain/src/index.js";
test("pallet lookup previews the whole A4 and sends only after confirmation", async ({
  page,
}, testInfo) => {
  const preset = buildPalletSheetPresets()[0];
  if (!preset) throw new Error("Missing preset");
  const logo = { width: 4, height: 1, stride: 1, pixels: Uint8Array.of(128) };
  const branding = {
    schemaVersion: 1,
    producerVersion: "logo-raster-v1",
    tenantId: "tenant-fixture",
    ownerDigest: "a".repeat(64),
    organizationName: "Тестовый завод",
    organizationInn: "9705119097",
    logoRevision: null,
    sourceChecksum: null,
    logo: {
      width: 4,
      height: 1,
      stride: 1,
      pixelsBase64: "gA==",
      digest: sheetLogoFingerprint(logo),
      source: "markiro",
    },
  };
  const source = makePalletLabelSource({
    version: 1,
    sscc: "146000000000001231",
    shiftId: randomUUID(),
    closedAt: "2026-10-11T00:00:00.000Z",
    boxCount: 48,
    itemCount: 576,
    compositionDigest: "a".repeat(64),
    boxSsccs: Array.from({ length: 48 }, (_, i) => {
      const body = "04600000000000" + String(i).padStart(3, "0");
      let sum = 0;
      for (let n = 0; n < 17; n++) sum += Number(body[n]) * (n % 2 === 0 ? 3 : 1);
      return body + String((10 - (sum % 10)) % 10);
    }),
    rendering: {
      kind: "a4",
      rendererVersion: "pallet-sheet-v1",
      template: createPalletSheetSnapshot({
        id: randomUUID(),
        name: "Палета А4 — вертикальная",
        revision: 1,
        spec: preset.spec,
      }),
      brandingJson: JSON.stringify({ ...branding, digest: productLabelValueDigest(branding) }),
      facts: {
        sscc: "146000000000001231",
        boxCount: 48,
        itemCount: 576,
        productPrintName: "Сидр полусухой газированный «ДИКИЙ КРЕСТ» 0,45 л",
        gtin14: "04600000000015",
        egaisCode: null,
        productionDate: "2026-10-11",
        shelfLifeDays: 1,
        shiftNumber: "S",
      },
    },
  });
  let printed = 0;
  await page.exposeFunction("recordPalletPrint", () => {
    printed++;
  });
  await page.addInitScript(() =>
    Object.defineProperty(window, "__TAURI_INTERNALS__", {
      value: {
        invoke: async (command: string, args: { queue?: string; documentName?: string }) => {
          if (command === "get_windows_page_geometry")
            return {
              widthMm: 210,
              heightMm: 297,
              printableBoundsMm: { left: 3, top: 7, right: 205, bottom: 293 },
              guardMm: 0.5,
              deviceDpiX: 600,
              deviceDpiY: 600,
              fingerprint: "simulated-office",
            };
          if (command === "preflight_windows_raster") return { ok: true };
          if (command === "print_windows_raster") {
            await (
              window as unknown as { recordPalletPrint: () => Promise<void> }
            ).recordPalletPrint();
            return {
              ok: true,
              receipt: { queue: args.queue, documentName: args.documentName, jobId: 17 },
            };
          }
          if (command === "get_windows_print_job") return { state: "absent" };
          return true;
        },
      },
    }),
  );
  await page.route("**/api/station/warehouse-reprint/**", (route) =>
    route.fulfill({
      json: route.request().url().endsWith("source-capabilities")
        ? { protocols: [PALLET_REPRINT_PROTOCOL] }
        : { status: "found", source },
    }),
  );
  await page.setViewportSize({ width: 1024, height: 768 });
  await page.goto(`/test/browser/pallet-reprint.html?id=${randomUUID()}`);
  await expect(page.locator("html")).toHaveAttribute("data-ready", "true");
  const input = page.getByRole("textbox", { name: "SSCC палеты, короба или код продукции" });
  await input.fill(source.sscc);
  await page.getByRole("button", { name: "Найти палету" }).click();
  const canvas = page.getByRole("img", { name: "Сохранённая этикетка палеты" });
  await expect(canvas).toHaveAttribute("width", "2480");
  await expect(canvas).toHaveAttribute("height", "3508");
  await expect(page.getByText("48", { exact: true })).toBeVisible();
  expect(printed).toBe(0);
  await page.screenshot({ path: testInfo.outputPath("pallet-confirmation.png"), fullPage: true });
  await page.getByRole("button", { name: "Отмена", exact: true }).click();
  expect(printed).toBe(0);
  await expect(canvas).toHaveCount(0);
  await input.fill(source.sscc);
  await page.getByRole("button", { name: "Найти палету" }).click();
  await expect(canvas).toBeVisible();
  await page.getByRole("button", { name: "Подтвердить печать" }).click();
  await expect.poll(() => printed).toBe(1);
  await expect(page.getByText("Передано на принтер", { exact: true })).toBeVisible();
});
