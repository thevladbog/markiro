import { expect, test } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import {
  capabilitiesFixture,
  id,
  linkFixture,
  photoFixtureBase64,
  previewFixture,
  productFixture,
  sessionFixture,
} from "../../../apps/admin/test/national-catalog-fixtures.js";
import {
  chzLinkDetailSchema,
  importPrepareResponseSchema,
} from "../../../packages/platform-contracts/dist/index.js";
import ru from "../../../apps/admin/src/i18n/ru.json" with { type: "json" };
import en from "../../../apps/admin/src/i18n/en.json" with { type: "json" };

const origin = "http://127.0.0.1:43183";
for (const width of [390, 768, 1280, 1600])
  for (const lang of ["ru", "en"] as const)
    for (const theme of ["light", "dark"] as const) {
      test(`catalog and review content ${width} ${lang} ${theme}`, async ({ page }) => {
        const dictionary = lang === "ru" ? ru : en;
        const t = dictionary.pages.catalog;
        const unexpected: string[] = [];
        const errors: string[] = [];
        page.on("pageerror", (error) => errors.push(error.message));
        await page.setViewportSize({ width, height: 1000 });
        await page.addInitScript((value) => localStorage.setItem("markiro.theme", value), theme);
        const detail = chzLinkDetailSchema.parse({
          ...linkFixture,
          summary: {
            ...linkFixture.summary,
            statusKeys: ["published", "moderation", "unknown"],
            rawStatus: "STATUS_NEW",
            rawDetailedStatuses: ["Проверка дополнительных сведений производителя"],
            lastErrorCode: "photo_unavailable",
            hasChanges: true,
          },
        });
        const names = [
          "Молоко фермерское пастеризованное 3,2 %, бутылка 930 мл",
          "Йогурт натуральный с клубникой и злаками, семейная упаковка 500 г",
          "Organic oat drink with vanilla, family carton 1 l",
        ];
        const gtins = ["04006381333931", "04601234567893", "05901234123457"];
        const products = names.map((name, index) => ({
          ...productFixture,
          id: id(99 + index),
          gtin14: gtins[index],
          name,
          productGroup: "Молочная продукция / Dairy products",
          boxCapacity: 12,
          status: index === 1 ? "active" : "draft",
          chz:
            index === 0
              ? detail.summary
              : {
                  ...linkFixture.summary,
                  linkId: id(88 + index),
                  statusKeys: index === 1 ? ["draft"] : ["errors", "unsigned"],
                },
          image: {
            checksum: "a".repeat(64),
            contentType: "image/webp",
            byteSize: 472,
            width: 120,
            height: 120,
          },
        }));
        const preparation = importPrepareResponseSchema.parse({
          ...previewFixture,
          preparation: { ...previewFixture.preparation, total: 3, completed: 3 },
          items: names.map((name, index) => ({
            ...previewFixture.items[0],
            id: id(12 + index),
            itemId: id(2 + index),
            identity: { gtin14: gtins[index], cardId: `card-${index + 1}`, name },
            productId: index === 0 ? productFixture.id : null,
            fields: [
              {
                ...previewFixture.items[0]!.fields[0],
                id: id(40 + index),
                before: index === 0 ? "Молоко фермерское" : null,
                after: name,
              },
            ],
            photos: [
              {
                candidateId: id(30 + index),
                state: "ready",
                previewPath: null,
                primary: true,
                selectedByDefault: false,
                reason: null,
              },
            ],
          })),
        });
        await page.route(`${origin}/api/**`, async (route) => {
          const path = new URL(route.request().url()).pathname;
          if (/\/image[s]?\//.test(path)) {
            await route.fulfill({
              contentType: "image/webp",
              body: Buffer.from(photoFixtureBase64, "base64"),
            });
            return;
          }
          let body: unknown;
          if (route.request().method() !== "GET") {
            unexpected.push(path);
            await route.abort();
            return;
          }
          if (path === "/api/access/me")
            body = { roles: ["manager"], capabilities: ["operations.read", "operations.write"] };
          else if (path === "/api/profile")
            body = { firstName: "Игорь", middleName: null, lastName: "Волков", hasAvatar: false };
          else if (path === "/api/products") body = { items: products };
          else if (["/api/counterparties", "/api/pickup-orders"].includes(path))
            body = { items: [] };
          else if (path === "/api/national-catalog/capabilities") body = capabilitiesFixture;
          else if (path.endsWith("/national-catalog/link")) body = detail;
          else if (path.includes("/preparations/")) body = preparation;
          else if (path.includes("/import-sessions/")) body = sessionFixture;
          else {
            unexpected.push(path);
            await route.abort();
            return;
          }
          await route.fulfill({ contentType: "application/json", body: JSON.stringify(body) });
        });
        const open = (route: string) =>
          `/test/browser/national-catalog-harness.html?lang=${lang}&route=${encodeURIComponent(route)}`;
        await page.goto(open("/catalog"));
        await expect(page.locator("html")).toHaveAttribute("lang", lang);
        await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
        // Current responsive implementation remains a horizontally scrollable table at all widths.
        const table = page.locator(".mk-catalog-table table");
        await expect(table.getByRole("row")).toHaveCount(4);
        await expect(
          table.getByRole("columnheader", { name: t.chz.column, exact: true }),
        ).toBeVisible();
        await expect(
          table.getByRole("columnheader", { name: t.table.status, exact: true }),
        ).toBeVisible();
        await expect(table.getByRole("img")).toHaveCount(3);
        for (const img of await table.getByRole("img").all())
          await expect(img).toHaveJSProperty("naturalWidth", 120);
        expect(await table.evaluate((el) => getComputedStyle(el).tableLayout)).toBe("auto");
        for (const name of await table.locator(".mk-catalog-product-name").all())
          expect((await name.boundingBox())?.width).toBeGreaterThanOrEqual(220);
        await expect(table.locator(".mk-catalog-product-name")).toHaveCount(3);
        for (const cell of await table.locator("tbody tr td:nth-child(4)").all())
          expect(
            await cell.evaluate((el) => {
              const style = getComputedStyle(el);
              return (
                el.getBoundingClientRect().width -
                parseFloat(style.paddingLeft) -
                parseFloat(style.paddingRight)
              );
            }),
          ).toBeGreaterThanOrEqual(140);
        await expect(table.locator(".mk-catalog-product-group")).toHaveCount(3);
        for (const group of await table.locator(".mk-catalog-product-group").all())
          expect((await group.boundingBox())?.width).toBeGreaterThanOrEqual(140);
        // Measure actual text and controls against their OWN cell, independently of permitted container scrolling.
        const escapes = await table.locator("td").evaluateAll((cells) =>
          cells.flatMap((cell) => {
            const bounds = cell.getBoundingClientRect();
            const escaped: string[] = [];
            const walker = document.createTreeWalker(cell, NodeFilter.SHOW_TEXT);
            let node: Node | null;
            while ((node = walker.nextNode())) {
              if (!node.textContent?.trim() || !node.parentElement?.checkVisibility()) continue;
              const range = document.createRange();
              range.selectNodeContents(node);
              if (
                [...range.getClientRects()].some(
                  (r) => r.width > 0 && (r.left < bounds.left - 1 || r.right > bounds.right + 1),
                )
              )
                escaped.push(node.textContent.trim());
            }
            for (const control of cell.querySelectorAll("button,a,img")) {
              if (!control.checkVisibility()) continue;
              const r = control.getBoundingClientRect();
              if (r.left < bounds.left - 1 || r.right > bounds.right + 1)
                escaped.push(control.tagName);
            }
            return escaped;
          }),
        );
        expect(escapes).toEqual([]);
        const scroll = page.locator(".mk-catalog-table .mk-table__scroll");
        expect(await scroll.evaluate((el) => getComputedStyle(el).overflowX)).toBe("auto");
        expect(
          await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1),
        ).toBe(true);
        // Filtering includes secondary statuses, not only the first visible chip.
        await page.getByRole("combobox", { name: t.chz.filter, exact: true }).click();
        await page.getByRole("option", { name: t.import.statuses.moderation, exact: true }).click();
        await expect(table.getByRole("row")).toHaveCount(2);
        await expect(table.getByText(names[0]!, { exact: true })).toBeVisible();
        await page.getByRole("combobox", { name: t.chz.filter, exact: true }).click();
        await page.getByRole("option", { name: t.statusFilter.all, exact: true }).click();
        await expect(table.getByRole("row")).toHaveCount(4);
        const firstRow = table.getByRole("row").nth(1);
        const link = firstRow.getByRole("link", { name: t.chz.open });
        await link.focus();
        await expect(link).toBeFocused();
        await expect(link).toBeInViewport();
        const evidence = resolve("../../docs/evidence/national-catalog-import");
        if (
          process.env.NC_UPDATE_SCREENSHOTS === "1" &&
          ([390, 1280].includes(width) || (width === 1600 && lang === "ru" && theme === "light"))
        ) {
          await mkdir(evidence, { recursive: true });
          await page.screenshot({
            path: resolve(evidence, `final-fix-layout-catalog-${width}-${lang}-${theme}.png`),
            animations: "disabled",
            fullPage: true,
          });
        }
        await page.keyboard.press("Enter");
        const panel = page.getByRole("dialog");
        await expect(panel.getByText("card-1", { exact: true })).toBeVisible();
        await panel.getByRole("button", { name: dictionary.common.close, exact: true }).focus();
        await page.keyboard.press("Escape");
        await expect(panel).toHaveCount(0);
        await page.goto(open(`/catalog/import?sessionId=${id(1)}&preparationId=${id(10)}`));
        await expect(page.locator(".mk-nc-review-item")).toHaveCount(3);
        for (const fieldset of await page.locator(".mk-nc-review-item").all()) {
          await expect(
            fieldset.getByRole("img", { name: t.import.photoPreview, exact: true }),
          ).toHaveJSProperty("naturalWidth", 120);
          const choose = fieldset.getByRole("radio", { name: t.import.choosePhoto, exact: true });
          await choose.focus();
          await expect(choose).toBeInViewport();
          await page.keyboard.press("Space");
          await expect(choose).toBeChecked();
        }
        expect(
          await page.getByRole("dialog").evaluate((el) => el.scrollWidth <= el.clientWidth + 1),
        ).toBe(true);
        if (process.env.NC_UPDATE_SCREENSHOTS === "1" && [390, 1280].includes(width)) {
          await page.locator(".mk-nc-review-item").first().scrollIntoViewIfNeeded();
          await page.screenshot({
            path: resolve(evidence, `final-fix-layout-review-${width}-${lang}-${theme}.png`),
            animations: "disabled",
            fullPage: true,
          });
        }
        if (width === 1280 && lang === "ru" && theme === "light") {
          products[2]!.name = "LongExternalProductName".repeat(12);
          products[2]!.productGroup = "LongExternalGroupName".repeat(12);
          await page.goto(open("/catalog"));
          await expect(table.getByRole("row")).toHaveCount(4);
          for (const selector of [".mk-catalog-product-name", ".mk-catalog-product-group"]) {
            const layout = await table
              .locator(selector)
              .nth(2)
              .evaluate((el) => {
                const bounds = el.getBoundingClientRect();
                const range = document.createRange();
                range.selectNodeContents(el);
                const lines = Array.from(range.getClientRects());
                return {
                  lines: lines.length,
                  escaped: lines.some(
                    (r) => r.left < bounds.left - 1 || r.right > bounds.right + 1,
                  ),
                };
              });
            expect(layout.lines).toBeGreaterThan(1);
            expect(layout.escaped).toBe(false);
          }
        }
        expect(errors).toEqual([]);
        expect(unexpected).toEqual([]);
      });
    }
