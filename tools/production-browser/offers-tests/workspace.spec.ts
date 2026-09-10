import type { Locator, Page, TestInfo } from "@playwright/test";
import {
  test,
  expect,
  ID,
  fingerprint,
  previewHtml,
  productionCsp,
  signedHtml,
  tenant,
} from "./fixture.js";

async function noPageOverflow(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
    await page.evaluate(() => window.innerWidth),
  );
}
async function tableScroll(region: Locator, width: number) {
  await expect(region).toBeVisible();
  await region.focus();
  await expect(region).toBeFocused();
  if (width === 390) {
    expect(await region.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(
      true,
    );
    await region.press("ArrowRight");
    await expect.poll(() => region.evaluate((element) => element.scrollLeft)).toBeGreaterThan(0);
    await region.evaluate((element) => {
      element.scrollLeft = 0;
    });
  }
}
async function shot(page: Page, info: TestInfo, name: string) {
  await page.evaluate(() => {
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    window.scrollTo(0, 0);
  });
  await page.screenshot({ path: info.outputPath(`${name}.png`), fullPage: true });
}

for (const theme of ["light", "dark"] as const) {
  test(`unfiltered multi-status desktop registry ${theme}`, async ({ page, fixture }, info) => {
    await page.setViewportSize({ width: 1440, height: 1100 });
    await page.addInitScript((value) => localStorage.setItem("markiro.theme", value), theme);
    await page.goto("/offers");
    await expect(page.getByRole("link", { name: "КП-ТЕСТ-0041" })).toBeVisible();
    await expect(page.getByRole("row")).toHaveCount(5);
    await expect(page.getByText("Реквизиты не сохранены", { exact: true })).toBeVisible();
    await noPageOverflow(page);
    await shot(page, info, "registry-multiple-rows");
    await page.getByRole("textbox", { name: "Поиск предложений" }).fill("missing");
    await expect(
      page.getByText("Предложения не найдены. Измените фильтры или создайте предложение."),
    ).toBeVisible();
    expect(fixture.calls.some((call) => call.url.pathname.endsWith("/workspace"))).toBe(false);
  });
}

for (const width of [390, 1440]) {
  for (const locale of ["ru", "en"] as const) {
    for (const theme of ["light", "dark"] as const) {
      test(`registry, preview, issue and signed HTML ${width} ${locale} ${theme}`, async ({
        page,
        context,
        fixture,
      }, info) => {
        const ru = locale === "ru";
        await page.setViewportSize({ width, height: 1000 });
        await page.addInitScript((value) => localStorage.setItem("markiro.theme", value), theme);
        const violations: string[] = [];
        page.on("console", (message) => {
          if (
            message.type() === "error" &&
            /Content Security Policy|Refused to|violates/i.test(message.text())
          )
            violations.push(message.text());
        });
        const response = await page.goto(
          "/offers?status=draft&page=2&limit=25&createdFrom=2026-09-01T00%3A00%3A00%2B03%3A00&createdTo=2026-10-01T00%3A00%3A00%2B03%3A00",
        );
        expect(response?.headers()["content-security-policy"]).toBe(productionCsp);
        await page.getByRole("button", { name: locale.toUpperCase(), exact: true }).click();
        await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
        const customer = page.getByRole("combobox", {
          name: ru ? "Клиент" : "Customer",
          exact: true,
        });
        await customer.click();
        const searchCustomer = page.getByRole("searchbox");
        await searchCustomer.fill("Молочная");
        await expect(page.getByRole("option", { name: tenant.name })).toBeVisible();
        await searchCustomer.press("ArrowDown");
        await searchCustomer.press("Enter");
        await expect(customer).toContainText(tenant.name);
        await expect(customer).toBeFocused();
        const search = page.getByRole("textbox", {
          name: ru ? "Поиск предложений" : "Search offers",
        });
        await search.fill("Молочная");
        await expect
          .poll(() =>
            fixture.calls
              .filter((call) => call.url.pathname.endsWith("/registry"))
              .at(-1)
              ?.url.searchParams.get("search"),
          )
          .toBe("Молочная");
        await page.getByRole("button", { name: ru ? "Далее" : "Next", exact: true }).click();
        await expect.poll(() => new URL(page.url()).searchParams.get("page")).toBe("2");
        await expect
          .poll(() =>
            fixture.calls
              .filter((call) => call.url.pathname.endsWith("/registry"))
              .at(-1)
              ?.url.searchParams.get("page"),
          )
          .toBe("2");
        const registry = page.getByRole("region", {
          name: ru
            ? "Реестр предложений, горизонтальная прокрутка"
            : "Offers registry, horizontal scrolling",
          exact: true,
        });
        await tableScroll(registry, width);
        await noPageOverflow(page);
        await expect(page.getByText(ID, { exact: true })).toHaveCount(0);
        expect(fixture.calls.some((call) => call.url.pathname.endsWith("/workspace"))).toBe(false);
        await shot(page, info, "registry");
        const returnUrl = page.url();
        await page.getByRole("link", { name: ru ? "Черновик" : "Draft", exact: true }).click();
        await expect(page).toHaveURL(new RegExp(`/offers/${ID}$`));
        await tableScroll(
          page
            .getByRole("region", {
              name: ru ? "Сохранённые позиции" : "Saved items",
              exact: true,
            })
            .and(page.locator(".mk-table__scroll")),
          width,
        );
        await noPageOverflow(page);
        await shot(page, info, "detail");
        await page
          .getByRole("link", { name: ru ? "К реестру предложений" : "Back to offers registry" })
          .click();
        await expect(page).toHaveURL(returnUrl);
        await expect(search).toHaveValue("Молочная");
        await expect(customer).toContainText(tenant.name);
        // Legacy entry also retains the full registry query after redirect.
        await page.goto(`${returnUrl}&selected=${ID}`);
        await page.getByRole("button", { name: locale.toUpperCase(), exact: true }).click();
        await expect(page).toHaveURL(new RegExp(`/offers/${ID}$`));
        await expect(
          page.getByRole("link", {
            name: ru ? "К реестру предложений" : "Back to offers registry",
          }),
        ).toHaveAttribute("href", new URL(returnUrl).pathname + new URL(returnUrl).search);
        const issue = page.getByRole("button", {
          name: ru ? "Выпустить предложение" : "Issue offer",
          exact: true,
        });
        await expect(issue).toBeDisabled();
        const previewRequest = page.waitForRequest((request) => request.url().endsWith("/preview"));
        await page
          .getByRole("button", { name: ru ? "Предпросмотр" : "Preview", exact: true })
          .click();
        await previewRequest;
        await expect(issue).toBeDisabled();
        expect(fixture.calls.some((call) => call.method === "POST")).toBe(false);
        fixture.preview.release();
        const iframe = page.getByTitle(ru ? "Предпросмотр предложения" : "Offer preview", {
          exact: true,
        });
        await expect(iframe).toHaveAttribute("sandbox", "");
        await expect(iframe).toHaveAttribute("srcdoc", previewHtml);
        const frame = iframe.contentFrame();
        await expect(
          page.getByText(
            ru
              ? "Формат A4. Прокручивайте документ внутри области просмотра по горизонтали и вертикали."
              : "A4 format. Scroll horizontally and vertically inside the preview to view the document.",
            { exact: true },
          ),
        ).toBeVisible();
        await expect(
          frame.getByRole("article").getByText("Черновик. Не выпущен", { exact: true }),
        ).toBeVisible();
        await expect(
          frame.getByText("Настройка производственной линии", { exact: true }),
        ).toBeVisible();
        await expect(
          frame.getByRole("heading", { name: "Условия тестового предложения" }),
        ).toBeVisible();
        expect(
          await iframe.evaluate((element) => (element as HTMLIFrameElement).contentDocument),
        ).toBeNull();
        await expect(issue).toBeEnabled();
        expect(fixture.calls.some((call) => call.method === "POST")).toBe(false);
        await iframe.scrollIntoViewIfNeeded();
        await noPageOverflow(page);
        await page.screenshot({ path: info.outputPath("preview.png") });
        await iframe.hover();
        await page.mouse.wheel(width === 390 ? 600 : 0, 600);
        await expect
          .poll(() => frame.locator("body").evaluate(() => window.scrollY))
          .toBeGreaterThan(0);
        if (width === 390) {
          await expect
            .poll(() => frame.locator("body").evaluate(() => window.scrollX))
            .toBeGreaterThan(0);
          await page.screenshot({ path: info.outputPath("preview-scrolled.png") });
        }
        await frame.locator("body").evaluate(() => window.scrollTo(0, 0));
        await expect(frame.locator(".total-block")).toContainText("3 125,13");
        await expect(frame.locator(".total-block")).toContainText("15 625,62");
        await expect(frame.locator(".total-block")).toContainText("18 750,75");
        await issue.click();
        const dialog = page.getByRole("alertdialog");
        await expect(dialog).toBeVisible();
        await dialog.getByRole("button", { name: ru ? "Закрыть" : "Close" }).click();
        await expect(issue).toBeFocused();
        await issue.click();
        const publishRequest = page.waitForRequest((request) => request.url().endsWith("/publish"));
        await dialog
          .getByRole("button", { name: ru ? "Подтвердить выпуск" : "Confirm issue" })
          .click();
        expect((await publishRequest).postDataJSON()).toEqual({ previewFingerprint: fingerprint });
        await expect(dialog).toBeVisible();
        fixture.publish.release();
        await expect(
          page.getByRole("heading", { name: "КП-ТЕСТ-0042", exact: true }),
        ).toBeVisible();
        const original = structuredClone(fixture.workspace.offer);
        await page
          .getByRole("button", {
            name: ru ? "Добавить вариант с подписью и печатью" : "Add signature and seal version",
          })
          .click();
        await expect(dialog).toContainText(
          ru ? "это не электронная подпись" : "not an electronic signature",
        );
        await dialog
          .getByRole("button", { name: ru ? "Создать вариант" : "Create version" })
          .click();
        const signed = page.getByRole("region", {
          name: ru ? "С изображениями подписи и печати" : "With signature and seal images",
          exact: true,
        });
        await expect(
          signed.getByRole("button", { name: ru ? "Открыть HTML" : "Open HTML" }),
        ).toBeEnabled();
        await expect(signed).toContainText(ru ? "Не удалось сформировать" : "Generation failed");
        const beforeRetry = structuredClone(
          fixture.workspace.documents.find(
            (item) => item.printVariant === "signed" && item.format === "html",
          ),
        );
        await signed
          .getByRole("button", { name: ru ? "Восстановить файлы" : "Recover files" })
          .click();
        await dialog
          .getByRole("button", { name: ru ? "Создать вариант" : "Create version" })
          .click();
        await expect(dialog).toBeHidden();
        expect(
          fixture.workspace.documents.find(
            (item) => item.printVariant === "signed" && item.format === "html",
          ),
        ).toEqual(beforeRetry);
        expect(fixture.workspace.offer).toEqual(original);
        expect(
          fixture.calls
            .filter((call) => call.method === "POST" && call.url.pathname.endsWith("/documents"))
            .map((call) => call.body),
        ).toEqual([{ printVariant: "signed" }, { printVariant: "signed" }]);
        expect(fixture.calls.filter((call) => call.url.pathname.endsWith("/publish"))).toHaveLength(
          1,
        );
        await noPageOverflow(page);
        await shot(page, info, "issued-detail");
        const pending = page.waitForRequest((request) => request.url().endsWith("/download"));
        await signed.getByRole("button", { name: ru ? "Открыть HTML" : "Open HTML" }).click();
        await pending;
        await page.waitForFunction(() => !navigator.userActivation.isActive);
        expect(context.pages()).toEqual([page]);
        const documentResponse = page.waitForResponse((response) =>
          response.url().endsWith("/synthetic-offer-signed.html"),
        );
        fixture.download.release();
        expect(await (await documentResponse).text()).toBe(signedHtml);
        await expect(page).toHaveURL(/\/synthetic-offer-signed.html$/);
        await expect(page.locator("body")).toHaveAttribute("data-print-variant", "signed");
        await expect(page.locator(".authorized-signature")).toBeVisible();
        await expect(page.locator(".legal-seal")).toBeVisible();
        expect(
          await page
            .locator(".authorized-signature, .legal-seal")
            .evaluateAll((images) =>
              images.every(
                (image) =>
                  (image as HTMLImageElement).complete &&
                  (image as HTMLImageElement).naturalWidth > 0,
              ),
            ),
        ).toBe(true);
        await expect(
          page.getByText("Настройка производственной линии", { exact: true }),
        ).toBeVisible();
        await shot(page, info, "signed-html");
        expect(context.pages()).toEqual([page]);
        expect(violations).toEqual([]);
      });
    }
  }
}
