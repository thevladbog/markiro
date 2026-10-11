import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { productLabelsEndpoints } from "../product-labels.playwright.config.js";
const origin = productLabelsEndpoints().adminUrl;
for (const company of [false, true])
  for (const dpi of [203, 300]) {
    test(`standard thermal family ${dpi} dpi ${company ? "company" : "Markiro"} logo`, async ({
      page,
    }, info) => {
      const source = readFileSync(
        new URL("../../../apps/admin/test/browser/branding-company.webp", import.meta.url),
      );
      const revision = "a1111111-1111-4111-8111-111111111111";
      await page.route("**/api/org/profile/print-branding", (route) =>
        route.fulfill({
          json: {
            organizationName: "Test company",
            logoRevision: company ? revision : null,
            logoUrl: company ? `/org/profile/print-branding/logo/${revision}` : null,
            logo: company
              ? {
                  contentType: "image/webp",
                  byteSize: source.length,
                  checksum: createHash("sha256").update(source).digest("hex"),
                  width: 900,
                  height: 90,
                }
              : null,
          },
        }),
      );
      await page.route(`**/api/org/profile/print-branding/logo/${revision}`, (route) =>
        route.fulfill({ status: 200, contentType: "image/webp", body: source }),
      );
      await page.goto(`${origin}/test/browser/standard-thermal-labels.html?dpi=${dpi}&long&max`);
      await expect.poll(() => page.locator("html").getAttribute("data-thermal-error")).toBeNull();
      await expect(page.locator("html")).toHaveAttribute("data-thermal-ready", "true");
      await expect(page.locator("html")).toHaveAttribute("data-thermal-count", "14");
      await expect(page.locator("html")).toHaveAttribute("data-thermal-parity", "true");
      const overlaps = await page.locator("html").getAttribute("data-thermal-regions");
      await expect(page.locator("html"), overlaps ?? "overlap check").toHaveAttribute(
        "data-thermal-overlaps",
        "0",
      );
      for (const size of ["75×120", "100×150"]) {
        await page
          .locator(`section[data-template="Палета ${size}"] canvas`)
          .screenshot({ path: info.outputPath(`pallet-${size}.png`) });
      }
      for (const size of ["75×120", "100×100", "100×150"]) {
        const canvas = page.locator(`section[data-template="Коробка ${size}"] canvas`);
        await info.attach(`${size}.png`, {
          body: await canvas.screenshot({ path: info.outputPath(`${size}.png`) }),
          contentType: "image/png",
        });
      }
    });
  }
