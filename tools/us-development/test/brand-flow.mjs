import assert from "node:assert/strict";

export async function expectUsBrand({ page, expect }) {
  const brand = page.getByRole("img", { name: "Markiro", exact: true });
  await expect(brand).toBeVisible();
  await expect(brand).toHaveText("MARKIRO");
  await expect(brand.locator("svg")).toBeVisible();
  await expect(brand.locator("svg rect")).toHaveCount(9);
  await expect(brand).toHaveCSS("font-family", /IBM Plex Mono/);
  await expect(brand).toHaveCSS("font-weight", "600");
  const rendering = await brand.evaluate(async (element) => {
    const loaded = await document.fonts.load('600 16px "IBM Plex Mono"', "MARKIRO");
    const rect = element.getBoundingClientRect();
    const surface = element.closest("aside");
    const tile = element.querySelector("svg > rect");
    const modules = element.querySelectorAll("svg g rect");
    return {
      loadedFont: loaded.some((face) => face.status === "loaded"),
      foreground: getComputedStyle(element).color,
      background: surface && getComputedStyle(surface).backgroundColor,
      tile: tile && getComputedStyle(tile).fill,
      module: modules[0] && getComputedStyle(modules[0]).fill,
      geometry: Array.from(modules, (module) =>
        ["x", "y", "width", "height"].map((attribute) => module.getAttribute(attribute)),
      ),
      fitsViewport: rect.left >= 0 && rect.right <= window.innerWidth,
      fitsSurface: surface && rect.right <= surface.getBoundingClientRect().right,
    };
  });
  assert.equal(rendering.loadedFont, true, "The branded font must load locally, not fall back");
  assert.notEqual(rendering.foreground, rendering.background);
  assert.equal(rendering.tile, rendering.foreground);
  assert.equal(rendering.module, rendering.background);
  assert.deepEqual(rendering.geometry, [
    ["14", "14", "8", "8"],
    ["14", "26", "8", "8"],
    ["14", "38", "8", "8"],
    ["26", "22", "8", "8"],
    ["38", "14", "8", "8"],
    ["38", "26", "8", "8"],
    ["38", "38", "8", "8"],
    ["26", "42", "8", "8"],
  ]);
  assert.equal(rendering.fitsViewport, true);
  assert.equal(rendering.fitsSurface, true);
}
