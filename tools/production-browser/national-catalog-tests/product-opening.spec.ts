import { expect, test } from "@playwright/test";
import { createHash } from "node:crypto";
import {
  capabilitiesFixture,
  id,
  photoFixtureBase64,
  productFixture,
  resultFixture,
  sessionFixture,
} from "../../../apps/admin/test/national-catalog-fixtures.js";

for (const width of [390, 1280]) {
  test(`opens the imported product with a decoded photo and its group on the first visit at ${width}px`, async ({
    page,
  }) => {
    const result = structuredClone(resultFixture);
    result.state = "running";
    result.items = result.items.map((item) => ({
      ...item,
      image: "pending",
      imageReason: null,
      reason: null,
    }));
    const photo = Buffer.from(photoFixtureBase64, "base64");
    const product = {
      ...productFixture,
      id: id(21),
      chzProductGroupCode: 8,
      productGroup: "Молочная продукция",
    };
    const image = {
      checksum: createHash("sha256").update(photo).digest("hex"),
      contentType: "image/webp",
      byteSize: photo.length,
      width: 120,
      height: 120,
      updatedAt: "2026-09-10T00:00:00.000Z",
    };
    let releaseRefresh: (() => void) | undefined;
    const refresh = new Promise<void>((resolve) => {
      releaseRefresh = resolve;
    });
    const errors: string[] = [];
    let photoApplied = false;
    let catalogRead = false;
    page.on("pageerror", (error) => errors.push(error.message));
    await page.setViewportSize({ width, height: 900 });
    await page.route("http://127.0.0.1:43183/api/**", async (route) => {
      const path = new URL(route.request().url()).pathname;
      if (route.request().method() !== "GET") throw new Error(`Unexpected write: ${path}`);
      if (path === `/api/products/${product.id}/image/${image.checksum}`) {
        await route.fulfill({ contentType: "image/webp", body: photo });
        return;
      }
      let body: unknown;
      if (path === "/api/access/me")
        body = { roles: ["manager"], capabilities: ["operations.read", "operations.write"] };
      else if (path === "/api/profile")
        body = { firstName: "Игорь", middleName: null, lastName: "Волков", hasAvatar: false };
      else if (path === "/api/products") {
        catalogRead = true;
        if (photoApplied) await refresh;
        body = { items: [{ ...product, ...(photoApplied ? { image } : {}) }] };
      } else if (["/api/counterparties", "/api/pickup-orders"].includes(path)) body = { items: [] };
      else if (path === "/api/chz-product-groups")
        body = { items: [{ code: 8, alias: "milk", name: "Молочная продукция" }] };
      else if (path.endsWith("/capabilities")) body = capabilitiesFixture;
      else if (path.includes("/applies/")) body = result;
      else if (path.includes("/import-sessions/")) body = sessionFixture;
      else throw new Error(`Unexpected request: ${path}`);
      await route.fulfill({ json: body });
    });
    const route = `/catalog/import?sessionId=${id(1)}&operationId=${id(20)}`;
    await page.goto(
      `/test/browser/national-catalog-harness.html?route=${encodeURIComponent(route)}`,
    );
    const open = page.getByRole("button", { name: "Открыть товар в каталоге" });
    await expect(open).toBeDisabled();
    await expect(page.getByText("Сохраняем фото.", { exact: false })).toBeVisible();
    await expect.poll(() => catalogRead).toBe(true);

    photoApplied = true;
    result.state = "finished";
    result.items = result.items.map((item) => ({ ...item, image: "applied" }));
    await expect(open).toBeEnabled();
    await open.click();
    await expect(open).toBeDisabled();
    await expect(page.getByRole("dialog", { name: "Изменить продукт" })).toHaveCount(0);
    releaseRefresh?.();

    const dialog = page.getByRole("dialog", { name: "Изменить продукт" });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole("combobox", { name: "Группа продукции" })).toContainText(
      "Молочная продукция",
    );
    const importedPhoto = dialog.getByRole("img", { name: product.name, exact: true });
    await importedPhoto.scrollIntoViewIfNeeded();
    await expect(importedPhoto).toBeVisible();
    await expect(importedPhoto).toHaveJSProperty("complete", true);
    await expect(importedPhoto).toHaveJSProperty("naturalWidth", 120);
    await expect(importedPhoto).toHaveJSProperty("naturalHeight", 120);
    expect(errors).toEqual([]);
  });
}
