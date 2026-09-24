import { cabinetDeviceReplacementContracts } from "../../../packages/platform-contracts/src/index.js";
import { test, expect } from "@playwright/test";
import { resolveCabinetAccess } from "../../../packages/domain/src/access/cabinet.js";
import {
  pool,
  workflowPreparation,
  blockedRecoveryPreparation,
  factualObservation,
  preview,
} from "../../../apps/admin/test/device-replacement-fixtures.js";
for (const width of [1440, 390])
  for (const locale of ["ru", "en"] as const)
    for (const mode of [
      "ready",
      "recovery",
      "recovery-blocked",
      "preview-blocked",
      "client-unsupported",
      "client-expired",
      "inactive",
    ] as const) {
      test(`replacement cabinet ${mode} ${locale} ${width}`, async ({ page }, info) => {
        const unexpected: string[] = [];
        let capabilityExpired = false;
        let refusedAttempts = 0;
        await page.route(/^http:\/\/127\.0\.0\.1:\d+\/api\//, async (route) => {
          const path = new URL(route.request().url()).pathname;
          let json: unknown;
          if (
            mode === "client-expired" &&
            path.endsWith("/drain") &&
            route.request().method() === "POST"
          ) {
            cabinetDeviceReplacementContracts.drain.body.parse(route.request().postDataJSON());
            capabilityExpired = true;
            refusedAttempts++;
            await route.fulfill({ status: 409, json: { code: "client_upgrade_required" } });
            return;
          }
          if (path === "/api/access/me") json = resolveCabinetAccess("owner");
          else if (path === "/api/profile")
            json = { firstName: "Igor", lastName: "Volkov", middleName: null, image: null };
          else if (path === "/api/devices") json = { items: [], total: 0, page: 1, pageSize: 8 };
          else if (path === "/api/device-licensing") json = pool;
          else if (path === "/api/device-licensing/replacements")
            json = {
              canPrepare: true,
              items:
                mode === "preview-blocked"
                  ? []
                  : [
                      {
                        preparation:
                          mode === "inactive"
                            ? {
                                ...workflowPreparation("prepared"),
                                state: "cancelled",
                                revision: 4,
                                cancelledAt: "2026-09-18T12:30:00.000Z",
                              }
                            : mode === "client-unsupported" || capabilityExpired
                              ? {
                                  ...workflowPreparation("prepared"),
                                  drainEligibility: {
                                    status: "blocked",
                                    reasons: ["client_upgrade_required"],
                                  },
                                }
                              : mode === "client-expired"
                                ? workflowPreparation("prepared")
                                : mode === "recovery-blocked"
                                  ? blockedRecoveryPreparation()
                                  : workflowPreparation(
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
              currentShadow: {
                awaitingSelection: mode === "inactive",
                affectedDeviceIds: mode === "inactive" ? [pool.devices[0]!.deviceId] : [],
                enforced: false,
              },
            };
          else if (path === "/api/pickup-orders")
            json = { items: [], total: 0, page: 1, pageSize: 20 };
          else if (path === "/api/billing/attention") json = { items: [] };
          else if (mode === "preview-blocked" && path.endsWith("/replacements/preview")) {
            const body = cabinetDeviceReplacementContracts.preview.body.parse(
              route.request().postDataJSON(),
            );
            json = {
              ...preview(body.requestId),
              observation: { ...factualObservation, target: body.target },
            };
          } else {
            unexpected.push(path);
            await route.abort();
            return;
          }
          await route.fulfill({ json, headers: { "Cache-Control": "no-store" } });
        });
        await page.setViewportSize({ width, height: 1000 });
        await page.goto(`/test/browser/production.html?route=/devices&locale=${locale}`);
        if (mode === "inactive" && locale === "ru" && width === 1440)
          await page.getByRole("button", { name: "Переключить тему" }).click();
        await page.locator(".devices-service-workflows > summary").click();
        const ru = locale === "ru";
        let panel;
        if (mode === "inactive") {
          panel = page.getByRole("button", {
            name: ru ? "История замен (1)" : "Replacement history (1)",
          });
          await expect(panel).toBeVisible();
          await expect(
            page.getByText(ru ? "Этот проект замены отменён." : "This preparation is cancelled."),
          ).toBeHidden();
          await expect(
            page.getByRole("heading", {
              name: ru
                ? "Уменьшение лимита не запланировано"
                : "No device limit reduction is scheduled",
            }),
          ).toBeVisible();
          await expect(
            page.getByText(ru ? /Текущий теневой расчёт/ : /Current shadow calculation/),
          ).toBeHidden();
        } else if (mode === "preview-blocked") {
          await page
            .getByRole("combobox", { name: ru ? "Исходное устройство" : "Source device" })
            .click();
          await page.getByRole("option", { name: "Source 1", exact: true }).click();
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
          const report = panel.locator("summary").filter({
            hasText: ru ? "Технические данные проверки" : "Technical report",
          });
          const revision = panel.getByText(ru ? "Ревизия проекта" : "Preparation revision");
          await expect(revision).toBeHidden();
          await report.click();
          await expect(revision).toBeVisible();
          await report.click();
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
            expect(refusedAttempts).toBe(1);
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
            await report.click();
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
            await report.click();
          }
        }
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
        if (mode === "inactive")
          await page.screenshot({
            path: info.outputPath(`replacement-cabinet-${mode}-${locale}-${width}.png`),
            fullPage: true,
          });
        else
          await panel.screenshot({
            path: info.outputPath(`replacement-cabinet-${mode}-${locale}-${width}.png`),
          });
        expect(unexpected).toEqual([]);
      });
    }
