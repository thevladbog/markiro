import { expect, test } from "@playwright/test";
import { randomUUID } from "node:crypto";
import {
  buildPalletSheetPresets,
  createPalletSheetSnapshot,
  makePalletLabelSource,
  productLabelValueDigest,
  sheetLogoFingerprint,
  PALLET_REPRINT_PROTOCOL,
  PALLET_REPRINT_V2_PROTOCOL,
  warehouseBoxTemplate,
} from "../../../packages/domain/src/index.js";
const scenarios = [1024, 1280].flatMap((width) =>
  ["ru", "en"].flatMap((lang) =>
    ["dark", "light"].map((theme) => ({ width, height: width === 1024 ? 768 : 800, lang, theme })),
  ),
);
for (const scenario of scenarios)
  test(`full pallet reprint ${scenario.lang} ${scenario.theme} ${scenario.width} previews whole A4 and sends only after confirmation`, async ({
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
          invoke: async (
            command: string,
            args: { queue?: string; documentName?: string; pageOptions?: { orientation?: string } },
          ) => {
            if (command === "get_windows_page_geometry")
              return {
                widthMm: args.pageOptions?.orientation === "landscape" ? 297 : 210,
                heightMm: args.pageOptions?.orientation === "landscape" ? 210 : 297,
                printableBoundsMm: {
                  left: 3,
                  top: 7,
                  right: args.pageOptions?.orientation === "landscape" ? 293 : 205,
                  bottom: args.pageOptions?.orientation === "landscape" ? 205 : 293,
                },
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
    const box = warehouseBoxTemplate();
    const templates = buildPalletSheetPresets().map((p) => {
      const snapshot = createPalletSheetSnapshot({
        id: randomUUID(),
        name: p.name,
        revision: 1,
        spec: p.spec,
      });
      return {
        kind: "a4",
        id: snapshot.id,
        name: p.name,
        snapshot,
        snapshotDigest: productLabelValueDigest(snapshot),
      };
    });
    let unavailable = false;
    await page.route("**/api/station/warehouse-reprint/**", (route) => {
      const path = new URL(route.request().url()).pathname;
      return route.fulfill({
        json: path.endsWith("source-capabilities")
          ? { protocols: [PALLET_REPRINT_PROTOCOL, PALLET_REPRINT_V2_PROTOCOL] }
          : path.endsWith("pallet-templates-v2")
            ? { protocol: PALLET_REPRINT_V2_PROTOCOL, templates }
            : path.endsWith("/templates")
              ? {
                  protocol: "warehouse-label-reprint-v1",
                  revision: "a".repeat(64),
                  templates: [box],
                }
              : unavailable && path.endsWith("pallet-lookup-v2")
                ? {
                    status: "unavailable",
                    code: "delivery_unresolved",
                    diagnostic: {
                      kind: "delivery_unknown",
                      sscc: source.sscc,
                      sourceRevision: source.revision,
                      attemptId: "original-unknown",
                      productionSequence: 2,
                      originDeviceId: "00000000-0000-4000-8000-000000000099",
                      shiftId: source.shiftId,
                    },
                  }
                : { status: "found", source },
      });
    });
    await page.route("**/api/station/config*", (route) =>
      route.fulfill({ json: { defaultBoxLabelTemplateId: box.id } }),
    );
    await page.setViewportSize({ width: scenario.width, height: scenario.height });
    await page.goto(
      `/test/browser/pallet-reprint.html?id=${randomUUID()}&lang=${scenario.lang}&theme=${scenario.theme}`,
    );
    await expect(page.locator("html")).toHaveAttribute("data-ready", "true");
    const ru = scenario.lang === "ru";
    await expect(
      page.getByRole("button", { name: ru ? "Палета" : "Pallet", exact: true }),
    ).toBeEnabled();
    await expect(page.getByTestId("warehouse-reprint-screen")).toBeVisible();
    await page.getByRole("button", { name: ru ? "Палета" : "Pallet", exact: true }).click();
    const main = page.getByTestId("warehouse-pallet-screen");
    await expect(main).toBeVisible();
    expect(
      await page
        .locator(".warehouse-reprint-mode-panel")
        .evaluate((el) => Number.parseFloat(getComputedStyle(el).paddingLeft)),
    ).toBeGreaterThan(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      scenario.width,
    );
    await expect(main.locator(".warehouse-session-panel")).toBeVisible();
    await expect(
      page.getByRole("button", { name: ru ? "Завершить сеанс" : "Finish session", exact: true }),
    ).toBeInViewport();
    const manual = page.getByRole("button", {
      name: ru ? "Ввести код вручную" : "Enter code manually",
      exact: true,
    });
    const lookup = async () => {
      await manual.click();
      await page.screenshot({ path: testInfo.outputPath("manual-dialog.png"), fullPage: true });
      await page
        .getByRole("textbox", {
          name: ru
            ? "SSCC палеты, короба или код продукции"
            : "Pallet SSCC, box SSCC or product code",
        })
        .fill(source.sscc);
      await page
        .getByRole("button", { name: ru ? "Найти палету" : "Find pallet", exact: true })
        .click();
    };
    await lookup();
    const canvas = page.getByRole("img", {
      name: scenario.lang === "ru" ? "Сохранённая этикетка палеты" : "Saved pallet label",
    });
    await expect(canvas).toHaveAttribute("width", "2480");
    await expect(canvas).toHaveAttribute("height", "3508");
    await expect(page.getByText("48", { exact: true })).toBeVisible();
    expect(printed).toBe(0);
    await page.screenshot({ path: testInfo.outputPath("pallet-confirmation.png"), fullPage: true });
    await page.getByRole("button", { name: ru ? "Отмена" : "Cancel", exact: true }).click();
    expect(printed).toBe(0);
    await expect(canvas).toHaveCount(0);
    await lookup();
    await expect(canvas).toBeVisible();
    await page.getByRole("button", { name: ru ? "Выбрать шаблоны" : "Choose templates" }).click();
    await expect(page.getByRole("dialog")).toBeVisible();
    const landscape = templates[1],
      split = templates[2];
    if (!landscape || !split) throw new Error("Missing A4 presets");
    await page.getByRole("button", { name: split.name, exact: false }).click();
    await page.getByRole("button", { name: ru ? "Применить шаблоны" : "Apply templates" }).click();
    await expect(canvas).toHaveAttribute("width", "3508");
    await expect(canvas).toHaveAttribute("height", "2480");
    await expect(
      page.getByText(ru ? "А4 · 1 лист · Этикеток палеты: 2" : "A4 · 1 sheet · Pallet labels: 2"),
    ).toBeVisible();
    expect(printed).toBe(0);
    const cardBounds = await main.locator(".warehouse-pallet-card").boundingBox();
    const footerBounds = await main.locator(".warehouse-footer").boundingBox();
    if (!cardBounds || !footerBounds) throw new Error("Missing layout bounds");
    expect(cardBounds.y + cardBounds.height).toBeLessThanOrEqual(footerBounds.y);
    await page.screenshot({ path: testInfo.outputPath("selected-two-a5.png"), fullPage: true });
    await page.getByRole("button", { name: ru ? "Выбрать шаблоны" : "Choose templates" }).click();
    await page.getByRole("button", { name: landscape.name, exact: false }).click();
    await page.getByRole("button", { name: ru ? "Применить шаблоны" : "Apply templates" }).click();
    await expect(canvas).toHaveAttribute("width", "3508");
    await expect(canvas).toHaveAttribute("height", "2480");
    await page.screenshot({ path: testInfo.outputPath("selected-landscape.png"), fullPage: true });
    await page
      .getByRole("button", { name: ru ? "Подтвердить печать" : "Confirm printing" })
      .click();
    await expect.poll(() => printed).toBe(1);
    await expect(
      page.getByText(ru ? "Передано на принтер" : "Sent to printer", { exact: true }),
    ).toBeVisible();
    await expect(main.locator(".warehouse-sent-count")).toHaveText("1");
    await page.getByRole("button", { name: ru ? "Изменить причину" : "Change reason" }).click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await page.getByRole("button", { name: ru ? "Применить причину" : "Apply reason" }).click();
    unavailable = true;
    await lookup();
    await expect(
      page.getByText(
        ru
          ? "Разрешите исходную попытку на станции, где печатали эту палету."
          : "Resolve the original attempt at the station that printed this pallet.",
      ),
    ).toBeVisible();
    await expect(main.locator(".warehouse-pallet-card")).toHaveCount(0);
    await expect(
      main.getByRole("button", {
        name: ru ? "Подтвердить исходный отпечаток" : "Confirm original print",
      }),
    ).toHaveCount(0);
    await page.screenshot({
      path: testInfo.outputPath("original-delivery-diagnostic.png"),
      fullPage: true,
    });
    expect(printed).toBe(1);
  });
