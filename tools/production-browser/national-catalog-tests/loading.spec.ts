import { expect, test } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { importSelectionSchema } from "../../../packages/platform-contracts/dist/index.js";
import {
  capabilitiesFixture,
  itemsFixture,
  previewFixture,
  sessionFixture,
} from "../../../apps/admin/test/national-catalog-fixtures.js";

// Deliberately different from the Russian interface selected by the harness.
test.use({ locale: "en-US", timezoneId: "Europe/Moscow" });

for (const width of [390, 720, 1280]) {
  for (const theme of ["light", "dark"]) {
    test(`loads and compares without reloading with spaced controls at ${width}px in ${theme}`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 1000 });
      await page.addInitScript(() => {
        // A visible page can lose window focus while the signer or another app is open.
        document.hasFocus = () => false;
      });
      let discovered = false;
      let prepared = false;
      let selectionRefreshStarted = false;
      let releaseSelectionRefresh: (() => void) | undefined;
      const selectionRefresh = new Promise<void>((resolve) => {
        releaseSelectionRefresh = resolve;
      });
      let session = { ...sessionFixture, state: "loading", automaticWorkPending: true, loaded: 0 };
      const item = {
        ...itemsFixture.items[0]!,
        name: "Сидр традиционный нефильтрованный полусладкий «Зимняя история»",
        brand: "A WINTER CAROL",
      };
      const unexpected: string[] = [];
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.route("http://127.0.0.1:43183/api/**", async (route) => {
        const path = new URL(route.request().url()).pathname;
        let body: unknown;
        if (path === "/api/access/me")
          body = { roles: ["manager"], capabilities: ["operations.read", "operations.write"] };
        else if (path === "/api/profile")
          body = { firstName: "Игорь", middleName: null, lastName: "Волков", hasAvatar: false };
        else if (["/api/products", "/api/counterparties", "/api/pickup-orders"].includes(path))
          body = { items: [] };
        else if (path.endsWith("/capabilities")) body = capabilitiesFixture;
        else if (path.endsWith("/selection")) {
          const input = importSelectionSchema.parse(route.request().postDataJSON());
          session = {
            ...session,
            selectedItemIds: input.itemIds,
            selected: input.itemIds.length,
            revision: session.revision + 1,
          };
          body = session;
        } else if (path.endsWith("/items")) {
          if (session.selected > 0) {
            selectionRefreshStarted = true;
            await selectionRefresh;
          }
          body = { items: discovered ? [item] : [], nextCursor: null };
        } else if (path.endsWith("/previews") || path.includes("/preparations/"))
          body = prepared
            ? {
                ...previewFixture,
                items: previewFixture.items.map((preview) => ({
                  ...preview,
                  identity: { ...preview.identity, name: item.name },
                  fields: preview.fields.map((field) => ({ ...field, after: item.name })),
                  photos: [],
                })),
              }
            : {
                ...previewFixture,
                preparation: {
                  ...previewFixture.preparation,
                  state: "loading",
                  completed: 0,
                  automaticWorkPending: true,
                },
                items: [],
              };
        else if (path.includes("/import-sessions")) body = session;
        else {
          unexpected.push(path);
          await route.abort();
          return;
        }
        await route.fulfill({ contentType: "application/json", body: JSON.stringify(body) });
      });
      await page.goto("/test/browser/national-catalog-harness.html?route=%2Fcatalog%2Fimport");
      await page.evaluate(
        (value) => document.documentElement.setAttribute("data-theme", value),
        theme,
      );
      if (width === 390) {
        await page.getByLabel("Список GTIN").fill("04006381333931");
        await page.getByRole("button", { name: "Найти по GTIN" }).click();
      } else await page.getByRole("button", { name: "Загрузить мои товары" }).click();

      const dialog = page.getByRole("dialog", { name: "Национальный каталог" });
      await expect(
        dialog.getByRole("status", { name: "Загружаем товары из Национального каталога" }),
      ).toBeVisible();
      await expect(dialog.getByText("No data")).toHaveCount(0);
      await expect(dialog.locator("time")).toHaveText("09.09.2026, 03:00");
      const screenshot = async (step: string) => {
        if (process.env.NC_UI_EVIDENCE_DIR) {
          await mkdir(process.env.NC_UI_EVIDENCE_DIR, { recursive: true });
          await page.screenshot({
            path: resolve(process.env.NC_UI_EVIDENCE_DIR, `${step}-${width}-${theme}.png`),
          });
        }
      };
      await screenshot("loading");
      discovered = true;
      session = {
        ...session,
        state: "ready",
        loaded: 1,
        revision: 1,
        complete: true,
        automaticWorkPending: false,
      };
      const checkbox = dialog.getByRole("checkbox", { name: /04006381333931/ });
      await expect(checkbox).toBeVisible();
      await expect(
        dialog.getByRole("status", { name: "Загружаем товары из Национального каталога" }),
      ).toHaveCount(0);
      const layout = await dialog.evaluate((element) => {
        const filters = element.querySelector(".mk-nc-filters")!;
        const [search, status] = Array.from(filters.children).map((child) =>
          child.getBoundingClientRect(),
        );
        const nav = element.querySelector("nav")!.getBoundingClientRect();
        const section = element.querySelector(".mk-nc-section-heading")!.getBoundingClientRect();
        return {
          gap:
            status!.top > search!.bottom
              ? status!.top - search!.bottom
              : status!.left - search!.right,
          navGap: section.top - nav.bottom,
          overflow: element.scrollWidth - element.clientWidth,
        };
      });
      expect(layout.gap).toBeGreaterThanOrEqual(12);
      expect(layout.navGap).toBeGreaterThanOrEqual(16);
      expect(layout.navGap).toBeLessThanOrEqual(32);
      expect(layout.overflow).toBeLessThanOrEqual(1);
      await screenshot("selection");
      await checkbox.scrollIntoViewIfNeeded();
      const checkboxBefore = await checkbox.boundingBox();
      try {
        await checkbox.click();
        await expect.poll(() => selectionRefreshStarted).toBe(true);
        await expect(checkbox).toBeChecked();
        await expect(
          dialog.getByRole("status", { name: "Загружаем товары из Национального каталога" }),
        ).toHaveCount(0);
        const checkboxAfter = await checkbox.boundingBox();
        expect(checkboxAfter?.y).toBe(checkboxBefore?.y);
        await screenshot("selected");
      } finally {
        releaseSelectionRefresh?.();
      }
      await dialog.getByRole("button", { name: "Проверить выбранные товары" }).click();
      await expect(
        dialog.getByRole("status").filter({ hasText: "Готовим товары к проверке" }),
      ).toBeVisible();
      await expect(
        dialog.getByRole("button", { name: "Обновить данные для проверки" }),
      ).toHaveCount(0);
      await expect(dialog.getByLabel("Итог перед добавлением")).toHaveCount(0);
      await screenshot("preparing");
      prepared = true;
      await expect(dialog.getByLabel("Название вручную")).toBeVisible();
      await expect(
        dialog.getByRole("radio", { name: "Название товара — Предлагаемое значение" }),
      ).toBeVisible();
      await screenshot("comparison");
      expect(unexpected).toEqual([]);
      expect(errors).toEqual([]);
    });
  }
}
