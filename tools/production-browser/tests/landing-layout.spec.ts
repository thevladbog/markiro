import { expect, test } from "@playwright/test";

for (const width of [320, 390, 412, 768, 1440, 1920, 3440])
  for (const theme of ["light", "dark"]) {
    test(`V4 layout at ${width}px in ${theme}`, async ({ page }) => {
      await page.setViewportSize({ width, height: 1100 });
      await page.emulateMedia({ reducedMotion: "no-preference" });
      for (const path of ["/", "/skachat/", "/stoimost/"]) {
        await page.goto(path);
        await page.evaluate((t) => (document.documentElement.dataset.theme = t), theme);
        await page.evaluate(() => document.fonts.ready);
        expect(
          await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
          path,
        ).toBe(true);
        await expect(page.locator("main")).toHaveCount(1);
        if (path === "/") {
          await expect(page.getByRole("heading", { level: 1 })).toHaveText(
            "Программа для агрегации кодов маркировки",
          );
          await expect(
            page.getByText(
              "Проверка кодов, сборка коробов и паллет, печать этикеток — как на станции.",
              { exact: true },
            ),
          ).toBeVisible();
          const work = await page.locator("#produkt").boundingBox(),
            office = await page.locator("#bez-oblaka").boundingBox();
          expect(work!.y).toBeLessThan(office!.y);
          const viewport = await page.locator(".ax-clients__viewport").boundingBox();
          for (const phase of [0, 0.25, 0.5, 0.75, 0.999]) {
            const bounds = await page.locator(".ax-clients__track").evaluate((el, phase) => {
              const animation = el.getAnimations()[0];
              animation?.pause();
              if (animation)
                animation.currentTime = Number(animation.effect?.getTiming().duration) * phase;
              const r = el.getBoundingClientRect();
              return { left: r.left, right: r.right };
            }, phase);
            expect(bounds.left).toBeLessThanOrEqual(viewport!.x + 1);
            expect(bounds.right).toBeGreaterThanOrEqual(viewport!.x + viewport!.width - 1);
          }
        }
        if (width >= 1000 && path !== "/skachat/") {
          const buttons = await page
            .locator(".ax-prices__grid .ax-plan__actions > .ax-btn")
            .evaluateAll((es) => es.map((e) => e.getBoundingClientRect().top));
          expect(Math.max(...buttons) - Math.min(...buttons)).toBeLessThanOrEqual(1);
        }
      }
    });
  }

test("download footer reaches the bottom and mobile email is above the fold", async ({ page }) => {
  for (const viewport of [
    { width: 1920, height: 1600 },
    { width: 390, height: 844 },
  ]) {
    await page.setViewportSize(viewport);
    await page.goto("/skachat/");
    const consent = page.locator("[data-consent-panel]");
    if (await consent.isVisible()) {
      if (viewport.width === 390)
        expect((await consent.boundingBox())!.height).toBeLessThanOrEqual(220);
      await page.locator("[data-consent-reject]").click();
    }
    const footer = await page.locator("footer").boundingBox(),
      main = await page.locator("main").boundingBox();
    expect(footer!.y + footer!.height).toBeGreaterThanOrEqual(viewport.height - 1);
    expect(footer!.y).toBeGreaterThanOrEqual(main!.y + main!.height - 1);
    if (viewport.width === 390) {
      const email = await page.locator("#download-email").boundingBox(),
        form = await page.locator("[data-lead-form]").boundingBox();
      expect(form!.y).toBeLessThanOrEqual(600);
      expect(email!.y + email!.height).toBeLessThanOrEqual(844);
    }
  }
});

test("office screenshot enlarges and Escape returns keyboard focus", async ({ page }) => {
  await page.goto("/");
  await page.locator("[data-consent-reject]").click();
  const open = page.getByRole("button", { name: "Увеличить экран офиса", exact: true });
  await open.click();
  await expect(page.locator("[data-screen-dialog]")).toBeVisible();
  expect(
    await page.locator("[data-screen-image]").evaluate((el: HTMLImageElement) => el.naturalWidth),
  ).toBeGreaterThan(0);
  await page.keyboard.press("Escape");
  await expect(page.locator("[data-screen-dialog]")).not.toBeVisible();
  await expect(open).toBeFocused();
});

test("download never contains a third-party captcha", async ({ page }) => {
  await page.goto("/skachat/");
  await expect(page.locator(".smart-captcha")).toHaveCount(0);
  await expect(page.locator("[data-lead-fields]")).toBeEnabled();
  await expect(page.locator("body")).not.toContainText("SmartCaptcha");
});
