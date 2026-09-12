import { expect, test } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import {
  importApplySchema,
  importPrepareResponseSchema,
} from "../../../packages/platform-contracts/dist/index.js";
import {
  capabilitiesFixture,
  id,
  photoFixtureBase64,
  previewFixture,
  productFixture,
  resultFixture,
  sessionFixture,
} from "../../../apps/admin/test/national-catalog-fixtures.js";

for (const width of [390, 1280]) {
  test(`selects comparison cells by value and keyboard at ${width}`, async ({ page }) => {
    const origin = "http://127.0.0.1:43183";
    const theme = width === 390 ? "dark" : "light";
    const product = {
      ...productFixture,
      name: "Молоко фермерское",
      image: {
        checksum: "a".repeat(64),
        contentType: "image/webp",
        byteSize: 472,
        width: 120,
        height: 120,
      },
    };
    const preparation = importPrepareResponseSchema.parse({
      ...previewFixture,
      items: [
        {
          ...previewFixture.items[0],
          productId: product.id,
          fields: [
            {
              ...previewFixture.items[0]!.fields[0],
              before: product.name,
              after: "Молоко пастеризованное 3,2 %",
            },
            {
              ...previewFixture.items[0]!.fields[0],
              id: id(40),
              labelKey: "category",
              label: "Категория",
              before: null,
              after: "Молочная продукция",
              selectedByDefault: true,
            },
            {
              id: id(41),
              label: "Жирность",
              before: "3,0 %",
              after: "3,2 %",
              source: "national_catalog",
              applicable: true,
              selectedByDefault: false,
              reason: null,
              requiresEntryIds: [id(40)],
            },
          ],
          photos: [
            {
              candidateId: id(30),
              previewPath: null,
              state: "ready",
              reason: null,
              primary: true,
              selectedByDefault: true,
            },
          ],
        },
      ],
    });
    const writes: ReturnType<typeof importApplySchema.parse>[] = [];
    const unexpected: string[] = [];
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.setViewportSize({ width, height: 1000 });
    await page.addInitScript((value) => localStorage.setItem("markiro.theme", value), theme);
    await page.route(`${origin}/api/**`, async (route) => {
      const path = new URL(route.request().url()).pathname;
      if (/\/images?\//.test(path)) {
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
      } else if (route.request().method() !== "GET") {
        unexpected.push(path);
        await route.abort();
        return;
      } else if (path === "/api/access/me")
        body = { roles: ["manager"], capabilities: ["operations.read", "operations.write"] };
      else if (path === "/api/profile")
        body = { firstName: "Игорь", middleName: null, lastName: "Волков", hasAvatar: false };
      else if (path === "/api/products") body = { items: [product] };
      else if (["/api/counterparties", "/api/pickup-orders"].includes(path)) body = { items: [] };
      else if (path.endsWith("/capabilities")) body = capabilitiesFixture;
      else if (path.includes("/preparations/")) body = preparation;
      else if (path.includes("/applies/")) body = resultFixture;
      else if (path.includes("/import-sessions/")) body = sessionFixture;
      else {
        unexpected.push(path);
        await route.abort();
        return;
      }
      await route.fulfill({ contentType: "application/json", body: JSON.stringify(body) });
    });
    const route = `/catalog/import?sessionId=${id(1)}&preparationId=${id(10)}`;
    await page.goto(
      `/test/browser/national-catalog-harness.html?locale=ru&route=${encodeURIComponent(route)}`,
    );
    const item = page.locator(".mk-nc-review-item");
    const current = item.getByRole("radio", {
      name: "Название товара — Сейчас в Markiro",
      exact: true,
    });
    const proposed = item.getByRole("radio", {
      name: "Название товара — Предлагаемое значение",
      exact: true,
    });
    await expect(current).toBeChecked();
    await current.focus();
    await page.keyboard.press("ArrowRight");
    await expect(proposed).toBeChecked();
    await expect(proposed).toBeFocused();
    await page.keyboard.press("ArrowLeft");
    await expect(current).toBeChecked();
    // Clicking the value text itself must select its entire cell.
    await item.getByText("Молоко пастеризованное 3,2 %", { exact: true }).click();
    await expect(proposed).toBeChecked();
    await item.getByText("Молоко фермерское", { exact: true }).click();
    const category = item.getByRole("radio", {
      name: "Категория — Предлагаемое значение",
      exact: true,
    });
    const fat = item.getByRole("radio", { name: "Жирность — Предлагаемое значение", exact: true });
    await expect(category).toBeChecked();
    await expect(fat).toBeEnabled();
    await expect(fat).not.toBeChecked();
    await fat.click();
    await item.getByRole("radio", { name: "Категория — Сейчас в Markiro", exact: true }).click();
    await expect(category).not.toBeChecked();
    await expect(fat).not.toBeChecked();
    await expect(fat).toBeDisabled();
    await category.click();
    await expect(fat).toBeEnabled();
    await expect(fat).not.toBeChecked();
    await fat.click();
    await expect(item.getByRole("img", { name: "Подготовленное фото товара" })).toHaveJSProperty(
      "naturalWidth",
      120,
    );
    await expect(item.getByRole("img", { name: "Текущее фото товара" })).toHaveJSProperty(
      "naturalWidth",
      120,
    );
    await item.getByRole("radio", { name: "Выбрать это фото" }).click();
    expect(writes).toHaveLength(0);
    const bounds = await item.locator("fieldset.mk-nc-comparison-row").evaluateAll((rows) =>
      rows.map((row) => {
        const boxes = Array.from(row.querySelectorAll(".mk-radio-card")).map((el) =>
          el.getBoundingClientRect(),
        );
        const [left, right] = boxes;
        if (!left || !right) throw Error("Missing comparison cell");
        return {
          sameTop: Math.abs(left.top - right.top) < 1,
          sameWidth: Math.abs(left.width - right.width) < 1,
          separated: left.right < right.left,
          within: left.left >= 0 && right.right <= innerWidth,
        };
      }),
    );
    expect(bounds).toEqual(
      Array.from({ length: 3 }, () => ({
        sameTop: true,
        sameWidth: true,
        separated: true,
        within: true,
      })),
    );
    expect(
      await page.getByRole("dialog").evaluate((el) => el.scrollWidth <= el.clientWidth + 1),
    ).toBe(true);
    if (process.env.NC_UPDATE_SCREENSHOTS === "1") {
      const folder = resolve(
        "../../docs/evidence/national-catalog-import/comparison-cells-2026-09-09",
      );
      await mkdir(folder, { recursive: true });
      // Capture the complete panel at an expanded height; interaction and bounds
      // above were already exercised at the normal 1000px viewport height.
      await page.setViewportSize({ width, height: width === 390 ? 1560 : 1280 });
      await page
        .getByRole("heading", { name: "Проверка товаров", exact: true })
        .scrollIntoViewIfNeeded();
      await page.screenshot({
        path: resolve(folder, `comparison-${width}-ru-${theme}.png`),
        fullPage: true,
        animations: "disabled",
      });
    }
    await page.getByRole("button", { name: "Применить выбранное", exact: true }).click();
    await expect(page.getByText("Товар добавлен. Фото не загрузилось.")).toBeVisible();
    expect(writes).toHaveLength(1);
    expect(writes[0]?.decisions).toEqual([
      {
        previewId: id(12),
        acceptedEntryIds: [id(40), id(41)],
        linkAction: "attach",
        photo: { kind: "candidate", candidateId: id(30) },
      },
    ]);
    expect(unexpected).toEqual([]);
    expect(errors).toEqual([]);
  });
}
