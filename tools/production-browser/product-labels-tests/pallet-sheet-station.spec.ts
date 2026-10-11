import { expect, test } from "@playwright/test";
import { randomUUID, createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  buildPalletSheetPresets,
  createPalletSheetSnapshot,
} from "../../../packages/domain/src/index.js";
test("Station selects a saved two-copy A4 template with private branding and actual printable bounds", async ({
  page,
}, testInfo) => {
  const preset = buildPalletSheetPresets()[2]!;
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
          logoRevision: revision,
          logoUrl: `/station/branding/logo/${revision}`,
          logo: {
            contentType: "image/webp",
            byteSize: body.length,
            checksum: createHash("sha256").update(body).digest("hex"),
            width: 900,
            height: 90,
          },
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
    if (path === "/shifts/pallet-sheet-template-preview") return route.fulfill({ json: template });
    if (path === "/shifts" && route.request().method() === "POST") {
      posts.push(route.request().postDataJSON());
      return route.fulfill({ json: { id: "shift", status: "planned", mode: "aggregation" } });
    }
    if (path === "/shifts/shift/open")
      return route.fulfill({ json: { id: "shift", status: "active", mode: "aggregation" } });
    return route.fulfill({ status: 404, json: { message: `Unexpected ${path}` } });
  });
  await page.setViewportSize({ width: 1280, height: 1024 });
  await page.goto(`/test/browser/pallet-sheet.html?id=${randomUUID()}`);
  await expect(page.locator("html")).toHaveAttribute("data-ready", "true");
  await page.getByRole("button", { name: "Агрегация", exact: true }).click();
  await page.getByRole("button", { name: "С паллетами", exact: true }).click();
  await page.getByRole("button", { name: "Начать", exact: true }).click();
  await page.getByRole("button", { name: "Далее", exact: true }).click();
  const canvas = page.getByRole("img", { name: `Предпросмотр палеты А4: ${template.name}` });
  await expect(canvas).toHaveAttribute("width", "3508");
  await expect(canvas).toHaveAttribute("height", "2480");
  await page.screenshot({ path: testInfo.outputPath("selected-two-a5.png"), fullPage: true });
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
