import { expect, test } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import {
  importApplySchema,
  importPrepareSchema,
  importSelectionSchema,
} from "../../../packages/platform-contracts/dist/index.js";
import {
  capabilitiesFixture,
  id,
  itemsFixture,
  previewFixture,
  resultFixture,
  sessionFixture,
} from "../../../apps/admin/test/national-catalog-fixtures.js";
const origin = "http://127.0.0.1:43183";
// MemoryRouter intentionally does not update the address bar. Reopen using ?route=.
const open = (route: string) =>
  `/test/browser/national-catalog-harness.html?route=${encodeURIComponent(route)}`;
test("cabinet selects, reviews, applies and reopens the saved result with strict fixtures", async ({
  page,
}) => {
  const unexpected: string[] = [];
  const errors: string[] = [];
  let session = { ...sessionFixture };
  let preparation = structuredClone(previewFixture);
  const writes: unknown[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.route(`${origin}/api/**`, async (route) => {
    const path = new URL(route.request().url()).pathname;
    let body: unknown;
    if (path.endsWith(`/images/${id(30)}`)) {
      await route.fulfill({
        status: 200,
        contentType: "image/webp",
        body: Buffer.from(
          "UklGRtABAABXRUJQVlA4IMQBAACwDgCdASp4AHgAPm00mEckIyKhKhWZGIANiWcA1OTATP+ynyjg57xAWK6mrhcvK4uEOEJOeKcf68ccMaTvrvXuFK8HkwkvF9qI/5W9qQ4ziV0yXsdpwU1bSgSqpLThYrtGfCUP38EDWeNBmTKxkvTNs3vUY9k5uqRyhulTZIAA/vo8Ly0lehcyDUOF0mwMucDqrz8TB1AUgnCSKYyf6i0GiEISFpEah96xvzuKxlWPHGXpVerx9h049ZZZUPNCdLytMBUXTtqsdj3X2LIBRkGcpqUkQy8BR4bu61Q74IBFl2Q5EXUhYbNGgbBgkEzFdc/LtBHm+BUm7Io8DqEleiFF9NXysIZN3jIIrTXSlzWFjlq+s6fH/N/pvNfIPpzCGS/Vj1Mv0cYT+9r/c6bIj3/5SCP7A/cK/TnU34NI4hdSeP2/BIZUH6C+4mX08y/yPUxTadyZ/XrAVm1T4991HgkUgl1U6XqYApaTXt0I36QmwJL+RJATyfb6HuWUYvrnZu8sxmNLJAMk7H5haduYgcEiP3XoD0mwifGsmMRplQEM0d1W9m/o/xhYy1r6K++Nl3ErUqob73rOCKf7gdQ+afmAAAAAAA==",
          "base64",
        ),
      });
      return;
    }
    if (path === "/api/access/me")
      body = { roles: ["manager"], capabilities: ["operations.read", "operations.write"] };
    else if (path === "/api/profile")
      body = { firstName: "Игорь", middleName: null, lastName: "Волков", hasAvatar: false };
    else if (["/api/products", "/api/counterparties", "/api/pickup-orders"].includes(path))
      body = { items: [] };
    else if (path === "/api/national-catalog/capabilities") body = capabilitiesFixture;
    else if (path.endsWith("/selection")) {
      const input = importSelectionSchema.parse(route.request().postDataJSON());
      session = {
        ...session,
        revision: session.revision + 1,
        selectedItemIds: input.itemIds,
        selected: input.itemIds.length,
      };
      body = session;
    } else if (path.endsWith("/items")) body = { ...itemsFixture, nextCursor: null };
    else if (path.endsWith("/previews")) {
      const input = importPrepareSchema.parse(route.request().postDataJSON());
      writes.push(input);
      preparation = {
        ...preparation,
        preparation: { ...preparation.preparation, requestId: input.requestId },
      };
      body = preparation;
    } else if (path.includes("/preparations/")) body = preparation;
    else if (path.endsWith("/applies")) {
      writes.push(importApplySchema.parse(route.request().postDataJSON()));
      body = resultFixture;
    } else if (path.includes("/applies/")) body = resultFixture;
    else if (path.includes("/import-sessions")) body = session;
    else {
      unexpected.push(path);
      await route.abort();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(body),
    });
  });
  await page.goto(open("/catalog"));
  await expect(page.getByRole("button", { name: "Добавить продукт" }).first()).toBeVisible();
  expect(unexpected).toEqual([]);
  await page.getByRole("button", { name: "Добавить из Национального каталога" }).click();
  await expect(page.getByRole("dialog", { name: "Национальный каталог" })).toBeVisible();
  await page.getByRole("button", { name: "Загрузить мои товары" }).click();
  await page.getByRole("checkbox", { name: /4006381333931/ }).click();
  await expect(page.getByText("Выбрано: 1 из 100")).toBeVisible();
  await page.getByRole("button", { name: "Сравнить выбранные товары" }).click();
  await expect(page.getByLabel("Название вручную")).toBeVisible();
  const evidence = resolve("../../docs/evidence/national-catalog-import");
  await mkdir(evidence, { recursive: true });
  await page.screenshot({ path: resolve(evidence, "task-12-review-1280.png"), fullPage: true });
  await page.getByRole("button", { name: "Добавить выбранные изменения" }).click();
  await expect(page.getByText("Товар добавлен. Фото не загрузилось.")).toBeVisible();
  expect(writes).toHaveLength(2);
  await page.goto(open(`/catalog/import?sessionId=${id(1)}&operationId=${id(20)}`));
  await page.reload();
  await expect(page.getByText("Товар добавлен. Фото не загрузилось.")).toBeVisible();
  expect(writes).toHaveLength(2);
  // Rich synthetic comparison: existing product, explicit initial category,
  // dependent attribute and cached normalized WebP. No provider media is used.
  const p = preparation.items[0];
  if (!p) throw Error("Missing review fixture");
  p.productId = id(21);
  p.linkAction = "replace";
  p.fields[0]!.before = "Молоко фермерское";
  p.categoryOptions = [{ optionId: id(40), label: "Молочная продукция", selected: true }];
  p.fields.push(
    {
      ...p.fields[0]!,
      id: id(41),
      label: "Категория",
      before: null,
      after: "Молочная продукция",
      requiresEntryIds: [],
    },
    {
      ...p.fields[0]!,
      id: id(42),
      label: "Жирность",
      before: null,
      after: "3,2 %",
      requiresEntryIds: [id(41)],
    },
  );
  p.photos = [
    {
      candidateId: id(30),
      state: "ready",
      previewPath: null,
      primary: true,
      selectedByDefault: false,
      reason: null,
    },
  ];
  await page.setViewportSize({ width: 1280, height: 1300 });
  await page.goto(open(`/catalog/import?sessionId=${id(1)}&preparationId=${id(10)}`));
  await expect(page.getByText("04006381333931 · Молоко")).toBeVisible();
  await page.getByRole("checkbox", { name: "Категория", exact: true }).click();
  await page.getByRole("checkbox", { name: "Жирность", exact: true }).click();
  await page.getByRole("checkbox", { name: /Подтверждаю замену/ }).click();
  await page.getByRole("button", { name: "Просмотреть фото" }).click();
  await expect(page.getByRole("img", { name: "Подготовленное фото товара" })).toHaveJSProperty(
    "naturalWidth",
    120,
  );
  await page.screenshot({
    path: resolve(evidence, "task-12-review-rich-1280.png"),
    fullPage: true,
  });
  await page.getByRole("button", { name: "Закрыть" }).focus();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(errors).toEqual([]);
  expect(unexpected).toEqual([]);
});
