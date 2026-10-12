import { expect, test } from "@playwright/test";
import { productLabelsEndpoints } from "../product-labels.playwright.config.js";
test("A4 and thermal pallet defaults use one Save and one atomic profile request", async ({
  page,
}, testInfo) => {
  const puts: unknown[] = [];
  const profile = {
    gln: null,
    gs1Prefixes: [],
    inn: null,
    timeZone: "Europe/Moscow",
    defaultBoxLabelTemplateId: null,
    categoryBoxLabelTemplateDefaults: [],
    defaultPalletLabelTemplateId: "legacy",
    categoryPalletLabelTemplateDefaults: [],
    productGroupsInUse: [15],
    defaultPalletSheetTemplateId: null,
    categoryPalletSheetTemplateDefaults: [],
    pickupLimitsEnabled: false,
    logoUrl: null,
    logoRevision: null,
  };
  let savedProfile: Record<string, unknown> = profile;
  const sheet = {
    id: "sheet",
    name: "My A4",
    purpose: "pallet",
    format: "pallet_sheet_v2",
    revision: 1,
    page: { size: "A4", orientation: "portrait", copies: 1 },
    dpi: 300,
    enabled: true,
    chzProductGroupCodes: null,
  };
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (!path.startsWith("/api/")) return route.continue();
    if (path.endsWith("/org/profile") && route.request().method() === "PUT") {
      const body = route.request().postDataJSON();
      puts.push(body);
      savedProfile = { ...savedProfile, ...body };
      return route.fulfill({ json: savedProfile });
    }
    if (path.endsWith("/org/profile")) return route.fulfill({ json: savedProfile });
    if (path.endsWith("/profile/sscc")) return route.fulfill({ json: { counters: [] } });
    if (path.endsWith("chz-product-groups"))
      return route.fulfill({
        json: {
          items: [
            { code: 15, name: "Пиво", alias: "beer" },
            { code: 8, name: "Вода", alias: "water" },
          ],
        },
      });
    return route.fulfill({
      json: {
        items: [
          sheet,
          {
            ...sheet,
            id: "legacy",
            name: "Legacy",
            format: "label_v1",
            widthMm: 100,
            heightMm: 150,
            language: "zpl",
          },
        ],
      },
    });
  });
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`${productLabelsEndpoints().adminUrl}/test/browser/pallet-defaults.html`);
  const a4 = page.getByRole("combobox", { name: "Шаблон А4 для организации" });
  await a4.click();
  await page.getByRole("option", { name: "My A4", exact: true }).click();
  const thermal = page.getByRole("combobox", { name: "Шаблон этикетки палеты по умолчанию" });
  await thermal.click();
  await page.getByRole("option", { name: "Не выбран", exact: true }).click();
  await expect(page.getByRole("combobox", { name: "А4 для категории Пиво" })).toBeVisible();
  await expect(page.getByRole("combobox", { name: "А4 для категории Вода" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Сохранить настройки А4" })).toHaveCount(0);
  await a4
    .locator("xpath=ancestor::form")
    .getByRole("button", { name: "Сохранить", exact: true })
    .click();
  await expect.poll(() => puts.length).toBe(1);
  expect(puts[0]).toMatchObject({
    defaultPalletSheetTemplateId: "sheet",
    defaultPalletLabelTemplateId: null,
  });
  await expect(a4).toHaveText("My A4");
  await expect(thermal).toHaveText("Не выбран");
  await page.screenshot({
    path: testInfo.outputPath("common-pallet-defaults.png"),
    fullPage: true,
  });
});
