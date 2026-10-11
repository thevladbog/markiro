import { expect, test } from "@playwright/test";
import { randomUUID, createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  buildPalletSheetPresets,
  createPalletSheetSnapshot,
} from "../../../packages/domain/src/index.js";
for (const presetIndex of [0, 1, 2]) {
  for (const companyLogo of [true, false]) {
    test(`Station fits A4 preset ${presetIndex} with ${companyLogo ? "company" : "Markiro"} logo`, async ({
      page,
    }, testInfo) => {
      const preset = buildPalletSheetPresets()[presetIndex]!;
      const template = createPalletSheetSnapshot({
        id: randomUUID(),
        name: preset.name,
        revision: 2,
        spec: preset.spec,
      });
      const body = readFileSync(
        new URL("../../../apps/admin/test/browser/branding-company.webp", import.meta.url),
      );
      const revision = randomUUID();
      const posts: unknown[] = [];
      await page.addInitScript(() =>
        Object.defineProperty(window, "__TAURI_INTERNALS__", {
          value: {
            invoke: async (command: string, args: { pageOptions?: { orientation: string } }) => {
              if (command === "get_windows_page_geometry") {
                const landscape = args.pageOptions?.orientation === "landscape";
                return {
                  widthMm: landscape ? 297 : 210,
                  heightMm: landscape ? 210 : 297,
                  printableBoundsMm: {
                    left: 3,
                    top: 7,
                    right: landscape ? 292 : 205,
                    bottom: landscape ? 206 : 293,
                  },
                  guardMm: 0.5,
                  deviceDpiX: 600,
                  deviceDpiY: 600,
                  fingerprint: "simulated-office-a4",
                };
              }
              return true;
            },
          },
        }),
      );
      await page.route("**/api/**", async (route) => {
        const path = new URL(route.request().url()).pathname.replace(/^\/api/, "");
        if (path === `/station/branding/logo/${revision}`)
          return route.fulfill({ body, contentType: "image/webp" });
        if (path === "/station/branding")
          return route.fulfill({
            json: {
              organizationName: "ООО «Реальный завод»",
              organizationInn: companyLogo ? "9705119097" : null,
              logoRevision: companyLogo ? revision : null,
              logoUrl: companyLogo ? `/station/branding/logo/${revision}` : null,
              logo: companyLogo
                ? {
                    contentType: "image/webp",
                    byteSize: body.length,
                    checksum: createHash("sha256").update(body).digest("hex"),
                    width: 900,
                    height: 90,
                  }
                : null,
            },
          });
        if (path === "/shifts/box-label-templates")
          return route.fulfill({
            json: {
              items: [
                {
                  id: "box-template",
                  name: "Короб",
                  widthMm: 58,
                  heightMm: 40,
                  dpi: 203,
                  language: "zpl",
                },
              ],
              defaultBoxLabelTemplateId: "box-template",
            },
          });
        if (path === "/shifts/label-template-preview") return route.fulfill({ json: {} });
        if (path === "/shifts/pallet-sheet-templates")
          return route.fulfill({
            json: {
              items: [
                {
                  id: template.id,
                  name: template.name,
                  revision: 2,
                  format: "pallet_sheet_v2",
                  page: template.spec.page,
                },
              ],
              defaultPalletSheetTemplateId: template.id,
              defaultSource: "organization",
            },
          });
        if (path === "/shifts/pallet-sheet-template-preview")
          return route.fulfill({ json: template });
        if (path === "/shifts" && route.request().method() === "POST") {
          posts.push(route.request().postDataJSON());
          return route.fulfill({ json: { id: "shift", status: "planned", mode: "aggregation" } });
        }
        if (path === "/shifts/shift/open")
          return route.fulfill({ json: { id: "shift", status: "active", mode: "aggregation" } });
        return route.fulfill({ status: 404, json: { message: `Unexpected ${path}` } });
      });
      await page.setViewportSize({ width: 1024, height: 768 });
      await page.goto(`/test/browser/pallet-sheet.html?id=${randomUUID()}`);
      await expect(page.locator("html")).toHaveAttribute("data-ready", "true");
      await page.getByRole("button", { name: "Агрегация", exact: true }).click();
      await page.getByRole("button", { name: "С паллетами", exact: true }).click();
      await page.getByRole("button", { name: "Начать", exact: true }).click();
      await page.getByRole("button", { name: "Далее", exact: true }).click();
      const canvas = page.getByRole("img", { name: `Предпросмотр палеты А4: ${template.name}` });
      const portrait = preset.spec.page.orientation === "portrait";
      await expect(canvas).toHaveAttribute("width", portrait ? "2480" : "3508");
      await expect(canvas).toHaveAttribute("height", portrait ? "3508" : "2480");
      const bounds = await canvas.evaluate((node: HTMLCanvasElement, margin: number) => {
        const sheet = node.getBoundingClientRect();
        const area = node.parentElement!.getBoundingClientRect();
        const ctx = node.getContext("2d")!;
        // The first 16-mm header logo starts at the template's 7/10-mm margin.
        const x = Math.ceil((margin * 300) / 25.4);
        const data = ctx.getImageData(x, Math.ceil((10 * 300) / 25.4), 80, 80).data;
        return {
          width: sheet.width,
          height: sheet.height,
          ratio: node.width / node.height,
          fits:
            sheet.top >= area.top - 1 &&
            sheet.bottom <= area.bottom + 1 &&
            sheet.left >= area.left - 1 &&
            sheet.right <= area.right + 1,
          footerInk: Array.from(
            ctx.getImageData(
              x,
              node.height - Math.ceil((17 * 300) / 25.4),
              node.width / (margin === 7 ? 2 : 1) - 2 * x,
              Math.floor((7 * 300) / 25.4),
            ).data,
          ).some((v, i) => i % 4 === 0 && v < 128),
          logoInk: Array.from(data).some((v, i) => i % 4 === 0 && v < 128),
        };
      }, preset.spec.page.marginsMm.left);
      expect(bounds.fits).toBe(true);
      expect(bounds.width / bounds.height).toBeCloseTo(bounds.ratio, 2);
      expect(bounds.logoInk).toBe(true);
      expect(bounds.footerInk).toBe(true);
      await page.screenshot({ path: testInfo.outputPath("selected-a4.png"), fullPage: true });
      await page.getByRole("button", { name: "Начать", exact: true }).click();
      await expect(page.locator("html")).toHaveAttribute("data-started", "true");
      expect(posts).toEqual([
        expect.objectContaining({
          palletSheetTemplateId: template.id,
          palletLabelTemplateId: null,
          boxLabelTemplateId: "box-template",
        }),
      ]);
    });
  }
}

test("A4 setup sends a real-font test sheet through the sheet transport", async ({
  page,
}, testInfo) => {
  const printed: { orientation: string; payloadBase64: string }[] = [];
  await page.exposeFunction(
    "recordA4Test",
    (args: { pageOptions: { orientation: string }; payloadBase64: string }) => {
      printed.push({
        orientation: args.pageOptions.orientation,
        payloadBase64: args.payloadBase64,
      });
    },
  );
  await page.addInitScript(() =>
    Object.defineProperty(window, "__TAURI_INTERNALS__", {
      value: {
        invoke: async (
          command: string,
          args: { queue: string; documentName: string; pageOptions: { orientation: string } },
        ) => {
          if (command === "get_windows_page_geometry") {
            const landscape = args.pageOptions.orientation === "landscape";
            return {
              widthMm: landscape ? 297 : 210,
              heightMm: landscape ? 210 : 297,
              printableBoundsMm: {
                left: 3,
                top: 3,
                right: landscape ? 294 : 207,
                bottom: landscape ? 207 : 294,
              },
              guardMm: 0.5,
              deviceDpiX: 600,
              deviceDpiY: 600,
              fingerprint: "test-office",
            };
          }
          if (command === "preflight_windows_raster") return { ok: true };
          if (command === "print_windows_raster") {
            await (
              window as unknown as { recordA4Test: (args: unknown) => Promise<void> }
            ).recordA4Test(args);
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
  await page.route("**/api/station/branding", (route) =>
    route.fulfill({
      json: { organizationName: "Тестовый завод", logoRevision: null, logoUrl: null, logo: null },
    }),
  );
  await page.setViewportSize({ width: 1024, height: 768 });
  await page.goto(`/test/browser/pallet-sheet.html?id=${randomUUID()}&setup`);
  await expect(page.locator("html")).toHaveAttribute("data-ready", "true");
  await page.getByRole("button", { name: "Настроить Office A4", exact: true }).click();
  await page.getByRole("button", { name: "Тестовая печать", exact: true }).click();
  await expect.poll(() => printed.length).toBe(1);
  const canvas = page.locator(".setup-a4-preview canvas");
  await expect(canvas).toHaveAttribute("width", "2480");
  await expect(canvas).toHaveAttribute("height", "3508");
  expect(printed[0]?.orientation).toBe("portrait");
  await page.screenshot({ path: testInfo.outputPath("a4-test-portrait.png"), fullPage: true });
  await page.getByRole("combobox", { name: "Ориентация тестового А4" }).selectOption("landscape");
  await page.getByRole("button", { name: "Тестовая печать", exact: true }).click();
  await expect.poll(() => printed.length).toBe(2);
  await expect(canvas).toHaveAttribute("width", "3508");
  await expect(canvas).toHaveAttribute("height", "2480");
  expect(printed[1]?.orientation).toBe("landscape");
  expect(printed[1]?.payloadBase64).not.toBe(printed[0]?.payloadBase64);
  await page.screenshot({ path: testInfo.outputPath("a4-test-landscape.png"), fullPage: true });
});
