import { test, expect } from "@playwright/test";
import { resolveCabinetAccess } from "../../../packages/domain/src/access/cabinet.js";
import { pool, workflowPreparation } from "../../../apps/admin/test/device-replacement-fixtures.js";
for (const width of [1440, 390])
  for (const locale of ["ru", "en"] as const)
    for (const mode of ["ready", "recovery"] as const) {
      test(`replacement cabinet ${mode} ${locale} ${width}`, async ({ page }, info) => {
        const unexpected: string[] = [];
        await page.route(/^http:\/\/127\.0\.0\.1:\d+\/api\//, async (route) => {
          const path = new URL(route.request().url()).pathname;
          let json: unknown;
          if (path === "/api/access/me") json = resolveCabinetAccess("owner");
          else if (path === "/api/profile")
            json = { firstName: "Igor", lastName: "Volkov", middleName: null, image: null };
          else if (path === "/api/devices") json = { items: [], total: 0, page: 1, pageSize: 8 };
          else if (path === "/api/device-licensing") json = pool;
          else if (path === "/api/device-licensing/replacements")
            json = {
              canPrepare: true,
              items: [
                {
                  preparation: workflowPreparation(
                    mode === "ready" ? "ready" : "completed",
                    mode === "ready" ? "not_required" : "required",
                  ),
                  needsReview: false,
                },
              ],
            };
          else if (path === "/api/device-licensing/retention")
            json = {
              canSelect: false,
              observation: null,
              selections: [],
              currentShadow: { awaitingSelection: false, affectedDeviceIds: [], enforced: false },
            };
          else if (path === "/api/pickup-orders")
            json = { items: [], total: 0, page: 1, pageSize: 20 };
          else if (path === "/api/billing/attention") json = { items: [] };
          else {
            unexpected.push(path);
            await route.abort();
            return;
          }
          await route.fulfill({ json, headers: { "Cache-Control": "no-store" } });
        });
        await page.setViewportSize({ width, height: 1000 });
        await page.goto(`/test/browser/production.html?route=/devices&locale=${locale}`);
        await page.locator(".devices-service-workflows > summary").click();
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
        const extraHeight = await page
          .locator("main")
          .evaluate((el) => el.scrollHeight - el.clientHeight);
        await page.setViewportSize({ width, height: 1000 + extraHeight });
        await page.locator("main").evaluate((el) => {
          el.scrollTop = 0;
        });
        await panel.scrollIntoViewIfNeeded();
        await panel.screenshot({
          path: info.outputPath(`replacement-cabinet-${mode}-${locale}-${width}.png`),
        });
        expect(unexpected).toEqual([]);
      });
    }
