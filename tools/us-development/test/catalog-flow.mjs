import assert from "node:assert/strict";
import { join } from "node:path";
import { exerciseUsProductProfile } from "./product-profile-flow.mjs";

// Runs after real MFA in the existing disposable US fixture. No synthetic API responses.
export async function exerciseUsCatalog({ page, expect, screenshots, fixture }) {
  await page.getByRole("button", { name: "Open reference data", exact: true }).click();
  await page.getByRole("button", { name: "Products", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Products", exact: true })).toBeVisible();
  await expect(page.getByText("No products match these filters.", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Add product", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog
    .getByLabel("Product name", { exact: true })
    .pressSequentially("Fresh-Cut Apple Snack Cups");
  await expect(dialog.getByLabel("Product name", { exact: true })).toBeFocused();
  for (let index = 0; index < 8; index += 1) {
    await page.keyboard.press("Tab");
    assert.equal(
      await dialog.evaluate((element) => element.contains(globalThis.document.activeElement)),
      true,
    );
  }
  const created = page.waitForResponse(
    (response) =>
      response.url().endsWith("/catalog/products") && response.request().method() === "POST",
  );
  void created.catch(() => {});
  await dialog.getByRole("button", { name: "Save product", exact: true }).click();
  const response = await created;
  assert.equal(response.status(), 201);
  const product = await response.json();
  assert.equal(product.gtin14, null);
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Products", exact: true })).toBeFocused();
  await expect(page.getByRole("button", { name: product.name, exact: true })).toBeVisible();
  await expect(page.getByText("No GTIN", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: product.name, exact: true }).click();
  await dialog.getByRole("button", { name: "Edit product", exact: true }).click();
  await expect(dialog.getByRole("button", { name: "Save product", exact: true })).toBeDisabled();
  await dialog.getByLabel("GTIN (optional)", { exact: true }).fill("123");
  await dialog.getByRole("button", { name: "Save product", exact: true }).click();
  await expect(dialog.getByRole("alert")).toBeFocused();
  await expect(dialog.getByLabel("GTIN (optional)", { exact: true })).toHaveAttribute(
    "aria-invalid",
    "true",
  );
  await dialog.getByLabel("GTIN (optional)", { exact: true }).fill("4006381333931");
  const edited = page.waitForResponse(
    (item) =>
      item.url().endsWith(`/catalog/products/${product.id}`) && item.request().method() === "PATCH",
  );
  void edited.catch(() => {});
  await dialog.getByRole("button", { name: "Save product", exact: true }).click();
  const editResponse = await edited;
  assert.equal(editResponse.status(), 200);
  assert.deepEqual(editResponse.request().postDataJSON(), { gtin: "4006381333931" });
  assert.equal((await editResponse.json()).gtin14, "04006381333931");
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Products", exact: true })).toBeFocused();

  await page.getByRole("button", { name: "Add product", exact: true }).click();
  await dialog.getByLabel("Product name", { exact: true }).fill("Fresh-Cut Apple Slices");
  await dialog.getByLabel("GTIN (optional)", { exact: true }).fill("4006381333931");
  await dialog.getByRole("button", { name: "Save product", exact: true }).click();
  await expect(dialog.getByRole("alert")).toHaveText(/already used by an active product/);
  await expect(dialog.getByLabel("Product name", { exact: true })).toHaveValue(
    "Fresh-Cut Apple Slices",
  );
  await dialog.getByLabel("GTIN (optional)", { exact: true }).clear();
  await dialog.getByRole("button", { name: "Save product", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Fresh-Cut Apple Slices", exact: true }),
  ).toBeVisible();

  for (const locale of ["en", "es"]) {
    if (locale === "es") await page.getByRole("button", { name: "Language", exact: true }).click();
    await expect(page.locator("html")).toHaveAttribute("lang", `${locale}-US`);
    await expect(
      page.getByRole("heading", { name: locale === "en" ? "Products" : "Productos", exact: true }),
    ).toBeVisible();
    for (const theme of ["light", "dark"]) {
      if (theme === "dark")
        await page
          .getByRole("button", {
            name: locale === "en" ? "Change theme" : "Cambiar tema",
            exact: true,
          })
          .click();
      await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
      for (const width of [1440, 1024, 390]) {
        await page.setViewportSize({ width, height: 900 });
        await expect
          .poll(() =>
            page.evaluate(
              () => globalThis.document.documentElement.scrollWidth <= globalThis.innerWidth,
            ),
          )
          .toBe(true);
        await page.evaluate(() => globalThis.document.fonts.ready);
        await page.screenshot({
          path: join(screenshots, `catalog-${locale}-${theme}-${width}.png`),
          fullPage: true,
          animations: "disabled",
        });
      }
    }
    await page
      .getByRole("button", { name: locale === "en" ? "Change theme" : "Cambiar tema", exact: true })
      .click();
  }
  await page.getByRole("button", { name: "Idioma", exact: true }).click();
  await page.setViewportSize({ width: 1440, height: 900 });

  for (const archived of [true, false]) {
    await page.getByRole("button", { name: product.name, exact: true }).click();
    const changed = page.waitForResponse(
      (item) =>
        item.url().endsWith(`/catalog/products/${product.id}`) &&
        item.request().method() === "PATCH",
    );
    void changed.catch(() => {});
    page.once("dialog", (confirmation) => confirmation.accept());
    await dialog
      .getByRole("button", { name: archived ? "Archive product" : "Restore product", exact: true })
      .click();
    const changedResponse = await changed;
    assert.equal(changedResponse.status(), 200);
    assert.deepEqual(changedResponse.request().postDataJSON(), { archived });
    assert.equal((await changedResponse.json()).id, product.id);
    await expect(dialog).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "Products", exact: true })).toBeFocused();
    await expect(page.getByRole("button", { name: product.name, exact: true })).toHaveCount(0);
    await page.getByLabel("Status", { exact: true }).selectOption(archived ? "true" : "false");
    await expect(page.getByRole("button", { name: product.name, exact: true })).toBeVisible();
  }
  const audits = await fixture.pool.query(
    "SELECT actor_user_id, action, outcome, target_type, target_id, request_id FROM tenant_audit_events WHERE organization_id = $1 AND target_id = $2 ORDER BY created_at, id",
    [fixture.tenantId, product.id],
  );
  assert.deepEqual(
    audits.rows.map((row) => row.action),
    [
      "traceability.product.created",
      "traceability.product.updated",
      "traceability.product.archived",
      "traceability.product.restored",
    ],
  );
  for (const row of audits.rows) {
    assert.equal(row.actor_user_id, fixture.userId);
    assert.equal(row.target_id, product.id);
    assert.equal(row.target_type, "traceability_product");
    assert.equal(row.outcome, "success");
    assert.match(row.request_id, /^[0-9a-f-]{36}$/);
  }

  await exerciseUsProductProfile({ page, expect, screenshots, fixture, product });
  await page.getByRole("button", { name: "← Profile", exact: true }).click();
  await fixture.pool.query(
    "UPDATE member SET role = $1 WHERE organization_id = $2 AND user_id = $3",
    ["traceability_auditor", fixture.tenantId, fixture.userId],
  );
  try {
    await page.getByRole("button", { name: "Open reference data", exact: true }).click();
    await page.getByRole("button", { name: "Products", exact: true }).click();
    await page.getByRole("button", { name: product.name, exact: true }).click();
    await expect(dialog.getByText("04006381333931", { exact: true })).toBeVisible();
    await expect(
      page.getByRole("button", { name: /^(Add|Edit|Archive|Restore) product$/ }),
    ).toHaveCount(0);
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(
      dialog.getByRole("button", { name: "Close product details", exact: true }),
    ).toBeInViewport();
    await expect
      .poll(async () => {
        const box = await dialog.boundingBox();
        return box !== null && box.x >= 0 && box.x + box.width <= 391;
      })
      .toBe(true);
    await expect
      .poll(() => dialog.evaluate((element) => element.scrollWidth <= element.clientWidth))
      .toBe(true);
    await page.screenshot({
      path: join(screenshots, "catalog-auditor-mobile.png"),
      fullPage: true,
      animations: "disabled",
    });
    await page.getByRole("button", { name: "Traceability profile", exact: true }).click();
    await expect(page.getByLabel("Brand", { exact: true })).toHaveValue("North River Fresh Foods");
    await expect(page.getByLabel("Brand", { exact: true })).toBeDisabled();
    await expect(page.getByLabel("Coverage", { exact: true })).toBeDisabled();
    await expect(page.getByRole("button", { name: "Save profile", exact: true })).toHaveCount(0);
    await page.screenshot({
      path: join(screenshots, "product-profile-auditor-mobile.png"),
      fullPage: true,
      animations: "disabled",
    });
    await page.getByRole("button", { name: "← Back to products", exact: true }).click();
    await page.getByRole("button", { name: "← Profile", exact: true }).click();
  } finally {
    await fixture.pool.query(
      "UPDATE member SET role = $1 WHERE organization_id = $2 AND user_id = $3",
      ["owner", fixture.tenantId, fixture.userId],
    );
    await page.setViewportSize({ width: 1440, height: 900 });
  }
}
