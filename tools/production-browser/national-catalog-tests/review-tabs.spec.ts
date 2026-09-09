import { expect, test } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { gs1CheckDigit } from "../../../packages/domain/dist/index.js";
import {
  importApplySchema,
  importPrepareResponseSchema,
} from "../../../packages/platform-contracts/dist/index.js";
import {
  capabilitiesFixture,
  id,
  photoFixtureBase64,
  previewFixture,
  resultFixture,
  sessionFixture,
} from "../../../apps/admin/test/national-catalog-fixtures.js";

for (const width of [390, 1280]) {
  for (const count of [2, 5, 100]) {
    test(`reviews ${count} products in a bounded tab strip at ${width}px and applies the whole batch`, async ({
      page,
    }) => {
      const origin = "http://127.0.0.1:43183";
      const theme = width === 390 ? "dark" : "light";
      const data = importPrepareResponseSchema.parse({
        preparation: { ...previewFixture.preparation, total: count, completed: count },
        items: Array.from({ length: count }, (_, index) => ({
          ...previewFixture.items[0],
          id: id(1000 + index),
          itemId: id(2000 + index),
          identity: {
            cardId: `card-${index}`,
            gtin14: `0460123456${String(index).padStart(3, "0")}${gs1CheckDigit(`0460123456${String(index).padStart(3, "0")}`)}`,
            name: [
              "Молоко пастеризованное 3,2 %",
              "Кефир 2,5 %",
              "Творог 5 %",
              "Сметана 20 %",
              "Йогурт натуральный",
            ][index % 5],
          },
          fields: [
            {
              ...previewFixture.items[0]!.fields[0],
              id: id(3000 + index),
              after: [
                "Молоко пастеризованное 3,2 %",
                "Кефир 2,5 %",
                "Творог 5 %",
                "Сметана 20 %",
                "Йогурт натуральный",
              ][index % 5],
            },
            {
              ...previewFixture.items[0]!.fields[0],
              id: id(4000 + index),
              labelKey: "print_name",
              label: "Название для печати",
              after: `Упаковка ${index + 1}`,
            },
            {
              id: id(6000 + index),
              label: "Код поставщика",
              before: null,
              after: `НК-${index + 1}`,
              source: "national_catalog",
              applicable: false,
              selectedByDefault: false,
              reason: "attribute_not_importable",
              requiresEntryIds: [],
            },
            {
              ...previewFixture.items[0]!.fields[0],
              id: id(7000 + index),
              labelKey: "egais_code",
              label: "Код продукции в ЕГАИС",
              after: "0300005753630000036",
            },
            {
              ...previewFixture.items[0]!.fields[0],
              id: id(8000 + index),
              labelKey: "shelf_life_days",
              label: "Срок годности",
              after: "180",
            },
          ],
          photos: [
            {
              candidateId: id(5000 + index),
              state: "ready",
              reason: null,
              previewPath: null,
              primary: true,
              selectedByDefault: true,
            },
          ],
        })),
      });
      const writes: ReturnType<typeof importApplySchema.parse>[] = [];
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.setViewportSize({ width, height: 1100 });
      await page.addInitScript((value) => localStorage.setItem("markiro.theme", value), theme);
      await page.route(`${origin}/api/**`, async (route) => {
        const path = new URL(route.request().url()).pathname;
        if (path.includes("/images/")) {
          await route.fulfill({
            contentType: "image/webp",
            body: Buffer.from(photoFixtureBase64, "base64"),
          });
          return;
        }
        let body: unknown;
        if (path.endsWith("/applies") && route.request().method() === "POST") {
          writes.push(importApplySchema.parse(route.request().postDataJSON()));
          body = resultFixture;
        } else if (route.request().method() !== "GET") throw new Error(`Unexpected write: ${path}`);
        else if (path === "/api/access/me")
          body = { roles: ["manager"], capabilities: ["operations.read", "operations.write"] };
        else if (path === "/api/profile")
          body = { firstName: "Игорь", middleName: null, lastName: "Волков", hasAvatar: false };
        else if (["/api/products", "/api/counterparties", "/api/pickup-orders"].includes(path))
          body = { items: [] };
        else if (path.endsWith("/capabilities")) body = capabilitiesFixture;
        else if (path.includes("/preparations/")) body = data;
        else if (path.includes("/applies/")) body = resultFixture;
        else if (path.includes("/import-sessions/"))
          body = {
            ...sessionFixture,
            selected: count,
            selectedItemIds: data.items.map((p) => p.itemId),
          };
        else throw new Error(`Unexpected request: ${path}`);
        await route.fulfill({ contentType: "application/json", body: JSON.stringify(body) });
      });
      const route = `/catalog/import?sessionId=${id(1)}&preparationId=${id(10)}`;
      await page.goto(
        `/test/browser/national-catalog-harness.html?route=${encodeURIComponent(route)}`,
      );
      const tabs = page.getByRole("tab");
      const panel = page.getByRole("tabpanel");
      await expect(tabs).toHaveCount(count);
      await expect(panel).toHaveCount(1);
      await expect(
        page.getByRole("heading", { name: "Проверка товаров", exact: true }),
      ).toBeVisible();
      const filter = page.getByRole("checkbox", { name: "Отображать только сопоставимые поля" });
      await expect(filter).not.toBeChecked();
      await expect(panel.getByRole("group", { name: "Код поставщика" })).toBeVisible();
      await filter.check();
      await expect(panel.getByRole("group", { name: "Код поставщика" })).toHaveCount(0);
      await panel.getByRole("radio", { name: "Название для печати — Сейчас в Markiro" }).click();
      await panel.getByRole("radio", { name: "Без фото", exact: true }).click();
      await tabs.first().focus();
      await page.keyboard.press("End");
      await expect(tabs.last()).toBeFocused();
      await expect(tabs.last()).toHaveAttribute("aria-selected", "true");
      await expect(tabs.last()).toBeInViewport();
      await expect(filter).toBeChecked();
      await expect(panel.getByRole("group", { name: "Код поставщика" })).toHaveCount(0);
      await expect(panel).toHaveAttribute(
        "id",
        (await tabs.last().getAttribute("aria-controls")) ?? "",
      );
      await panel.getByRole("radio", { name: "Название товара — Сейчас в Markiro" }).click();
      await expect(tabs.last()).toHaveAccessibleName(/Требует выбора/);
      await expect(page.getByRole("button", { name: "Применить выбранное" })).toBeDisabled();
      await tabs.last().focus();
      await page.keyboard.press("Home");
      await expect(tabs.first()).toBeFocused();
      await expect(
        panel.getByRole("radio", { name: "Название для печати — Сейчас в Markiro" }),
      ).toBeChecked();
      await expect(panel.getByRole("radio", { name: "Без фото", exact: true })).toBeChecked();
      await filter.uncheck();
      await expect(panel.getByRole("group", { name: "Код поставщика" })).toBeVisible();
      await tabs.first().press("End");
      await panel.getByRole("radio", { name: "Название товара — Предлагаемое значение" }).click();
      await tabs.last().press("Home");
      await page.getByRole("button", { name: "Следующий товар", exact: true }).click();
      await expect(tabs.nth(1)).toHaveAttribute("aria-selected", "true");
      await page.getByRole("button", { name: "Предыдущий товар", exact: true }).click();
      await expect(tabs.first()).toHaveAttribute("aria-selected", "true");
      const strip = page.getByRole("tablist", { name: "Товары для проверки" });
      expect(
        await strip.evaluate((el) => {
          const tabs = Array.from(el.children).map((child) => child.getBoundingClientRect());
          return {
            oneRow: tabs.every((box) => Math.abs(box.top - (tabs[0]?.top ?? 0)) < 1),
            bounded: el.clientWidth <= innerWidth,
            scrolls: el.scrollWidth > el.clientWidth,
          };
        }),
      ).toEqual({ oneRow: true, bounded: true, scrolls: count > 2 || width === 390 });
      expect(
        await page.getByRole("dialog").evaluate((el) => el.scrollWidth <= el.clientWidth + 1),
      ).toBe(true);
      for (const row of await panel.locator("fieldset.mk-nc-comparison-row").all()) {
        const [left, right] = await row.locator(".mk-radio-card").evaluateAll((cells) =>
          cells.map((el) => {
            const box = el.getBoundingClientRect();
            return { top: box.top, left: box.left, right: box.right };
          }),
        );
        expect(left?.top).toBe(right?.top);
        expect(left?.right).toBeLessThan(right?.left ?? 0);
      }
      if (process.env.NC_UPDATE_SCREENSHOTS === "1" && count !== 100) {
        const folder = resolve(
          "../../docs/evidence/national-catalog-import/review-tabs-2026-09-10",
        );
        await mkdir(folder, { recursive: true });
        // Interactions and responsive bounds run at 1100px; expand only for
        // an evidence image that includes this product and the batch footer.
        await page.setViewportSize({ width, height: width === 390 ? 2000 : 1600 });
        await page
          .getByRole("heading", { name: "Проверка товаров", exact: true })
          .scrollIntoViewIfNeeded();
        await page.screenshot({
          path: resolve(folder, `review-${count}-products-${width}-ru-${theme}.png`),
          fullPage: true,
          animations: "disabled",
        });
        if (count === 5 && width === 1280) {
          await filter.check();
          await expect(panel.getByRole("group", { name: "Код поставщика" })).toHaveCount(0);
          await page.screenshot({
            path: resolve(folder, "review-5-products-1280-ru-light-mapped-only.png"),
            fullPage: true,
            animations: "disabled",
          });
        }
      }
      await page.getByRole("button", { name: "Применить выбранное" }).click();
      await expect(page.getByText("Товар добавлен. Фото не загрузилось.")).toBeVisible();
      expect(writes).toHaveLength(1);
      expect(writes[0]?.decisions).toHaveLength(count);
      expect(writes[0]?.decisions[0]).toEqual({
        previewId: id(1000),
        acceptedEntryIds: [id(3000), id(7000), id(8000)],
        linkAction: "attach",
        photo: { kind: "keep" },
      });
      expect(writes[0]?.decisions.at(-1)).toEqual({
        previewId: id(999 + count),
        acceptedEntryIds: [id(2999 + count), id(3999 + count), id(6999 + count), id(7999 + count)],
        linkAction: "attach",
        photo: { kind: "candidate", candidateId: id(4999 + count) },
      });
      expect(errors).toEqual([]);
    });
  }
}
