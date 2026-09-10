import { test, expect } from "./fixture.js";

for (const width of [390, 1440]) {
  for (const locale of ["ru", "en"] as const) {
    for (const theme of ["light", "dark"] as const) {
      test(`pagination alignment ${width} ${locale} ${theme}`, async ({ page, fixture }, info) => {
        void fixture; // Activate strict synthetic API interception for the built app.
        await page.setViewportSize({ width, height: 1000 });
        await page.addInitScript((value) => localStorage.setItem("markiro.theme", value), theme);
        await page.goto("/offers");
        await page.getByRole("button", { name: locale.toUpperCase(), exact: true }).click();
        const ru = locale === "ru";
        const size = page.getByRole("combobox", { name: ru ? "На странице" : "Per page" });
        const previous = page.getByRole("button", { name: ru ? "Назад" : "Previous", exact: true });
        const next = page.getByRole("button", { name: ru ? "Далее" : "Next", exact: true });
        const count = page.getByText(ru ? "Страница 1 из 1" : "Page 1 of 1", { exact: true });
        await expect(size).toBeVisible();
        await expect(previous).toBeDisabled();
        await expect(next).toBeDisabled();
        await expect(count).toBeVisible();
        await page.evaluate(() => document.fonts.ready);
        const bounds = await Promise.all(
          [size, previous, count, next].map((locator) =>
            locator.evaluate((element) => {
              const rect = element.getBoundingClientRect();
              return { bottom: rect.bottom, center: rect.y + rect.height / 2 };
            }),
          ),
        );
        const [selectBox, previousBox, countBox, nextBox] = bounds;
        if (!selectBox || !previousBox || !countBox || !nextBox) throw new Error("Missing control");
        expect(Math.abs(previousBox.center - nextBox.center)).toBeLessThanOrEqual(1);
        expect(Math.abs(countBox.center - nextBox.center)).toBeLessThanOrEqual(1);
        if (width === 1440) {
          expect(Math.abs(selectBox.bottom - nextBox.bottom)).toBeLessThanOrEqual(1);
        }
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
          width,
        );
        await page
          .locator(".offer-pagination")
          .screenshot({ path: info.outputPath("pagination.png") });
      });
    }
  }
}
