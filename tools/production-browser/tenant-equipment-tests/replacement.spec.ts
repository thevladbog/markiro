import { workflowPreparation } from "../../../apps/saas-admin/test/device-replacement-fixtures.js";
import { expect, TENANT_ID, test } from "./fixture.js";
for (const width of [1440, 390])
  for (const locale of ["ru", "en"] as const)
    for (const mode of ["ready", "recovery"] as const) {
      test(`replacement ${mode} ${locale} ${width}`, async ({ page, fixture }, info) => {
        fixture.replacement = workflowPreparation(
          mode === "ready" ? "ready" : "completed",
          mode === "ready" ? "not_required" : "required",
        );
        await page.setViewportSize({ width, height: 1000 });
        await page.goto(`/tenants/${TENANT_ID}?tab=equipment`);
        await page.getByRole("button", { name: locale.toUpperCase(), exact: true }).click();
        await page
          .locator("summary")
          .filter({ hasText: locale === "ru" ? "Замена устройства" : "Replace device" })
          .click();
        const panel = page.getByRole("region", {
          name: locale === "ru" ? "Сохранённая подготовка замены" : "Saved replacement preparation",
        });
        await expect(
          panel.getByText(locale === "ru" ? "Ревизия проекта" : "Preparation revision"),
        ).toBeVisible();
        await expect(
          panel.getByRole("button", {
            name:
              mode === "ready"
                ? locale === "ru"
                  ? "Рассчитать исполнение"
                  : "Preview execution"
                : locale === "ru"
                  ? "Выпустить код восстановления"
                  : "Issue source recovery code",
          }),
        ).toBeVisible();
        if (mode === "recovery")
          await expect(panel.locator('time[datetime="2026-09-18T12:30:00.000Z"]')).toBeVisible();
        await expect(panel).not.toContainText(/returned an object|deviceReplacement\./);
        await panel.scrollIntoViewIfNeeded();
        const overflow = await panel.evaluate((el) => ({
          width: el.scrollWidth,
          client: el.clientWidth,
        }));
        expect(overflow.width).toBeLessThanOrEqual(overflow.client);
        const height = await page.evaluate(() => document.documentElement.scrollHeight);
        await page.setViewportSize({ width, height });
        await page.evaluate(() => {
          if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
          window.scrollTo(0, 0);
        });
        await panel.screenshot({
          path: info.outputPath(`replacement-platform-${mode}-${locale}-${width}.png`),
        });
        expect(fixture.unhandled).toEqual([]);
      });
    }
