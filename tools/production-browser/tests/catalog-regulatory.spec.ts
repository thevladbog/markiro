import { expect, test, type Page } from "@playwright/test";
import {
  product,
  profile,
  PRODUCT_ID,
} from "../../../apps/admin/test/catalog-regulatory-fixtures.js";

function browserProfile(group: number) {
  const result = profile(group);
  for (const attribute of result.definition.attributes) {
    if (attribute.id === "sweet")
      attribute.label =
        group === 23
          ? "Содержит подсластитель"
          : group === 33
            ? "Содержит добавки"
            : "Содержит отдушку";
    if (attribute.id === "sweetNames")
      attribute.label =
        group === 23
          ? "Наименования подсластителей"
          : group === 33
            ? "Наименования добавок"
            : "Наименования ароматических компонентов";
  }
  result.definition.attributes.push({
    id: "composition",
    label: group === 35 ? "Состав (INCI)" : "Состав",
    valueType: "string",
    multiplicity: "one",
    unit: null,
    requirementRules: [{ layer: "circulation", level: "mandatory", when: null }],
    presetMode: "none",
    presets: [],
  });
  return {
    ...result,
    binding: { ...result.binding, tnVedCode: group === 23 ? "2009719909" : null },
  };
}
const browserReadiness = {
  productId: PRODUCT_ID,
  dimensions: [
    { dimension: "production", state: "ready", reasons: [], recommendations: [] },
    { dimension: "code_ordering", state: "ready", reasons: [], recommendations: [] },
    {
      dimension: "circulation",
      state: "not_ready",
      reasons: [{ code: "ATTRIBUTE_REQUIRED", attributeId: "composition" }],
      recommendations: [],
    },
    { dimension: "egais", state: "not_applicable", reasons: [], recommendations: [] },
  ],
};

// Synthetic category examples exercise UI contracts only. No official schemas or live tenant data.
async function installApi(page: Page, group: number, readonly = false) {
  let current: unknown = browserProfile(group);
  const writes: { path: string; body: unknown }[] = [];
  const unexpected: string[] = [];
  await page.route(/^http:\/\/127\.0\.0\.1:\d+\/api\//, async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const json = (body: unknown, status = 200) =>
      route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
    if (path === "/api/profile")
      return json({ firstName: "Игорь", middleName: null, lastName: "Волков", hasAvatar: false });
    if (path === "/api/access/me")
      return json({
        roles: ["manager"],
        capabilities: readonly ? ["operations.read"] : ["operations.read", "operations.write"],
      });
    if (path === "/api/billing/attention") return json({ count: 0 });
    if (path === "/api/products") return json({ items: [product(group)] });
    if (path === "/api/pickup-orders" || path === "/api/counterparties") return json({ items: [] });
    if (path === "/api/chz-product-groups")
      return json({
        items: [
          {
            code: group,
            name:
              group === 23
                ? "Соки и безалкогольные напитки"
                : group === 33
                  ? "Растительные масла"
                  : "Косметика и бытовая химия",
            alias: "test",
          },
        ],
      });
    if (path === "/api/products/gtin-check")
      return json({ gtin14: product(group).gtin14, owner: "own" });
    if (path === `/api/products/${PRODUCT_ID}/regulatory-profile`) return json(current);
    if (path === `/api/products/${PRODUCT_ID}/readiness`) return json(browserReadiness);
    if (
      path === `/api/products/${PRODUCT_ID}/regulatory-attributes` &&
      request.method() === "PATCH"
    ) {
      const body: unknown = request.postDataJSON();
      writes.push({ path, body });
      current = {
        ...browserProfile(group),
        binding: { ...browserProfile(group).binding, revision: 5 },
        values: browserProfile(group).values.map((row) =>
          row.attributeId === "quantity"
            ? {
                ...row,
                source: "manual",
                value: { type: "decimal", value: "750", unit: group === 33 ? "г" : "мл" },
              }
            : row,
        ),
      };
      return json(current);
    }
    unexpected.push(`${request.method()} ${path}`);
    return route.abort();
  });
  return {
    writes,
    unexpected,
  };
}
for (const group of [23, 33, 35])
  for (const mobile of [false, true]) {
    test(`group ${group} ${mobile ? "mobile dark" : "desktop light"} preserves units, keyboard flow and drafts`, async ({
      page,
    }, testInfo) => {
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.setViewportSize(
        mobile ? { width: 390, height: 844 } : { width: 1366, height: 1000 },
      );
      await page.addInitScript(
        (theme) => localStorage.setItem("markiro.theme", theme),
        mobile ? "dark" : "light",
      );
      const api = await installApi(page, group);
      await page.goto(`/test/browser/production.html?route=/catalog/${PRODUCT_ID}/edit`);
      const panel = page.getByRole("dialog", { name: "Изменить продукт" });
      await expect(panel).toBeVisible();
      const quantity = panel.getByLabel(group === 33 ? "Масса нетто" : "Объём", { exact: true });
      await expect(quantity).toHaveValue("500");
      await expect(panel.getByLabel("Код ЕГАИС", { exact: true })).toHaveCount(0);
      await quantity.focus();
      await page.keyboard.press("Tab");
      await expect(
        panel.getByLabel(`Единица измерения: ${group === 33 ? "Масса нетто" : "Объём"}`, {
          exact: true,
        }),
      ).toBeFocused();
      await quantity.fill("750");
      await expect(panel.getByRole("button", { name: "Сохранить", exact: true })).toBeDisabled();
      await panel.getByRole("button", { name: "Закрыть", exact: true }).click();
      await page.getByRole("button", { name: "Продолжить редактирование", exact: true }).click();
      await expect(quantity).toHaveValue("750");
      await panel.getByRole("button", { name: "Сохранить характеристики", exact: true }).click();
      await expect
        .poll(() => api.writes)
        .toEqual([
          {
            path: `/api/products/${PRODUCT_ID}/regulatory-attributes`,
            body: {
              baseRevision: 4,
              values: [
                {
                  attributeId: "quantity",
                  value: { type: "decimal", value: "750", unit: group === 33 ? "г" : "мл" },
                },
              ],
            },
          },
        ]);
      await expect(panel).toBeVisible();
      await expect(quantity).toHaveValue("750");
      await expect(
        panel.getByRole("button", { name: "Сохранить характеристики", exact: true }),
      ).toBeDisabled();
      await expect(page.locator("form form")).toHaveCount(0);
      await expect
        .poll(() => panel.evaluate((element) => element.scrollWidth - element.clientWidth))
        .toBeLessThanOrEqual(1);
      await panel.getByRole("region", { name: "Характеристики категории" }).screenshot({
        path: testInfo.outputPath(`group-${group}-attributes.png`),
        animations: "disabled",
      });
      await panel.getByRole("region", { name: "Готовность" }).screenshot({
        path: testInfo.outputPath(`group-${group}-readiness.png`),
        animations: "disabled",
      });
      expect(api.unexpected).toEqual([]);
      expect(errors).toEqual([]);
    });
  }
test("English dark card and read-only route use the actual application access boundary", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1366, height: 1000 });
  await page.addInitScript(() => localStorage.setItem("markiro.theme", "dark"));
  const api = await installApi(page, 33, true);
  await page.goto("/test/browser/production.html?locale=en&route=/catalog");
  await page.getByRole("link", { name: "Масло подсолнечное", exact: true }).click();
  const panel = page.getByRole("dialog", { name: "Product details" });
  await expect(panel.getByRole("heading", { name: "Category attributes" })).toBeVisible();
  await expect(panel.getByRole("button", { name: "Save attributes" })).toHaveCount(0);
  await expect(panel.getByRole("button", { name: "Change category" })).toHaveCount(0);
  await expect(panel).not.toContainText("pages.catalog.");
  await panel.screenshot({
    path: testInfo.outputPath("readonly-en-dark.png"),
    animations: "disabled",
  });
  expect(api.writes).toEqual([]);
  expect(api.unexpected).toEqual([]);
});
