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

test("Windows driver mode preserves explicit RAW language and compact controls", async ({
  page,
}) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, "__TAURI_INTERNALS__", {
      value: { invoke: async (command: string) => command === "supports_windows_printing" },
    });
  });
  await page.setViewportSize({ width: 1024, height: 768 });
  await page.goto("/?gallery=1&state=setup-printer&locale=ru");
  await page.getByRole("radio", { name: "TSPL", exact: true }).check();
  await page.getByRole("radio", { name: "Принтер Windows", exact: true }).check();
  const mode = page.getByRole("combobox", { name: "Способ печати", exact: true });
  await expect(mode).toBeVisible();
  await mode.selectOption("windows_driver");
  await expect(page.getByRole("radio", { name: "TSPL", exact: true })).toBeHidden();
  await expect(mode).toBeInViewport({ ratio: 1 });
  await expect(page.getByTestId("setup-footer")).toBeInViewport({ ratio: 1 });
  await expect(page.getByText(/Установите драйвер принтера в Windows/)).toBeInViewport({
    ratio: 1,
  });
  await mode.selectOption("raw");
  await expect(page.getByRole("radio", { name: "TSPL", exact: true })).toBeChecked();
  await mode.selectOption("windows_driver");
  await page.getByRole("radio", { name: "Сеть (TCP)", exact: true }).check();
  await expect(page.getByRole("radio", { name: "TSPL", exact: true })).toBeChecked();
});
test("A4 paper has fixed source resolution and checks actual driver settings without claiming a print", async ({
  page,
}, testInfo) => {
  await page.addInitScript(() =>
    Object.defineProperty(window, "__TAURI_INTERNALS__", {
      value: {
        invoke: async (command: string) => {
          if (command === "supports_windows_printing" || command === "supports_windows_a4_printing")
            return true;
          if (command === "get_windows_page_geometry")
            return {
              widthMm: 210,
              heightMm: 297,
              printableBoundsMm: { left: 3, top: 7, right: 205, bottom: 293 },
              guardMm: 0.5,
              deviceDpiX: 600,
              deviceDpiY: 600,
              fingerprint: "browser-fixture",
            };
          return false;
        },
      },
    }),
  );
  await page.setViewportSize({ width: 1024, height: 768 });
  await page.goto("/?gallery=1&state=setup-printer&locale=ru");
  await page.getByRole("radio", { name: "Принтер Windows", exact: true }).check();
  await page
    .getByRole("combobox", { name: "Способ печати", exact: true })
    .selectOption("windows_driver");
  const paper = page.getByRole("combobox", { name: "Тип бумаги", exact: true });
  await paper.selectOption("a4");
  const resolution = page.getByRole("combobox", { name: "Разрешение принтера", exact: true });
  await expect(resolution).toHaveValue("300");
  await expect(resolution).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "Проверить параметры А4", exact: true }),
  ).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("a4-paper-settings.png"), fullPage: true });
});
