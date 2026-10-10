import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { productLabelsEndpoints } from "../product-labels.playwright.config.js";
const origin = productLabelsEndpoints().adminUrl;
for (const preset of ["pallet-a4-portrait", "pallet-a4-two-a5"]) {
  test(`${preset} actual private WebP branding matches Station decoder`, async ({ page }, info) => {
    const body = readFileSync(
      new URL("../../../apps/admin/test/browser/branding-company.webp", import.meta.url),
    );
    const revision = "a1111111-1111-4111-8111-111111111111";
    await page.route("**/api/org/profile/print-branding**", async (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path.endsWith(`/logo/${revision}`))
        return route.fulfill({ body, contentType: "image/webp" });
      return route.fulfill({
        json: {
          organizationName: "ООО «Реальный завод»",
          logoRevision: revision,
          logoUrl: `/org/profile/print-branding/logo/${revision}`,
          logo: {
            contentType: "image/webp",
            byteSize: body.length,
            checksum: createHash("sha256").update(body).digest("hex"),
            width: 900,
            height: 90,
          },
        },
      });
    });
    await page.goto(`${origin}/test/browser/pallet-sheet-template.html?branding&preset=${preset}`);
    await expect(page.locator("html")).toHaveAttribute("data-sheet-ready", "true");
    await expect(page.locator("html")).toHaveAttribute("data-branding-parity", "true");
    await expect(page.locator("html")).toHaveAttribute(
      "data-branding-name",
      "ООО «Реальный завод»",
    );
    await expect(page.locator("html")).toHaveAttribute("data-branding-size", "900x90");
    await page.screenshot({
      path: info.outputPath("private-company-branding.png"),
      fullPage: true,
    });
  });
}
for (const preset of ["pallet-a4-portrait", "pallet-a4-landscape", "pallet-a4-two-a5"]) {
  for (const scenario of ["", "&noDate&noEgais&long", "&wide&max"]) {
    test(`${preset} real font preview ${scenario || "standard"} matches Station pixels`, async ({
      page,
    }, info) => {
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.goto(
        `${origin}/test/browser/pallet-sheet-template.html?preset=${preset}${scenario}`,
      );
      if (preset === "pallet-a4-landscape" && scenario.includes("long")) {
        await expect(page.locator("html")).toHaveAttribute(
          "data-sheet-error",
          /product: Complete text does not fit/,
        );
        expect(errors).toEqual([]);
        return;
      }
      await expect(page.locator("html")).toHaveAttribute("data-sheet-ready", "true");
      await expect(page.locator("html")).toHaveAttribute("data-sheet-parity", "true");
      await page.locator("canvas").screenshot({ path: info.outputPath("sheet.png") });
      expect(errors).toEqual([]);
    });
  }
}
import { readFile } from "node:fs/promises";
test("A4 editor saves, exports and imports a new template with equivalent editable content", async ({
  page,
}, info) => {
  const records = new Map<string, Record<string, unknown>>();
  let counter = 0;
  await page.route("**/api/**", async (route) => {
    const request = route.request(),
      url = new URL(request.url());
    if (!url.pathname.startsWith("/api/")) return route.continue();
    if (url.pathname === "/api/org/profile/print-branding")
      return route.fulfill({
        json: {
          organizationName: "ООО «Тестовый завод»",
          logoRevision: null,
          logoUrl: null,
          logo: null,
        },
      });
    if (url.pathname.endsWith("chz-product-groups")) return route.fulfill({ json: { items: [] } });
    if (request.method() === "POST" && url.pathname.endsWith("label-templates")) {
      const payload = request.postDataJSON() as Record<string, unknown>;
      const id = `sheet-${++counter}`;
      expect(payload).not.toHaveProperty("id");
      expect(payload).not.toHaveProperty("expectedRevision");
      const record = { ...payload, id, revision: 1 };
      records.set(id, record);
      return route.fulfill({ status: 201, json: record });
    }
    const record = records.get(url.pathname.split("/").at(-1) ?? "");
    return route.fulfill({ json: record ?? { items: [] } });
  });
  const url = `${origin}/test/browser/pallet-sheet-template.html?editor&preset=pallet-a4-two-a5`;
  await page.goto(url);
  await page.getByLabel("Название шаблона").fill("Editable A4");
  await page.getByRole("button", { name: "Поле · product", exact: true }).click();
  await page.getByLabel("Максимум строк", { exact: true }).fill("6");
  await page.getByRole("button", { name: "Логотип организации · logo", exact: true }).click();
  await page.getByLabel("Максимальная высота логотипа, мм").fill("13");
  await page.getByRole("button", { name: "Сохранить", exact: true }).click();
  await expect.poll(() => records.size).toBe(1);
  await expect(page.locator('canvas[data-sheet-ready="true"]')).toBeVisible();
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Экспорт JSON" }).click();
  const download = await downloadPromise;
  const path = info.outputPath("exported-sheet.json");
  await download.saveAs(path);
  const exported = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
  expect(exported).not.toHaveProperty("id");
  expect(exported).not.toHaveProperty("revision");
  await page.goto(url);
  await page.getByRole("button", { name: "Импорт JSON" }).click();
  await page.getByLabel("Файл JSON").setInputFiles(path);
  await expect(page.getByLabel("JSON шаблона")).not.toHaveValue("");
  await page.getByRole("button", { name: "Проверить JSON" }).click();
  await page.getByRole("button", { name: "Применить" }).click();
  await page.getByRole("button", { name: "Сохранить", exact: true }).click();
  await expect.poll(() => records.size).toBe(2);
  expect(records.get("sheet-2")?.spec).toEqual(records.get("sheet-1")?.spec);
  await expect(page.locator('canvas[data-sheet-ready="true"]')).toBeVisible();
  await page.screenshot({ path: info.outputPath("editor-round-trip.png"), fullPage: true });
});
test("canvas element moves by keyboard and pointer in physical millimetres", async ({
  page,
}, info) => {
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (!path.startsWith("/api/")) return route.continue();
    return route.fulfill({
      json:
        path === "/api/org/profile/print-branding"
          ? {
              organizationName: "ООО «Тестовый завод»",
              logoRevision: null,
              logoUrl: null,
              logo: null,
            }
          : { items: [] },
    });
  });
  await page.goto(`${origin}/test/browser/pallet-sheet-template.html?editor&preset=blank`);
  await page
    .getByRole("button", { name: "Добавить: Область свободного размещения", exact: true })
    .click();
  await expect(page.locator('canvas[data-sheet-ready="true"]')).toBeVisible();
  const overlay = page
    .locator('.sheet-preview button[aria-label^="Свойства элемента"]')
    .filter({ hasNot: page.locator('[aria-label*="sscc"]') })
    .first();
  await overlay.click();
  await overlay.press("ArrowRight");
  await expect(page.getByLabel("X, мм", { exact: true })).toHaveValue("1");
  await expect(page.locator('canvas[data-sheet-ready="true"]')).toBeVisible();
  const box = await overlay.boundingBox();
  if (!box) throw new Error("Overlay missing");
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 20, box.y + box.height / 2);
  await page.mouse.up();
  await expect(page.getByLabel("X, мм", { exact: true })).toHaveValue("11");
  await page.getByRole("button", { name: "Отменить изменение" }).click();
  await expect(page.getByLabel("X, мм", { exact: true })).toHaveValue("1");
  await page.screenshot({ path: info.outputPath("canvas-placement.png"), fullPage: true });
});
