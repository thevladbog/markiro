import { test, expect } from "@playwright/test";
for (const viewport of [
  { width: 1280, height: 800 },
  { width: 1024, height: 768 },
])
  test(`warehouse picker and ready at ${viewport.width}`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await page.goto("/?gallery=1&state=warehouse-reprint-ready&locale=ru");
    await expect(page.getByRole("heading", { name: "Повторная печать этикеток" })).toBeVisible();
    await expect(page.getByText("Отсканируйте код единицы или короба")).toBeVisible();
    const manual = page.locator("header").getByRole("button", { name: "Ввести код вручную" });
    await expect(manual).toBeVisible();
    await expect(manual).toBeEnabled();
    await expect(manual).toBeInViewport();
    await page.getByRole("button", { name: "Выбрать шаблоны" }).click();
    await page.getByRole("button", { name: "Короба · SSCC" }).click();
    await expect(page.getByRole("img", { name: /Предпросмотр/ })).toBeVisible();
    await expect(page.locator("[data-raster-element]").first()).toBeVisible();
    await expect(page.getByRole("button", { name: "Применить шаблоны" })).toBeInViewport();
    await page.screenshot({ path: `/tmp/warehouse-preview-${viewport.width}.png` });
    await page.getByRole("button", { name: "Отмена" }).click();
    await expect(page.getByText("Коды: Только код")).toBeVisible();
    await expect(page.getByText("Короба: Коробка 58×40")).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    expect(await page.evaluate(() => document.documentElement.scrollHeight <= innerHeight)).toBe(
      true,
    );
    await page.getByRole("button", { name: "Ввести код вручную" }).click();
    const field = page.getByRole("textbox", { name: "Номер короба или полный код единицы" });
    await expect(field).toBeFocused();
    await field.fill("346006820000000015");
    await field.press("Tab");
    await expect(page.getByRole("button", { name: "Найти и перепечатать" })).toBeDisabled();
    await field.fill("346006820000000014");
    await expect(page.getByRole("button", { name: "Найти и перепечатать" })).toBeEnabled();
    await page.screenshot({ path: `/tmp/warehouse-manual-${viewport.width}.png` });
    await field.press("Enter");
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await page.getByRole("button", { name: "Ввести код вручную" }).click();
    await expect(
      page.getByRole("textbox", { name: "Номер короба или полный код единицы" }),
    ).toHaveValue("");
    await page.getByRole("textbox").press("Escape");
    await expect(page.getByRole("button", { name: "Ввести код вручную" })).toBeFocused();
    await page.screenshot({ path: `/tmp/warehouse-reprint-${viewport.width}.png` });
  });
for (const viewport of [
  { width: 1280, height: 800 },
  { width: 1024, height: 768 },
])
  test(`legacy recovery makes corrected output explicit at ${viewport.width}`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await page.goto("/?gallery=1&state=warehouse-reprint-legacy-sent&locale=ru");
    await expect(page.getByText("Этикетка передана на принтер")).toBeVisible();
    await expect(page.getByText(/Распознана старая этикетка с !1/)).toBeVisible();
    await expect(
      page.locator("header").getByRole("button", { name: "Ввести код вручную" }),
    ).toBeEnabled();
    const retry = page.getByRole("button", { name: "Напечатать ещё раз" });
    await expect(retry).toBeInViewport();
    const recovery = await page.locator(".warehouse-recovery-actions").boundingBox();
    const footer = await page.locator(".warehouse-footer").boundingBox();
    expect(recovery).not.toBeNull();
    expect(footer).not.toBeNull();
    if (recovery && footer) expect(recovery.y + recovery.height).toBeLessThanOrEqual(footer.y);
    await page.screenshot({ path: `/tmp/warehouse-legacy-${viewport.width}.png` });
  });
test("unknown recovery remains explicit in English", async ({ page }) => {
  await page.goto("/?gallery=1&state=warehouse-reprint-unknown&locale=en");
  await expect(page.getByText("Label delivery is unknown")).toBeVisible();
  await expect(page.getByRole("button", { name: "Print again" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Check the new label" })).toBeVisible();
  await expect(
    page.locator("header").getByRole("button", { name: "Enter code manually" }),
  ).toBeDisabled();
});
