import { expect, test, type Locator } from "@playwright/test";

async function expectUnclipped(control: Locator) {
  await expect(control).toBeInViewport({ ratio: 1 });
  expect(
    await control.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      const points = [
        [rect.left + 8, rect.top + 8],
        [rect.right - 8, rect.bottom - 8],
      ] as const;
      return points.every(([x, y]) => {
        const hit = document.elementFromPoint(x, y);
        return hit !== null && element.contains(hit);
      });
    }),
  ).toBe(true);
}

for (const locale of ["ru", "en"] as const) {
  for (const viewport of [
    { width: 800, height: 600 },
    { width: 1024, height: 600 },
    { width: 1024, height: 768 },
    { width: 1280, height: 800 },
  ]) {
    test(`update versions and manual confirmation fit ${viewport.width}×${viewport.height} ${locale}`, async ({
      page,
    }, testInfo) => {
      await page.setViewportSize(viewport);
      await page.goto(`/?gallery=1&state=update-warn&locale=${locale}`);
      await expect(page.getByTestId("station-screen-gallery")).toHaveAttribute(
        "data-gallery-state",
        "update-warn",
      );
      await page.evaluate(() => document.fonts.ready);

      const installed = page.getByText("0.1.0-beta.22", { exact: true });
      const available = page.getByText("1.4.2-beta.1", { exact: true });
      await expect(installed).toBeVisible();
      await expect(available).toBeVisible();
      const installedBox = await installed.boundingBox();
      const availableBox = await available.boundingBox();
      expect(installedBox).not.toBeNull();
      expect(availableBox).not.toBeNull();
      if (!installedBox || !availableBox) throw new Error("Version bounds are unavailable");
      expect.soft(Math.abs(installedBox.y - availableBox.y)).toBeLessThanOrEqual(1);
      expect.soft(availableBox.x).toBeGreaterThanOrEqual(installedBox.x + installedBox.width);

      const install = page.getByRole("button", {
        name: locale === "ru" ? "Скачать и установить" : "Download and install",
        exact: true,
      });
      await expectUnclipped(install);
      await page.screenshot({ path: testInfo.outputPath("update-versions.png") });
      await install.click();

      const confirm = page.getByRole("button", {
        name: locale === "ru" ? "Подтвердить обновление" : "Confirm update",
        exact: true,
      });
      // Exercise an actual user scroll: hidden overflow must not pass merely
      // because scrollIntoView can move even a non-scrollable clipped ancestor.
      await page.locator(".station-update-center").hover();
      await page.mouse.wheel(0, 1000);
      await expectUnclipped(confirm);
      await expectUnclipped(install);
      await page.screenshot({ path: testInfo.outputPath("update-confirmation.png") });
      await page
        .getByRole("button", { name: locale === "ru" ? "Отмена" : "Cancel", exact: true })
        .click();
      await expect(confirm).toHaveCount(0);
      await expect(install).toBeEnabled();
    });
  }
}
