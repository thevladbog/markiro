import assert from "node:assert/strict";
import { expectUsBrand } from "./brand-flow.mjs";
import { join } from "node:path";

/** Real browser + US API + disposable Postgres; no mocked business responses. */
export async function exerciseUsLots({ page, expect, screenshots, fixture }) {
  await page.getByRole("button", { name: "Open reference data", exact: true }).click();
  await page.getByRole("button", { name: "Lots", exact: true }).click();
  await expect(page.getByText("No lots match these filters.", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Add imported lot", exact: true }).click();
  await page
    .getByLabel("Product", { exact: true })
    .selectOption({ label: "Fresh-Cut Apple Slices" });
  await page.getByLabel("Lot code (TLC)", { exact: true }).fill("  =Supplier-🍎  ");
  const created = page.waitForResponse(
    (r) => r.url().endsWith("/traceability/lots") && r.request().method() === "POST",
  );
  void created.catch(() => {});
  await page.getByRole("button", { name: "Save lot", exact: true }).click();
  const response = await created;
  assert.equal(response.status(), 201);
  const lot = await response.json();
  assert.equal(lot.tlc, "=Supplier-🍎");
  assert.equal(lot.source, null);
  assert.equal(lot.revision, 1);
  await expect(page.getByRole("heading", { name: lot.tlc, exact: true })).toBeFocused();

  await page.getByRole("button", { name: "Correct source", exact: true }).click();
  await page.getByLabel("Source type", { exact: true }).selectOption("reference");
  await page
    .getByLabel("Source reference URL", { exact: true })
    .fill("https://supplier.example.test/LotCase");
  const locations = await page.request.get(
    "http://localhost:5174/api/us/traceability/locations?archived=false&limit=50&offset=0",
  );
  assert.equal(locations.status(), 200);
  const sourceLocation = (await locations.json()).items[0];
  assert.ok(sourceLocation);
  await page
    .getByLabel("Resolved source location", { exact: true })
    .selectOption(sourceLocation.id);
  await page.getByLabel("Reason", { exact: true }).fill("Confirmed the supplier source record");
  await page.getByRole("button", { name: "Language", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "Motivo", exact: true })).toHaveValue(
    "Confirmed the supplier source record",
  );
  await page.screenshot({
    path: join(screenshots, "lot-source-es.png"),
    fullPage: true,
    animations: "disabled",
  });
  await page.getByRole("button", { name: "Idioma", exact: true }).click();
  const corrected = page.waitForResponse(
    (r) => r.url().endsWith(`/lots/${lot.id}/source`) && r.request().method() === "PATCH",
  );
  void corrected.catch(() => {});
  await page.getByRole("button", { name: "Save source correction", exact: true }).click();
  const correctedResponse = await corrected;
  assert.equal(correctedResponse.status(), 200);
  const afterSource = await correctedResponse.json();
  assert.deepEqual(
    {
      id: afterSource.id,
      tlc: afterSource.tlc,
      productId: afterSource.productId,
      revision: afterSource.revision,
    },
    { id: lot.id, tlc: lot.tlc, productId: lot.productId, revision: 2 },
  );
  await expect(page.getByRole("heading", { name: lot.tlc, exact: true })).toBeFocused();
  await page.getByRole("button", { name: "Change status", exact: true }).click();
  await page.getByLabel("New status", { exact: true }).selectOption("quarantined");
  await page.getByLabel("Reason", { exact: true }).fill("Hold pending quality review");
  const changed = page.waitForResponse(
    (r) => r.url().endsWith(`/lots/${lot.id}/status`) && r.request().method() === "POST",
  );
  void changed.catch(() => {});
  await page.getByRole("button", { name: "Save status change", exact: true }).click();
  const changedResponse = await changed;
  assert.equal(changedResponse.status(), 200);
  const afterStatus = await changedResponse.json();
  assert.equal(afterStatus.status, "quarantined");
  assert.equal(afterStatus.revision, 3);
  await expect(page.getByRole("heading", { name: lot.tlc, exact: true })).toBeFocused();

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
      await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
      for (const width of [1440, 1024, 390]) {
        await page.setViewportSize({ width, height: 900 });
        await expectUsBrand({ page, expect });
        await expect
          .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
          .toBe(true);
        await page.evaluate(() => document.fonts.ready);
        await page.screenshot({
          path: join(screenshots, `lot-detail-${locale}-${theme}-${width}.png`),
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
  await page.getByRole("button", { name: "← Back to lots", exact: true }).click();
  await page.getByLabel("Status", { exact: true }).selectOption("quarantined");
  await expect(page.getByRole("button", { name: lot.tlc, exact: true })).toBeVisible();
  await page.screenshot({
    path: join(screenshots, "lots-registry-en.png"),
    fullPage: true,
    animations: "disabled",
  });

  const audits = await fixture.pool.query(
    'SELECT organization_id, actor_user_id, action, outcome, target_type, target_id, "before", "after" FROM tenant_audit_events WHERE organization_id = $1 AND target_id = $2 ORDER BY created_at, id',
    [fixture.tenantId, lot.id],
  );
  assert.deepEqual(
    audits.rows.map((row) => row.action),
    [
      "traceability.lot.created",
      "traceability.lot.source_changed",
      "traceability.lot.status_changed",
    ],
  );
  for (const row of audits.rows) {
    assert.equal(row.organization_id, fixture.tenantId);
    assert.equal(row.actor_user_id, fixture.userId);
    assert.equal(row.outcome, "success");
    assert.equal(row.target_type, "traceability_lot");
    assert.equal(row.target_id, lot.id);
  }
  assert.equal(audits.rows[0].before, null);
  assert.deepEqual(audits.rows[0].after, lot);
  assert.deepEqual(audits.rows[1].before, lot);
  assert.deepEqual(audits.rows[1].after, {
    ...afterSource,
    reason: "Confirmed the supplier source record",
  });
  assert.deepEqual(audits.rows[2].before, afterSource);
  assert.deepEqual(audits.rows[2].after, { ...afterStatus, reason: "Hold pending quality review" });
  await page.getByRole("button", { name: "← Profile", exact: true }).click();
}
