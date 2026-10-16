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
  });
  await page.screenshot({ path: info.outputPath(`${name}.png`) });
}

for (const viewport of [
  { width: 1440, height: 1000 },
  { width: 390, height: 844 },
]) {
  for (const locale of ["ru", "en"] as const) {
    test(`offline license dialog of a tenant without a cabinet ${viewport.width} ${locale}`, async ({
      page,
      fixture,
    }, info) => {
      const ru = locale === "ru";
      fixture.offlineAssignments = true;
      await page.setViewportSize(viewport);
      await page.goto(`/tenants/${TENANT_ID}?tab=equipment`);
      await page.getByRole("button", { name: locale.toUpperCase(), exact: true }).click();

      await expect(
        page.getByText(
          ru
            ? "Клиент без кабинета: лицензия выпускается по его назначениям — тариф и дополнения с карточки клиента. Облачный доступ не открывается."
            : "A tenant without a cabinet: the license is issued from its assignments — the plan and add-ons on the tenant card. No cloud access is opened.",
        ),
      ).toBeVisible();
      await page
        .getByRole("button", {
          name: ru ? "Выпустить офлайн-лицензию: Цех розлива" : /Issue offline license: /,
        })
        .click();
      const dialog = page.getByRole("dialog");
      await expect(dialog).toBeVisible();

      const summary = dialog.getByRole("region", {
        name: ru ? "Права из назначений клиента" : "Rights from the tenant's assignments",
      });
      await expect(summary).toBeVisible();
      await expect(summary.getByText(ru ? /^Тариф: Автоном/ : /^Plan: Standalone/)).toBeVisible();
      await expect(
        summary.getByText(ru ? /^Дополнение: Дополнительная станция/ : /^Add-on: Extra station/),
      ).toBeVisible();
      const link = summary.getByRole("link", {
        name: ru ? "Изменить права клиента" : "Change the tenant's rights",
      });
      await expect(link).toHaveAttribute("href", `/tenants/${TENANT_ID}#tenant-subscription`);
      // No manual offline section any more: there is no term field or plan picker.
      await expect(dialog.getByRole("group", { name: ru ? "Офлайн" : "Offline" })).toHaveCount(0);

      await dialog.getByRole("button", { name: ru ? "Предпросмотр" : "Preview" }).click();
      await expect(
        dialog.getByRole("table", { name: ru ? "Было → станет" : "Before → after" }),
      ).toBeVisible();
      await noPageOverflow(page);
      await shot(page, info, `offline-license-dialog-${locale}-${viewport.width}`);
      expect(fixture.unhandled).toEqual([]);
    });
  }
}
