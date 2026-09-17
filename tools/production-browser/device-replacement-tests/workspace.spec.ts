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
    for (const mode of ["ready", "recovery", "recovery-blocked", "preview-blocked"] as const) {
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
              items:
                mode === "preview-blocked"
                  ? []
                  : [
                      {
                        preparation:
                          mode === "recovery-blocked"
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
              currentShadow: { awaitingSelection: false, affectedDeviceIds: [], enforced: false },
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
        await page.locator(".devices-service-workflows > summary").click();
        const ru = locale === "ru";
        let panel;
        if (mode === "preview-blocked") {
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
          await expect(
            panel.getByText(ru ? "Ревизия проекта" : "Preparation revision"),
          ).toBeVisible();
          await expect(
            panel.getByRole("button", {
              name:
                mode === "ready"
                  ? ru
                    ? "Рассчитать исполнение"
                    : "Preview execution"
                  : ru
                    ? "Выпустить код восстановления"
                    : "Issue source recovery code",
            }),
          ).toBeVisible();
          if (mode !== "ready")
            await expect(panel.locator('time[datetime="2026-09-18T12:30:00.000Z"]')).toBeVisible();
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
