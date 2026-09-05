import assert from "node:assert/strict";
import { join } from "node:path";

// Called after catalog creation and real MFA, against the disposable US database.
export async function exerciseUsProductProfile({ page, expect, screenshots, fixture, product }) {
  await page.getByRole("button", { name: product.name, exact: true }).click();
  await page.getByRole("button", { name: "Traceability profile", exact: true }).click();
  await expect(page.getByLabel("Product name", { exact: true })).toHaveValue(product.name);
  assert.equal(
    (
      await fixture.pool.query(
        "SELECT count(*)::int AS count FROM product_traceability_profiles WHERE tenant_id = $1 AND product_id = $2",
        [fixture.tenantId, product.id],
      )
    ).rows[0].count,
    0,
  );
  await page.getByLabel("Coverage", { exact: true }).selectOption("covered");
  await page.getByRole("button", { name: "Save profile", exact: true }).click();
  await expect(page.getByRole("alert")).toBeFocused();
  await expect(page.getByLabel("Review rationale", { exact: true })).toHaveAttribute(
    "aria-invalid",
    "true",
  );
  await page.getByLabel("Brand", { exact: true }).pressSequentially("North River");
  await expect(page.getByLabel("Brand", { exact: true })).toBeFocused();
  await page.getByRole("button", { name: "Language", exact: true }).click();
  await page.getByRole("button", { name: "Cambiar tema", exact: true }).click();
  await expect(page.getByLabel("Marca", { exact: true })).toHaveValue("North River");
  await expect(page.getByLabel("Cobertura", { exact: true })).toHaveValue("covered");
  await page.getByRole("button", { name: "Cambiar tema", exact: true }).click();
  await page.getByRole("button", { name: "Idioma", exact: true }).click();
  await page.getByLabel("Commodity", { exact: true }).fill("Apples");
  await page.getByLabel("Variety", { exact: true }).fill("Red Delicious");
  await page.getByLabel("Pack size", { exact: true }).fill("6.125");
  await page.getByLabel("Pack size unit", { exact: true }).selectOption("oz");
  await page.getByLabel("Packaging style", { exact: true }).fill("Cup");
  await page.getByLabel("Default quantity unit", { exact: true }).selectOption("case");
  await page
    .getByLabel("Review rationale", { exact: true })
    .fill("Synthetic example: fresh-cut apple cups retain the fresh-cut fruit form.");
  await page.getByLabel("FTL category", { exact: true }).fill("Fruits (fresh-cut)");
  await page
    .getByLabel("Source URL", { exact: true })
    .fill("https://example.com/synthetic-ftl-source");
  await page.getByLabel("Source version", { exact: true }).fill("SYNTHETIC-REVIEW-01");
  const savedResponse = page.waitForResponse(
    (response) =>
      response.url().endsWith(`/traceability/products/${product.id}`) &&
      response.request().method() === "PUT",
  );
  void savedResponse.catch(() => {});
  await page.getByRole("button", { name: "Save profile", exact: true }).click();
  const response = await savedResponse;
  assert.equal(response.status(), 200);
  const saved = await response.json();
  assert.equal(saved.revision, 1);
  assert.equal(saved.packagingSizeValue, "6.125");
  assert.equal(saved.reviewedBy, fixture.userId);
  await expect(page.getByText("Profile saved.", { exact: true })).toBeFocused();
  await expect(page.getByRole("button", { name: "Save profile", exact: true })).toBeDisabled();

  for (const locale of ["en", "es"]) {
    if (locale === "es") await page.getByRole("button", { name: "Language", exact: true }).click();
    for (const theme of ["light", "dark"]) {
      if (theme === "dark")
        await page
          .getByRole("button", {
            name: locale === "en" ? "Change theme" : "Cambiar tema",
            exact: true,
          })
          .click();
      for (const width of [1440, 1024, 390]) {
        await page.setViewportSize({ width, height: 900 });
        await expect
          .poll(() =>
            page.evaluate(
              () => globalThis.document.documentElement.scrollWidth <= globalThis.innerWidth,
            ),
          )
          .toBe(true);
        const save = page.getByRole("button", {
          name: locale === "en" ? "Save profile" : "Guardar perfil",
          exact: true,
        });
        await expect(save).toBeInViewport();
        await page.evaluate(async () => {
          await globalThis.document.fonts.ready;
          globalThis.scrollTo(0, globalThis.document.documentElement.scrollHeight);
        });
        await page.screenshot({
          path: join(screenshots, `product-profile-${locale}-${theme}-${width}.png`),
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

  // A separate authorized request advances the revision while the browser keeps its draft.
  const editable = response.request().postDataJSON();
  const concurrent = await page.request.put(
    `http://localhost:5174/api/us/traceability/products/${product.id}`,
    {
      headers: { Origin: "http://localhost:5174" },
      data: { ...editable, brandName: "North River Fresh Foods", expectedRevision: saved.revision },
    },
  );
  assert.equal(concurrent.status(), 200);
  await page.getByLabel("Brand", { exact: true }).fill("Conflicting unsaved draft");
  await page.getByRole("button", { name: "Save profile", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("changed since you opened it");
  await expect(page.getByLabel("Brand", { exact: true })).toHaveValue("Conflicting unsaved draft");
  await expect(page.getByRole("button", { name: "Save profile", exact: true })).toBeDisabled();
  page.once("dialog", (dialog) => dialog.dismiss());
  await page.getByRole("button", { name: "Load latest profile", exact: true }).click();
  await expect(page.getByLabel("Brand", { exact: true })).toHaveValue("Conflicting unsaved draft");
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Load latest profile", exact: true }).click();
  await expect(page.getByLabel("Brand", { exact: true })).toHaveValue("North River Fresh Foods");
  await expect(page.getByText("Saved revision 2", { exact: true })).toBeVisible();
  await page
    .getByRole("heading", { name: "Coverage review", exact: true })
    .evaluate((element) => element.scrollIntoView({ block: "start" }));
  await page.screenshot({
    path: join(screenshots, "product-profile-review-desktop.png"),
    animations: "disabled",
  });
  const rows = await fixture.pool.query(
    "SELECT actor_user_id, action, target_id, outcome, request_id FROM tenant_audit_events WHERE organization_id = $1 AND target_type = 'traceability_product_profile' AND target_id = $2",
    [fixture.tenantId, product.id],
  );
  assert.deepEqual(rows.rows.map((row) => row.action).sort(), [
    "traceability.product_profile.coverage_changed",
    "traceability.product_profile.updated",
    "traceability.product_profile.updated",
  ]);
  for (const row of rows.rows) {
    assert.equal(row.actor_user_id, fixture.userId);
    assert.equal(row.target_id, product.id);
    assert.equal(row.outcome, "success");
    assert.match(row.request_id, /^[0-9a-f-]{36}$/);
  }
  await page.getByRole("button", { name: "← Back to products", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Products", exact: true })).toBeFocused();
}
