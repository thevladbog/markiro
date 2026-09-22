import {
  workflowPreparation,
  blockedRecoveryPreparation,
} from "../../../apps/saas-admin/test/device-replacement-fixtures.js";
import { expect, TENANT_ID, test } from "./fixture.js";
for (const width of [1440, 390])
  for (const locale of ["ru", "en"] as const)
    for (const mode of [
      "ready",
      "recovery",
      "recovery-blocked",
      "preview-blocked",
      "client-unsupported",
      "client-expired",
    ] as const) {
      test(`replacement ${mode} ${locale} ${width}`, async ({ page, fixture }, info) => {
        fixture.replacementDrainRefused = mode === "client-expired";
        fixture.replacementPreviewBlocked = mode === "preview-blocked";
        fixture.replacement =
          mode === "preview-blocked"
            ? null
            : mode === "client-unsupported"
              ? {
                  ...workflowPreparation("prepared"),
                  drainEligibility: { status: "blocked", reasons: ["client_upgrade_required"] },
                }
              : mode === "client-expired"
                ? workflowPreparation("prepared")
                : mode === "recovery-blocked"
                  ? blockedRecoveryPreparation()
                  : workflowPreparation(
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
        const ru = locale === "ru";
        let panel;
        if (mode === "preview-blocked") {
          await page
            .getByRole("combobox", { name: ru ? "Исходное устройство" : "Source device" })
            .click();
          await page.getByRole("option", { name: "Линия розлива 1", exact: true }).click();
          await page
            .getByLabel(ru ? "Имя будущего устройства" : "Future device name")
            .fill("Future handheld");
          await page
            .getByRole("combobox", { name: ru ? "Тип будущего устройства" : "Future device kind" })
            .click();
          await page.getByRole("option", { name: ru ? "ТСД" : "Handheld", exact: true }).click();
          await page.getByLabel(ru ? "Причина" : "Reason", { exact: true }).fill("Replace source");
          await page
            .getByRole("button", {
              name: ru ? "Предпросмотр подготовки" : "Preview preparation",
              exact: true,
            })
            .click();
          const save = page.getByRole("button", {
            name: ru ? "Сохранить подготовку" : "Save preparation",
            exact: true,
          });
          await expect(save).toBeVisible();
          panel = save.locator("..");
          await expect(
            panel.getByText(
              ru ? "Условия исполнения в этом расчёте" : "Execution prerequisites in this preview",
            ),
          ).toBeVisible();
          await expect(
            panel.getByText(ru ? /Подключите сервис ТСД/ : /Enable Handheld/),
          ).toBeVisible();
          await expect(
            panel.getByText(
              ru
                ? /Проверьте занятые места и лимит тарифа/
                : /Review occupied slots and plan capacity/,
            ),
          ).toBeVisible();
          await expect(
            panel.getByText(
              ru
                ? /настроить политику жизненного цикла устройств/
                : /configure the device lifecycle policy/,
            ),
          ).toBeVisible();
          await expect(panel).not.toContainText(
            /Replacement cannot be completed yet|Moving access from the source device is not available yet/,
          );
        } else {
          panel = page.getByRole("region", {
            name: ru ? "Сохранённая подготовка замены" : "Saved replacement preparation",
          });
          await expect(
            panel.getByText(ru ? "Ревизия проекта" : "Preparation revision"),
          ).toBeVisible();
          await expect(
            panel.getByRole("button", {
              name:
                mode === "client-unsupported" || mode === "client-expired"
                  ? ru
                    ? "Запросить завершение работы"
                    : "Request drain"
                  : mode === "ready"
                    ? ru
                      ? "Рассчитать исполнение"
                      : "Preview execution"
                    : ru
                      ? "Выпустить код восстановления"
                      : "Issue source recovery code",
            }),
          ).toBeVisible();
          if (mode === "recovery" || mode === "recovery-blocked")
            await expect(panel.locator('time[datetime="2026-09-18T12:30:00.000Z"]')).toBeVisible();
          if (mode === "client-expired") {
            const drain = panel.getByRole("button", {
              name: ru ? "Запросить завершение работы" : "Request drain",
              exact: true,
            });
            await expect(drain).toBeEnabled();
            await drain.click();
            await expect(drain).toBeDisabled();
            expect(fixture.refusedDrainAttempts).toBe(1);
            await expect(
              panel.getByRole("button", {
                name: ru ? "Повторить тот же запрос" : "Retry exact request",
                exact: true,
              }),
            ).toHaveCount(0);
          }
          if (mode === "client-unsupported" || mode === "client-expired") {
            await expect(
              panel.getByRole("button", {
                name: ru ? "Запросить завершение работы" : "Request drain",
                exact: true,
              }),
            ).toBeDisabled();
            await expect(
              panel.getByRole("button", {
                name: ru ? "Аварийная замена" : "Emergency replacement",
                exact: true,
              }),
            ).toBeEnabled();
            await expect(
              panel.getByText(
                ru
                  ? "Обновите клиент старого устройства для проверки всех обязательных каналов."
                  : "Update the source client to measure every required channel.",
              ),
            ).toBeVisible();
          }
          if (mode === "recovery-blocked") {
            await expect(
              panel.getByText(
                ru
                  ? "Блокировки восстановления на сервере"
                  : "Recovery blockers reported by the server",
              ),
            ).toBeVisible();
            await expect(
              panel
                .getByText(ru ? "Исключения" : "Exceptions", { exact: true })
                .locator("..")
                .locator("dd"),
            ).toHaveText("0");
            await expect(
              panel.getByText(
                ru ? /Разберите и отправьте исключения/ : /Resolve and send pending exceptions/,
              ),
            ).toBeVisible();
          }
        }
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
