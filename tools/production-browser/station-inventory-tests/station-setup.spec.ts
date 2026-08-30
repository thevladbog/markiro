import { expect, test } from "@playwright/test";

test("printer language choices stay visible in the compact Station work slot", async ({ page }) => {
  // The real 1024×768 shell reserves height for its status bar. The gallery
  // renders only the route slot, so 600px reproduces the remaining work area.
  await page.setViewportSize({ width: 1024, height: 600 });
  await page.goto("/?gallery=1&state=setup-printer&locale=ru", {
    waitUntil: "domcontentloaded",
  });

  const gallery = page.getByTestId("station-screen-gallery");
  await expect(gallery).toHaveAttribute("data-gallery-state", "setup-printer");

  for (const name of ["ZPL", "TSPL"]) {
    const choice = page.getByRole("radio", { name });
    await expect(choice).toBeVisible();
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
