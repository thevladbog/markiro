import { expect, test } from "@playwright/test";

test("printer language choices stay visible in the compact Station work slot", async ({ page }) => {
  // The gallery renders the full shell, including the real status/actions header.
  // Use the physical screen size; subtracting header space here would count it twice.
  await page.setViewportSize({ width: 1024, height: 768 });
  await page.goto("/?gallery=1&state=setup-printer&locale=ru", {
    waitUntil: "domcontentloaded",
  });

  const gallery = page.getByTestId("station-screen-gallery");
  await expect(gallery).toHaveAttribute("data-gallery-state", "setup-printer");
  await expect(page.getByRole("banner")).toBeInViewport({ ratio: 1 });
  await expect(page.getByTestId("setup-footer")).toBeInViewport({ ratio: 1 });

  for (const name of ["ZPL", "TSPL"]) {
    const choice = page.getByRole("radio", { name });
    await expect(choice).toBeVisible();
    await expect(choice.locator("..")).toBeInViewport({ ratio: 1 });
    expect(
      await choice.evaluate((element) => {
        const rect = element.getBoundingClientRect();
        let ancestor = element.parentElement;
        let clipped = rect.bottom > window.innerHeight || rect.right > window.innerWidth;
        while (!clipped && ancestor && ancestor !== document.body) {
          const style = getComputedStyle(ancestor);
          if (
            [style.overflowX, style.overflowY].some((value) => ["hidden", "clip"].includes(value))
          ) {
            const boundary = ancestor.getBoundingClientRect();
            clipped =
              rect.left < boundary.left - 0.5 ||
              rect.top < boundary.top - 0.5 ||
              rect.right > boundary.right + 0.5 ||
              rect.bottom > boundary.bottom + 0.5;
          }
          ancestor = ancestor.parentElement;
        }
        return clipped;
      }),
    ).toBe(false);
  }
});

for (const viewport of [
  { width: 1024, height: 768 },
  { width: 1280, height: 800 },
  { width: 1280, height: 1024 },
]) {
  test(`printer resolution and verification remain reachable at ${viewport.width}×${viewport.height}`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport);
    await page.goto("/?gallery=1&state=setup-printers&locale=ru");

    // Verification applies to box labels across profiles and lives below the list.
    const verification = page.getByRole("checkbox", {
      name: "Проверять этикетку короба обратным сканированием",
      exact: true,
    });
    await expect(verification.locator("..")).toBeInViewport({ ratio: 1 });
    expect((await verification.locator("..").boundingBox())?.height).toBeGreaterThanOrEqual(64);
    await verification.uncheck();
    await expect(verification).not.toBeChecked();
    await verification.check();
    await expect(verification).toBeChecked();

    await page
      .getByRole("button", { name: /^Настроить / })
      .first()
      .click();
    const resolution = page.getByRole("combobox", { name: "Разрешение принтера" });
    await expect(resolution).toBeInViewport({ ratio: 1 });
    expect((await resolution.boundingBox())?.height).toBeGreaterThanOrEqual(64);
    for (const dpi of ["203", "300"]) {
      await resolution.selectOption(dpi);
      await expect(resolution).toHaveValue(dpi);
    }

    await page.getByRole("button", { name: "Сохранить принтер", exact: true }).click();
    await expect(verification.locator("..")).toBeInViewport({ ratio: 1 });
    await expect(verification).toBeChecked();
    await page
      .getByRole("button", { name: /^Настроить / })
      .first()
      .click();
    await expect(resolution).toHaveValue("300");
    await expect(page.getByRole("button", { name: "Готово", exact: true })).toBeInViewport({
      ratio: 1,
    });
  });
}
