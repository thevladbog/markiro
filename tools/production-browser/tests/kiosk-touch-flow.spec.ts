import { expect, test, type Page } from "@playwright/test";

const VIEWPORTS = [
  { width: 480, height: 800 },
  { width: 800, height: 480 },
] as const;

const FIXTURE_SCREENS = [
  "cart",
  "operation",
  "reason",
  "confirmation",
  "accepted",
  "queued",
  "rejected",
  "partial",
] as const;

const KIOSK_ID = "11111111-1111-4111-8111-111111111111";

function bootstrap() {
  return {
    generatedAt: new Date().toISOString(),
    subscription: {
      access: "managed",
      status: "active",
      startsAt: "2026-08-01T00:00:00.000Z",
      endsAt: "2027-08-31T00:00:00.000Z",
    },
    branding: { organizationName: "ООО Маяк", logoUrl: null, logoRevision: null },
    pickupPolicy: { limitsEnabled: false },
    config: { dayLimitPerEmployee: 999, showPrices: true },
    badgeSalt: "MDEyMzQ1Njc4OWFiY2RlZg==",
    reasons: [],
    products: [],
    employees: [],
    operators: [],
  };
}

async function installKioskApiRoutes(page: Page): Promise<void> {
  await page.route("**/api/kiosk/**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/kiosk/pair") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          device: { kioskId: KIOSK_ID, kioskName: "Киоск №1", place: "Проходная" },
          token: "browser-acceptance-token",
          nextDeviceSeq: 1,
          bootstrap: bootstrap(),
        }),
      });
      return;
    }
    if (url.pathname === "/api/kiosk/bootstrap") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(bootstrap()),
      });
      return;
    }
    if (url.pathname === "/api/kiosk/box-registry") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ until: "0", items: [] }),
      });
      return;
    }
    await route.fulfill({ status: 404, contentType: "application/json", body: "{}" });
  });
}

async function expectFixedTouchScreen(page: Page): Promise<void> {
  const defects = await page.evaluate(() => {
    const viewport = { width: window.innerWidth, height: window.innerHeight };
    const screen = document.querySelector<HTMLElement>(".kiosk-screen");
    const scrollable = [...document.querySelectorAll<HTMLElement>(".kiosk-screen *")]
      .filter((element) => {
        const style = getComputedStyle(element);
        return (
          /(auto|scroll)/.test(style.overflowY) && element.scrollHeight > element.clientHeight + 1
        );
      })
      .map((element) => ({
        className: element.className,
        scrollHeight: element.scrollHeight,
        clientHeight: element.clientHeight,
      }));
    const clippedOutcomes = [...document.querySelectorAll<HTMLElement>(".kiosk-done__conflicts")]
      .filter((element) => element.scrollHeight > element.clientHeight + 1)
      .map((element) => ({
        scrollHeight: element.scrollHeight,
        clientHeight: element.clientHeight,
      }));
    const controls = [
      ...document.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), [role="button"], [role="radio"]',
      ),
    ]
      .filter((element) => element.getClientRects().length > 0)
      .map((element) => {
        const rect = element.getBoundingClientRect();
        return {
          label:
            element.getAttribute("aria-label") ?? element.textContent?.trim() ?? element.tagName,
          height: rect.height,
          inBounds:
            rect.left >= -1 &&
            rect.top >= -1 &&
            rect.right <= viewport.width + 1 &&
            rect.bottom <= viewport.height + 1,
        };
      });
    return {
      documentScroll: document.documentElement.scrollHeight - viewport.height,
      screenScroll: screen ? screen.scrollHeight - screen.clientHeight : 1,
      scrollable,
      clippedOutcomes,
      shortControls: controls.filter((control) => control.height < 48),
      outOfBounds: controls.filter((control) => !control.inBounds),
    };
  });

  expect(defects).toEqual({
    documentScroll: 0,
    screenScroll: 0,
    scrollable: [],
    clippedOutcomes: [],
    shortControls: [],
    outOfBounds: [],
  });
}

for (const viewport of VIEWPORTS) {
  test(`real App pairs and reaches branded login at ${viewport.width}x${viewport.height}`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport);
    await installKioskApiRoutes(page);
    await page.goto("/");

    await expect(page.getByRole("heading", { name: "Введите 8-значный код" })).toBeVisible();
    await expectFixedTouchScreen(page);
    await expect(page.getByRole("button", { name: "Сканировать код" })).toHaveCSS(
      "min-height",
      "64px",
    );

    for (const digit of "12345678")
      await page.getByRole("button", { name: digit, exact: true }).click();
    await page.getByRole("button", { name: "Подключить киоск" }).click();
    await expect(page.getByText("Киоск привязан к точке «Проходная»")).toBeVisible();
    await page.getByRole("button", { name: "Начать работу" }).click();

    await expect(page.getByRole("heading", { name: "Отсканируйте пропуск" })).toBeVisible();
    await expect(page.getByText("ООО Маяк")).toBeVisible();
    await expectFixedTouchScreen(page);
  });

  for (const screen of FIXTURE_SCREENS) {
    test(`${screen} is fixed and touch-safe at ${viewport.width}x${viewport.height}`, async ({
      page,
    }) => {
      await page.setViewportSize(viewport);
      await page.goto(`/test/touch-flow.html?screen=${screen}`);
      await expect(page.locator(".kiosk-screen")).toBeVisible();
      await expectFixedTouchScreen(page);
      if (screen === "cart") {
        await expect(page.locator(".kiosk-paged-lines__list > li")).toHaveCount(
          viewport.width < viewport.height ? 5 : 3,
        );
      }
    });
  }
}

test("below-minimum diagnostics and reduced motion are computed in Chromium", async ({ page }) => {
  await page.setViewportSize({ width: 479, height: 799 });
  await page.goto("/test/touch-flow.html?screen=cart");
  await expect(page.getByRole("heading", { name: "Экран устройства слишком мал" })).toBeVisible();
  await expect(page.getByText("479 × 799")).toBeVisible();

  await page.setViewportSize({ width: 480, height: 800 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/test/touch-flow.html?screen=cart");
  await page.keyboard.press("Tab");
  const focused = page.locator(":focus-visible");
  await expect(focused).toBeVisible();
  expect(
    Number.parseFloat(await focused.evaluate((element) => getComputedStyle(element).outlineWidth)),
  ).toBeGreaterThanOrEqual(2);
  await expect(page.locator(".kiosk-control").first()).toHaveCSS("transition-duration", "0s");
});
