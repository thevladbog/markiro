import type { Page, TestInfo } from "@playwright/test";
import { expect, TENANT_ID, test } from "./fixture.js";

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
  { width: 1440, height: 1000 },
  { width: 390, height: 844 },
]) {
  for (const locale of ["ru", "en"] as const) {
    test(`tenant equipment workspace ${viewport.width} ${locale}`, async ({
      page,
      fixture,
    }, info) => {
      const ru = locale === "ru";
      await page.setViewportSize(viewport);
      await page.goto(`/tenants/${TENANT_ID}?tab=equipment`);
      await page.getByRole("button", { name: locale.toUpperCase(), exact: true }).click();

      await expect(
        page.getByRole("heading", {
          level: 2,
          name: ru ? "Контур оборудования" : "Equipment operations",
        }),
      ).toBeVisible();
      await expect(page.getByText("Линия розлива 1")).toBeVisible();
      await expect(page.getByText(ru ? "3 устройства" : "3 devices")).toBeVisible();
      await noPageOverflow(page);
      await shot(page, info, `tenant-equipment-${locale}-${viewport.width}`);
      expect(fixture.unhandled).toEqual([]);
    });
  }
}
