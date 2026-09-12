import { randomUUID } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import type {} from "../../../apps/station/test/browser/product-labels-types.js";
const station = process.env.STATION_PRODUCT_LABELS_URL ?? "http://127.0.0.1:43182";
async function open(page: Page, verification = "required") {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(
    `${station}/test/browser/product-labels.html?id=${randomUUID()}&verification=${verification}`,
  );
  await page.waitForFunction(() => window.__productLabels?.ready());
}
test("required verification blocks the next unit; full tail and restart use the real SQLite journal with mock transport", async ({
  page,
}, info) => {
  await open(page);
  await page.evaluate(() => window.__productLabels.scan());
  const dialog = page.getByRole("dialog", {
    name: "Отсканируйте напечатанную этикетку",
    exact: true,
  });
  await expect(dialog).toBeVisible();
  expect((await dialog.boundingBox())?.width).toBe(1280);
  await page.screenshot({ path: info.outputPath("station-required.png") });
  await expect(
    dialog.getByRole("button", { name: "Пропустить проверку", exact: true }),
  ).toBeEnabled();
  expect(await page.evaluate(() => document.documentElement.scrollHeight <= innerHeight)).toBe(
    true,
  );
  expect(
    (await dialog.getByRole("button", { name: "Пауза", exact: true }).boundingBox())?.height,
  ).toBeGreaterThanOrEqual(64);
  await page.evaluate(() =>
    window.__productLabels.scan(
      ']d2010460000000001521SERIAL-42\u001d91Key1\u001d92Crypto(93)^FNC1"TAIL',
    ),
  );
  await expect(page.getByText("Код не совпадает", { exact: true })).toBeVisible();
  expect((await page.evaluate(() => window.__productLabels.inspect())).accepted).toBe(1);
  await page.reload();
  await page.waitForFunction(() => window.__productLabels?.ready());
  await expect(dialog).toBeVisible();
  expect((await page.evaluate(() => window.__productLabels.inspect())).prints).toBe(1);
  await page.evaluate(() => window.__productLabels.scan());
  await expect(page.getByText("Этикетка подтверждена", { exact: true })).toHaveCount(1);
  await expect(dialog).toHaveCount(0);
  const state = await page.evaluate(() => window.__productLabels.inspect());
  expect(state.accepted).toBe(1);
  expect(state.events.at(-1)).toBe("verified");
  await page.screenshot({ path: info.outputPath("station-verified.png") });
});

test("explicit skip is durable after reload and admits the next unit without verification", async ({
  page,
}) => {
  await open(page);
  await page.evaluate(() => window.__productLabels.scan());
  const dialog = page.getByRole("dialog", {
    name: "Отсканируйте напечатанную этикетку",
    exact: true,
  });
  await dialog.getByRole("button", { name: "Пропустить проверку", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByText("Проверка пропущена", { exact: true })).toBeVisible();
  await page.reload();
  await page.waitForFunction(() => window.__productLabels?.ready());
  const saved = await page.evaluate(() => window.__productLabels.inspect());
  expect(saved.events).toEqual(["prepared", "sending", "sent", "verification_skipped"]);
  expect(saved.accepted).toBe(1);
  expect(saved.prints).toBe(1);
  await expect(page.getByText("Этикетка подтверждена", { exact: true })).toHaveCount(0);
  await page.evaluate(() =>
    window.__productLabels.scan("]d2010460000000001521SERIAL-43\u001d93NewTail"),
  );
  await expect(dialog).toBeVisible();
  expect((await page.evaluate(() => window.__productLabels.inspect())).accepted).toBe(2);
});

test("unknown delivery after interrupted mock send survives reload without auto resend; reprint requires a reason and preserves bytes", async ({
  page,
}, info) => {
  await open(page);
  await page.evaluate(() => window.__productLabels.setTransport("hold"));
  await page.evaluate(() => window.__productLabels.scan());
  await expect
    .poll(() => page.evaluate(() => window.__productLabels.inspect()))
    .toMatchObject({ prints: 1, status: "sending" });
  await page.reload();
  await page.waitForFunction(() => window.__productLabels?.ready());
  const dialog = page.getByRole("dialog", { name: "Печать требует уточнения", exact: true });
  await expect(dialog).toBeVisible();
  expect((await page.evaluate(() => window.__productLabels.inspect())).prints).toBe(1);
  await page.screenshot({ path: info.outputPath("station-unknown.png") });
  await dialog.getByRole("button", { name: "Напечатать повторно", exact: true }).click();
  const reason = page.getByRole("dialog", { name: "Повторная печать этикетки", exact: true });
  await expect(
    reason.getByRole("button", { name: "Напечатать повторно", exact: true }),
  ).toBeDisabled();
  await reason.getByRole("radio", { name: "Этикетка повреждена", exact: true }).check();
  await page.screenshot({ path: info.outputPath("station-reprint-reason.png") });
  await reason.getByRole("button", { name: "Напечатать повторно", exact: true }).click();
  await expect(
    page.getByRole("dialog", { name: "Отсканируйте напечатанную этикетку", exact: true }),
  ).toBeVisible();
  const state = await page.evaluate(() => window.__productLabels.inspect());
  expect(state.prints).toBe(2);
  expect(state.accepted).toBe(1);
  expect(state.bytes).toHaveLength(2);
  expect(state.bytes[1]).toBe(state.bytes[0]);
  await page.evaluate(() => window.__productLabels.scan());
  await expect(page.getByText("Этикетка подтверждена", { exact: true })).toHaveCount(1);
});
test("verification off continues after durable send and reprints from local history without another acceptance", async ({
  page,
}, info) => {
  await open(page, "none");
  await expect(
    page.getByText(
      "Проверка этикетки выключена. После отправки на принтер можно сканировать следующую единицу.",
      { exact: true },
    ),
  ).toBeVisible();
  await expect(
    page.getByText("Следующая единица доступна после проверки напечатанной этикетки.", {
      exact: true,
    }),
  ).toHaveCount(0);
  const inset = await page.getByRole("heading", { name: "Дубликат Data Matrix" }).evaluate((h) => {
    const card = h.closest("section");
    return card ? h.getBoundingClientRect().left - card.getBoundingClientRect().left : 0;
  });
  expect(inset).toBeGreaterThanOrEqual(16);
  await page.screenshot({ path: info.outputPath("station-verification-off-ready.png") });
  await page.evaluate(() => window.__productLabels.scan());
  await expect(page.getByText("Отправлено на принтер", { exact: true })).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.screenshot({ path: info.outputPath("station-verification-off.png") });
  await page.getByRole("button", { name: "Исключения", exact: true }).click();
  await expect(page.getByRole("heading", { name: "История этикеток", exact: true })).toBeVisible();
  await page.screenshot({ path: info.outputPath("station-local-history.png") });
  await page.getByRole("button", { name: "Напечатать повторно", exact: true }).click();
  const reason = page.getByRole("dialog", { name: "Повторная печать этикетки", exact: true });
  await reason.getByRole("radio", { name: "Этикетка потеряна", exact: true }).check();
  await reason.getByRole("button", { name: "Напечатать повторно", exact: true }).click();
  await expect(page.getByText("Отправлено на принтер", { exact: true })).toBeVisible();
  expect(await page.evaluate(() => window.__productLabels.inspect())).toMatchObject({
    prints: 2,
    accepted: 1,
    attempts: 2,
  });
  await page.evaluate(() =>
    window.__productLabels.scan("]d2010460000000001521SERIAL-43\u001d93NewTail"),
  );
  await expect
    .poll(() => page.evaluate(() => window.__productLabels.inspect()))
    .toMatchObject({ accepted: 2, prints: 3 });
});

const galleryStates = [
  "new-shift-pallet-template",
  "validation-print-prepared",
  "validation-print-sending",
  "validation-print-required",
  "validation-print-none",
  "validation-print-skipped",
  "validation-print-unknown",
  "validation-print-verified",
  "validation-print-waiting",
  "validation-print-mismatch",
  "validation-print-invalid",
  "validation-print-reason",
  "validation-print-failed",
  "validation-print-create-required",
  "validation-print-create-none",
  "validation-print-create-template",
] as const;
for (const locale of ["ru", "en"])
  for (const theme of ["dark", "light"])
    test(`station horizontal gallery, focus and touch targets ${locale} ${theme}`, async ({
      page,
    }, info) => {
      test.setTimeout(120000);
      await page.setViewportSize({ width: 1280, height: 800 });
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      page.on("response", (response) => {
        if (response.status() >= 400) errors.push(`${response.status()} ${response.url()}`);
      });
      await page.addInitScript((theme) => localStorage.setItem("markiro.theme", theme), theme);
      for (const state of galleryStates) {
        await page.goto(`${station}/?gallery=1&state=${state}&locale=${locale}`);
        await expect(page.getByTestId("station-screen-gallery")).toHaveAttribute(
          "data-gallery-state",
          state,
        );
        await expect(page.getByTestId("station-screen-gallery")).toHaveAttribute(
          "data-gallery-locale",
          locale,
        );
        await page.evaluate(() => document.fonts.ready);
        const geometry = await page.evaluate(() => ({
          width: innerWidth,
          height: innerHeight,
          scrollWidth: document.documentElement.scrollWidth,
          scrollHeight: document.documentElement.scrollHeight,
        }));
        expect(geometry).toEqual({
          width: 1280,
          height: 800,
          scrollWidth: 1280,
          scrollHeight: 800,
        });
        if (state === "validation-print-required") {
          const dialog = page.getByRole("dialog");
          await expect(dialog).toBeVisible();
          expect((await dialog.boundingBox())?.width).toBe(1280);
          await page.keyboard.press("Tab");
          expect(await dialog.evaluate((element) => element.contains(document.activeElement))).toBe(
            true,
          );
          const buttons = await dialog.getByRole("button").all();
          for (const button of buttons)
            expect((await button.boundingBox())?.height).toBeGreaterThanOrEqual(64);
        }
        await page.screenshot({ path: info.outputPath(`${state}-${locale}-${theme}.png`) });
      }
      expect(errors).toEqual([]);
    });

for (const verification of ["required", "none", "off"])
  test(`operator creates a shift on station with ${verification} verification through real NewShift and mock API`, async ({
    page,
  }, info) => {
    const shiftId = "11111111-1111-4111-8111-111111111111";
    const writes: unknown[] = [];
    const unexpected: string[] = [];
    const { buildDuplicateLabelTemplates, productLabelValueDigest } =
      await import("../../../packages/domain/dist/index.js");
    const templates = buildDuplicateLabelTemplates().map((preset, index) => ({
      ...preset,
      id:
        index === 0
          ? "55555555-5555-4555-8555-555555555555"
          : "77777777-7777-4777-8777-777777777777",
    }));
    const template = templates[verification === "none" ? 0 : 1];
    if (!template) throw new Error("Missing stock name variant");
    const templateId = template.id;
    await page.route(`${station}/__product_labels_api/**`, async (route) => {
      const path = new URL(route.request().url()).pathname.replace("/__product_labels_api", "");
      let body: unknown;
      if (path === "/products/gtin-check") body = { gtin14: "04600000000015", owner: "own" };
      else if (path === "/products")
        body = {
          items: [
            {
              id: "44444444-4444-4444-8444-444444444444",
              gtin14: "04600000000015",
              name: "Кега светлого пива, 30 л",
              boxCapacity: null,
            },
          ],
        };
      else if (path === "/shifts/planning-config")
        body = { validationPrintProtocol: "validation-dm-duplicate-v1" };
      else if (path === "/shifts/product-label-templates")
        body = {
          items: templates.map(({ id, name, spec }) => ({
            id,
            name,
            widthMm: spec.widthMm,
            heightMm: spec.heightMm,
            dpi: spec.dpi,
          })),
        };
      else if (path === "/shifts") {
        writes.push(route.request().postDataJSON());
        body = { id: shiftId, productionDate: "2026-09-09" };
      } else if (path === `/shifts/${shiftId}/open`)
        body = {
          id: shiftId,
          status: "active",
          mode: "validation",
          validationPrint:
            verification === "off"
              ? {
                  mode: "none",
                  verification: "none",
                  templateId: null,
                  snapshot: null,
                  policyRevision: null,
                }
              : {
                  mode: "duplicate_dm",
                  verification,
                  templateId,
                  snapshot: { ...template, digest: productLabelValueDigest(template) },
                  policyRevision: "66666666-6666-4666-8666-666666666666",
                },
        };
      else {
        unexpected.push(path);
        await route.abort();
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(body),
      });
    });
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.clock.setFixedTime(new Date("2026-09-10T12:00:00Z"));
    await page.goto(
      `${station}/test/browser/product-labels.html?id=${randomUUID()}&screen=newshift`,
    );
    const input = page.getByRole("textbox", { name: "Введите или отсканируйте GTIN", exact: true });
    await input.fill("04600000000015");
    await input.press("Enter");
    await expect(
      page.getByRole("heading", { name: "Кега светлого пива, 30 л", exact: true }),
    ).toBeVisible();
    if (verification !== "off") {
      await page.getByRole("button", { name: "Печать этикетки: Без печати", exact: true }).click();
      await page
        .getByRole("checkbox", { name: "Печатать дубликат Data Matrix", exact: true })
        .check();
      if (verification === "none")
        await page
          .getByRole("checkbox", { name: "Обязательная проверка этикетки", exact: true })
          .uncheck();
      await page.screenshot({ path: info.outputPath(`station-create-${verification}.png`) });
      await page.getByRole("button", { name: "Выбрать шаблон", exact: true }).click();
      for (const preset of templates)
        await expect(
          page.getByRole("button", {
            name: new RegExp(preset.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
          }),
        ).toBeVisible();
      await page.getByRole("button", { name: template.name, exact: false }).click();
      await page.screenshot({ path: info.outputPath(`station-template-${verification}.png`) });
      await expect(page.getByRole("button", { name: "Начать", exact: true })).toHaveCount(0);
      await page.getByRole("button", { name: "Применить", exact: true }).click();
    }
    await expect(
      page.getByRole("button", { name: "Дата производства", exact: true }),
    ).toBeVisible();
    expect(writes).toEqual([]);
    await page.getByRole("button", { name: "Дата производства", exact: true }).click();
    await page.getByRole("button", { name: /^9 сентября 2026/ }).click();
    await page.screenshot({ path: info.outputPath(`station-date-review-${verification}.png`) });
    await page.getByRole("button", { name: "Начать", exact: true }).click();
    await expect(page.getByText("Смена открыта", { exact: true })).toBeVisible();
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({ productionDate: "2026-09-09" });
    expect(writes[0]).toMatchObject(
      verification === "off"
        ? { mode: "validation" }
        : { validationPrint: { mode: "duplicate_dm", verification, templateId } },
    );
    expect(unexpected).toEqual([]);
  });

for (const locale of ["ru", "en"])
  for (const theme of ["light", "dark"])
    test(`existing printer setup keeps DPI and primary actions in view ${locale} ${theme}`, async ({
      page,
    }, info) => {
      await page.setViewportSize({ width: 1280, height: 800 });
      await page.addInitScript((theme) => localStorage.setItem("markiro.theme", theme), theme);
      await page.goto(`${station}/?gallery=1&state=setup-printer&locale=${locale}`);
      await expect(page.getByTestId("station-screen-gallery")).toHaveAttribute(
        "data-gallery-state",
        "setup-printer",
      );
      const dpi = page.getByRole("combobox", {
        name: locale === "ru" ? "Разрешение принтера" : "Printer resolution",
        exact: true,
      });
      await expect(dpi).toBeInViewport({ ratio: 1 });
      await dpi.selectOption("203");
      await expect(dpi).toHaveValue("203");
      const bounds = await dpi.boundingBox();
      expect(bounds && bounds.y + bounds.height).toBeLessThanOrEqual(800);
      const footer = await page.getByTestId("setup-footer").boundingBox();
      expect(footer && footer.y + footer.height).toBeLessThanOrEqual(800);
      await expect(page.getByRole("checkbox").locator("..")).toBeInViewport({ ratio: 1 });
      await expect(
        page.getByTestId("setup-footer").getByRole("button", {
          name: locale === "ru" ? "Готово" : "Done",
          exact: true,
        }),
      ).toBeEnabled();
      expect(await page.evaluate(() => document.documentElement.scrollHeight)).toBe(800);
      await page.screenshot({
        path: info.outputPath(`station-printer-dpi-${locale}-${theme}.png`),
      });
    });

test("printer settings remain usable on the existing 1024 by 768 floor viewport", async ({
  page,
}, info) => {
  await page.setViewportSize({ width: 1024, height: 768 });
  await page.goto(`${station}/?gallery=1&state=setup-printer&locale=en`);
  await expect(page.getByTestId("station-screen-gallery")).toHaveAttribute(
    "data-gallery-state",
    "setup-printer",
  );
  const dpi = page.getByRole("combobox", { name: "Printer resolution", exact: true });
  await expect(dpi).toBeInViewport({ ratio: 1 });
  await dpi.selectOption("300");
  await expect(dpi).toHaveValue("300");
  for (const language of ["ZPL", "TSPL"]) {
    const label = page.getByRole("radio", { name: language, exact: true }).locator("..");
    await expect(label).toBeInViewport({ ratio: 1 });
    expect(
      await label.locator("span").evaluate((span) => span.scrollWidth <= span.clientWidth),
    ).toBe(true);
  }
  await expect(page.getByRole("checkbox").locator("..")).toBeInViewport({ ratio: 1 });
  const footer = await page.getByTestId("setup-footer").boundingBox();
  expect(footer && footer.y + footer.height).toBeLessThanOrEqual(768);
  await expect(page.getByRole("button", { name: "Done", exact: true })).toBeEnabled();
  await page.screenshot({ path: info.outputPath("station-printer-1024-en.png") });
});

for (const locale of ["ru", "en"])
  for (const theme of ["light", "dark"])
    test(`pallet with 66 boxes keeps assembly and actions visible ${locale} ${theme}`, async ({
      page,
    }, info) => {
      await page.addInitScript((theme) => localStorage.setItem("markiro.theme", theme), theme);
      for (const viewport of [
        { width: 1280, height: 800 },
        { width: 1024, height: 768 },
      ]) {
        await page.setViewportSize(viewport);
        await page.goto(`${station}/?gallery=1&state=work-pallet-66&locale=${locale}`);
        const pallet = page.locator(".pallet-strip");
        await expect(pallet.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "42");
        await expect(pallet.getByRole("progressbar")).toHaveAttribute("aria-valuemax", "66");
        await expect(pallet.getByText(/64\s*%/)).toBeVisible();
        for (const control of [
          pallet,
          ...(await pallet.getByRole("button").all()),
          ...(await page.locator(".work-box-fill__actions button").all()),
        ]) {
          await expect(control).toBeInViewport({ ratio: 1 });
        }
        expect(
          await pallet.evaluate(
            (el) => el.scrollHeight <= el.clientHeight && el.scrollWidth <= el.clientWidth,
          ),
        ).toBe(true);
        const box = page.locator(".work-box-fill");
        expect(await box.evaluate((el) => el.scrollHeight <= el.clientHeight)).toBe(true);
        await page.screenshot({
          path: info.outputPath(`pallet-66-${viewport.width}-${locale}-${theme}.png`),
        });
        await pallet
          .getByRole("button", { name: locale === "ru" ? "Состав паллеты" : "Pallet contents" })
          .click();
        const dialog = page.getByRole("dialog");
        await expect(dialog.getByRole("row")).toHaveCount(43);
        await page.keyboard.press("Tab");
        const contents = dialog.getByRole("region");
        await expect(contents).toBeFocused();
        await contents.press("PageDown");
        await expect.poll(() => contents.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
        const back = dialog.getByRole("button", {
          name: locale === "ru" ? "К сборке" : "Back to assembly",
        });
        await expect(back).toBeInViewport({ ratio: 1 });
        await dialog.getByText("004601234560000001", { exact: true }).scrollIntoViewIfNeeded();
        await expect(dialog.getByText("004601234560000001", { exact: true })).toBeInViewport({
          ratio: 1,
        });
        await expect(back).toBeInViewport({ ratio: 1 });
        await page.screenshot({
          path: info.outputPath(`pallet-contents-${viewport.width}-${locale}-${theme}.png`),
        });
        await back.click();
        await expect(dialog).toHaveCount(0);
        await expect(pallet).toBeVisible();
      }
    });

for (const locale of ["ru", "en"])
  for (const theme of ["light", "dark"])
    test(`station creates pallet aggregation using product capacity and separate labels ${locale} ${theme}`, async ({
      page,
    }, info) => {
      const writes: Record<string, unknown>[] = [];
      const unexpected: string[] = [];
      const template = { widthMm: 100, heightMm: 150, dpi: 203, language: "zpl" };
      await page.addInitScript((theme) => localStorage.setItem("markiro.theme", theme), theme);
      await page.route(`${station}/__product_labels_api/**`, async (route) => {
        const path = new URL(route.request().url()).pathname.replace("/__product_labels_api", "");
        let body: unknown;
        if (path === "/products/gtin-check") body = { gtin14: "04600000000015", owner: "own" };
        else if (path === "/products")
          body = {
            items: [
              {
                id: "product",
                gtin14: "04600000000015",
                name: "Вода, 0,5 л",
                boxCapacity: 10,
                palletBoxCapacity: 66,
              },
            ],
          };
        else if (path === "/shifts/box-label-templates")
          body = {
            items: [{ ...template, id: "box-label", name: "Этикетка короба" }],
            defaultBoxLabelTemplateId: "box-label",
          };
        else if (path === "/shifts/pallet-label-templates")
          body = {
            items: [{ ...template, id: "pallet-label", name: "Паллета 100×150" }],
            defaultPalletLabelTemplateId: "pallet-label",
          };
        else if (path === "/shifts") {
          writes.push(route.request().postDataJSON());
          body = { id: "shift" };
        } else if (path === "/shifts/shift/open")
          body = { id: "shift", status: "active", mode: "aggregation" };
        else {
          unexpected.push(path);
          await route.abort();
          return;
        }
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(body),
        });
      });
      for (const viewport of [
        { width: 1280, height: 800 },
        { width: 1024, height: 768 },
      ]) {
        await page.setViewportSize(viewport);
        await page.goto(
          `${station}/test/browser/product-labels.html?id=${randomUUID()}&screen=newshift&locale=${locale}`,
        );
        const input = page.getByRole("textbox", {
          name: locale === "ru" ? "Введите или отсканируйте GTIN" : "Type or scan a GTIN",
          exact: true,
        });
        await input.fill("04600000000015");
        await input.press("Enter");
        await page
          .getByRole("button", { name: locale === "ru" ? "Агрегация" : "Aggregation", exact: true })
          .click();
        await page
          .getByRole("button", {
            name: locale === "ru" ? "С паллетами" : "With pallets",
            exact: true,
          })
          .click();
        await expect(
          page.getByText(
            locale === "ru"
              ? "66 коробов на паллете · из карточки товара"
              : "66 boxes per pallet · from the product card",
          ),
        ).toBeInViewport({
          ratio: 1,
        });
        await expect(page.getByRole("spinbutton")).toHaveCount(0);
        const date = page.getByRole("button", {
          name: locale === "ru" ? "Дата производства" : "Production date",
          exact: true,
        });
        await expect(date).toBeInViewport({ ratio: 1 });
        await page.screenshot({
          path: info.outputPath(`pallet-create-${viewport.width}-${locale}-${theme}.png`),
        });
        await page
          .getByRole("button", { name: locale === "ru" ? "Начать" : "Start", exact: true })
          .click();
        await page
          .getByRole("button", { name: locale === "ru" ? "Далее" : "Next", exact: true })
          .click();
        await expect(page.getByRole("button", { name: /Паллета 100×150/ })).toHaveAttribute(
          "aria-pressed",
          "true",
        );
        await page.screenshot({
          path: info.outputPath(`pallet-template-${viewport.width}-${locale}-${theme}.png`),
        });
        await page
          .getByRole("button", { name: locale === "ru" ? "Начать" : "Start", exact: true })
          .click();
        await expect(page.getByText("Смена открыта", { exact: true })).toBeVisible();
      }
      expect(writes).toHaveLength(2);
      for (const write of writes) {
        expect(write).toMatchObject({
          palletsEnabled: true,
          boxLabelTemplateId: "box-label",
          palletLabelTemplateId: "pallet-label",
        });
        expect(write).not.toHaveProperty("palletBoxCapacity");
        expect(write).not.toHaveProperty("boxCapacity");
      }
      expect(unexpected).toEqual([]);
    });
