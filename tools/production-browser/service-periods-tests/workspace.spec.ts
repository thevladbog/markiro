import type { Page, TestInfo } from "@playwright/test";
import { expect, monthlyService, test } from "./fixture.js";

async function noPageOverflow(page: Page) {
  const dimensions = await page.evaluate(() => ({
    width: document.documentElement.scrollWidth,
    viewport: window.innerWidth,
  }));
  expect(dimensions.width).toBeLessThanOrEqual(dimensions.viewport);
}

async function shot(page: Page, info: TestInfo, name: string) {
  await page.evaluate(() => {
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    window.scrollTo(0, 0);
  });
  await page.screenshot({ path: info.outputPath(`${name}.png`), fullPage: true });
}

for (const viewport of [
  { width: 1280, height: 800 },
  { width: 390, height: 844 },
]) {
  for (const locale of ["ru", "en"] as const) {
    test(`monthly catalog and service workspace ${viewport.width} ${locale}`, async ({
      page,
      fixture,
    }, info) => {
      const ru = locale === "ru";
      await page.setViewportSize(viewport);
      await page.goto("/catalog");
      await page.getByRole("button", { name: locale.toUpperCase(), exact: true }).click();
      await page.getByRole("tab", { name: ru ? "Услуги" : "Services" }).click();
      await expect(
        page.getByRole("button", {
          name: new RegExp(monthlyService.nameRu),
        }),
      ).toBeVisible();
      await expect(page.getByText(/30000\.00/)).toBeVisible();
      await noPageOverflow(page);
      await shot(page, info, `catalog-${locale}-${viewport.width}`);

      if (viewport.width < 900) {
        await page.getByRole("button", { name: ru ? "Меню" : "Menu" }).click();
      }
      await page.getByRole("link", { name: ru ? "Услуги" : "Services", exact: true }).click();
      await expect(
        page.getByRole("heading", { level: 1, name: ru ? "Периоды услуг" : "Service periods" }),
      ).toBeVisible();
      await expect(page.getByText("75 / 210")).toBeVisible();
      await expect(page.getByText("90 / 90")).toBeVisible();
      await page
        .getByRole("row", { name: new RegExp(ru ? monthlyService.nameRu : monthlyService.nameEn) })
        .getByRole("button", { name: ru ? "Открыть" : "Open" })
        .click();
      await expect(page).toHaveURL(/service-periods$/);
      const dialog = page.getByRole("dialog");
      await expect(
        dialog.getByRole("listitem").filter({ hasText: "SUP-42 · 60 / 60" }),
      ).toBeVisible();
      const correction = dialog.getByRole("listitem").filter({ hasText: "SUP-42 · -5 / -5" });
      await expect(correction).toContainText("Уточнение фактического времени");
      const defect = dialog.getByRole("listitem").filter({ hasText: "BUG-7 · 20 / 0" });
      await expect(defect).toContainText(
        ru ? "Не списывается из пакета" : "Not deducted from package",
      );
      await expect(dialog.getByText("30", { exact: true })).toBeVisible();
      await expect(dialog.getByText(/Синтетическая внутренняя заметка/)).toBeVisible();
      await noPageOverflow(page);
      await shot(page, info, `workspace-${locale}-${viewport.width}`);
      expect(fixture.unhandled).toEqual([]);
    });
  }
}
