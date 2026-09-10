import { expect, test } from "@playwright/test";
for (const rasterizer of ["admin", "station"]) {
  for (const dpi of [203, 300]) {
    for (const name of ["full", "short"]) {
      test(`stock duplicate ${name} name template at ${dpi} dpi uses the same Cyrillic raster on a cold and warm ${rasterizer} font cache`, async ({
        page,
      }, info) => {
        await page.setViewportSize({ width: 900, height: 720 });
        const errors: string[] = [];
        page.on("pageerror", (error) => errors.push(error.message));
        await page.goto(
          `http://127.0.0.1:43181/test/browser/product-label-template.html?rasterizer=${rasterizer}&dpi=${dpi}&name=${name}`,
        );
        await expect(page.locator("html")).toHaveAttribute("data-label-raster", "ready");
        await expect(page.locator("html")).toHaveAttribute("data-cold-font-match", "true");
        await page.evaluate(async () => {
          await document.fonts.ready;
          await new Promise<void>((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
          );
        });
        const canvas = page.locator("canvas");
        expect(await canvas.boundingBox()).toMatchObject({ width: 696, height: 480 });
        await canvas.screenshot({
          path: info.outputPath(`label-58x40-${name}-${dpi}-${rasterizer}.png`),
        });
        expect(errors).toEqual([]);
      });
    }
  }
}
