import { expect, test } from "@playwright/test";

for (const width of [390, 1440, 2560, 3440]) {
  for (const theme of ["light", "dark"]) {
    test(`landing layout at ${width}px in ${theme}`, async ({ page }) => {
      await page.setViewportSize({ width, height: 1100 });
      await page.goto("/");
      await page.evaluate((value) => (document.documentElement.dataset.theme = value), theme);
      await page.emulateMedia({ reducedMotion: "no-preference" });
      await page.evaluate(() => document.fonts.ready);
      const strip = page.locator(".ax-clients__viewport");
      const groupWidths = await strip
        .locator(".ax-clients__list")
        .evaluateAll((lists) => lists.map((list) => list.getBoundingClientRect().width));
      const viewport = await strip.boundingBox();
      expect
        .soft(Math.round(Math.min(...groupWidths)))
        .toBeGreaterThanOrEqual(viewport?.width ?? width);
      for (const progress of [0, 0.25, 0.5, 0.75, 0.999]) {
        const coverage = await page.locator(".ax-clients__track").evaluate((track, fraction) => {
          const animation = track.getAnimations()[0];
          animation?.pause();
          if (animation)
            animation.currentTime = Number(animation.effect?.getTiming().duration) * fraction;
          const bounds = track.getBoundingClientRect();
          return { left: bounds.left, right: bounds.right };
        }, progress);
        expect.soft(coverage.left).toBeLessThanOrEqual(viewport?.x ?? 0);
        expect
          .soft(coverage.right)
          .toBeGreaterThanOrEqual((viewport?.x ?? 0) + (viewport?.width ?? width));
      }
      const wires = await page.locator(".ax-network__wires").evaluate((element) => ({
        border: getComputedStyle(element).borderLeftWidth,
        junction: getComputedStyle(element, "::after").backgroundImage,
      }));
      expect.soft(wires.border).toBe("0px");
      expect.soft(wires.junction).not.toBe("none");
      const covers = await page
        .locator(".ax-docs__cover")
        .evaluateAll((elements) =>
          elements.map((element) => getComputedStyle(element).backgroundColor),
        );
      expect
        .soft(covers)
        .toEqual(["rgb(255, 255, 255)", "rgb(255, 255, 255)", "rgb(255, 255, 255)"]);
      if (width >= 1440) {
        for (const route of ["/", "/stoimost/"]) {
          await page.goto(route);
          const buttons = await page
            .locator(".ax-prices__grid .ax-plan__actions > .ax-btn")
            .evaluateAll((elements) =>
              elements.map((element) => element.getBoundingClientRect().top),
            );
          expect.soft(Math.max(...buttons) - Math.min(...buttons)).toBeLessThanOrEqual(1);
        }
      }
      await page.goto("/skachat/");
      await expect.soft(page.getByText("Системные требования", { exact: true })).toBeVisible();
      await expect.soft(page.locator(".ax-meta")).toContainText("Windows 10");
      expect
        .soft(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
        .toBe(true);
    });
  }
}

test("download footer reaches the bottom of a tall viewport and follows long content", async ({
  page,
}) => {
  for (const viewport of [
    { width: 1920, height: 1600 },
    { width: 390, height: 844 },
  ]) {
    await page.setViewportSize(viewport);
    await page.goto("/skachat/");
    const footer = await page.locator(".ax-footer").boundingBox();
    const main = await page.locator("main").boundingBox();
    expect
      .soft((footer?.y ?? 0) + (footer?.height ?? 0))
      .toBeGreaterThanOrEqual(viewport.height - 1);
    expect.soft(footer?.y).toBeGreaterThanOrEqual((main?.y ?? 0) + (main?.height ?? 0) - 1);
  }
});

test("download form is independent of Yandex SmartCaptcha", async ({ page }) => {
  await page.goto("/skachat/");
  await expect.soft(page.locator(".smart-captcha")).toHaveCount(0);
  await expect.soft(page.locator("body")).not.toContainText("SmartCaptcha");
  await expect.soft(page.locator("[data-lead-fields]")).toBeEnabled();
});

test("download system facts fit their cells before and after release metadata loads", async ({
  page,
}) => {
  for (const width of [390, 1024, 1280, 1440]) {
    await page.setViewportSize({ width, height: 1000 });
    await page.goto("/skachat/");
    for (const showRelease of [false, true]) {
      const lines = await page.evaluate((show) => {
        for (const item of document.querySelectorAll<HTMLElement>("[data-release-fact]")) {
          item.hidden = !show;
          const value = item.querySelector("dd");
          if (value) value.textContent = "1.1.1";
        }
        return [...document.querySelectorAll(".ax-meta > div:not([data-release-fact]) dd")].map(
          (element) => {
            const range = new Range();
            range.selectNodeContents(element);
            return range.getClientRects().length;
          },
        );
      }, showRelease);
      expect.soft(lines, `${width}px, release ${showRelease}`).toEqual(lines.map(() => 1));
    }
  }
});
