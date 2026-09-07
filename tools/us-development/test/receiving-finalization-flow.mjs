import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { join } from "node:path";

/** Runs after the existing draft proof. Business responses remain real; only delivery can be lost. */
export async function exerciseUsReceivingFinalization({ page, expect, screenshots, fixture }) {
  const base = "http://localhost:5174/api/us/traceability";
  const tenant = fixture.tenantId,
    actor = fixture.userId;
  const party = randomUUID(),
    location = randomUUID(),
    product = randomUUID();
  await fixture.pool.query(
    "INSERT INTO traceability_parties (id,tenant_id,name) VALUES ($1,$2,'Finalization supplier')",
    [party, tenant],
  );
  await fixture.pool.query(
    "INSERT INTO traceability_locations (id,tenant_id,party_id,name,business_name,phone_number,street_address,city,state_or_region,zip_or_postal_code,country_code,roles) VALUES ($1,$2,$3,'Finalization dock','Frozen supplier farm','+1 509 555 0100','100 Test Way','Yakima','WA','98901','US',ARRAY['receive_at']::traceability_location_role[])",
    [location, tenant, party],
  );
  await fixture.pool.query(
    "INSERT INTO products (id,tenant_id,name) VALUES ($1,$2,'Finalization apples')",
    [product, tenant],
  );
  await fixture.pool.query(
    "INSERT INTO product_traceability_profiles (tenant_id,product_id,product_name,coverage_status,coverage_rationale,reviewed_by,reviewed_at) VALUES ($1,$2,'Frozen apples','not_covered','Synthetic QA review',$3,now())",
    [tenant, product, actor],
  );
  async function post(path, data) {
    const response = await page.request.post(`${base}/${path}`, {
      headers: { Origin: "http://localhost:5174" },
      data,
    });
    assert.equal(response.ok(), true, `${path}: HTTP ${response.status()}`);
    return response.json();
  }
  const source = { kind: "location", locationId: location };
  const lot = await post("lots", {
    productId: product,
    tlc: "FIN-LINK-001",
    assignmentBasis: "imported",
    source,
  });
  const document = await post("reference-documents", {
    type: "bol",
    typeOtherLabel: null,
    number: "FIN-BOL-0001",
    partyId: party,
    issuedOn: "2026-09-07",
    notes: "Synthetic receiving document",
  });
  const item = {
    productId: product,
    lotId: null,
    lotLinkMode: "create_on_finalize",
    tlc: "FIN-NEW-001",
    source,
    quantity: "500.000",
    unitOfMeasure: "lb",
    exemptSupplier: false,
    exemptReason: null,
    supplierLotReference: "SUP-001",
    notes: null,
  };
  const draft = {
    dateReceived: "2026-09-07",
    locationId: location,
    previousSourceLocationId: location,
    receivedAtNote: "Dock 4",
    notes: "Mixed ordinary receipt",
    documentIds: [document.id],
    items: [
      item,
      { ...item, lotId: lot.id, lotLinkMode: "link_existing", tlc: lot.tlc, quantity: "0.25" },
      { ...item, tlc: "FIN-NEW-002", quantity: "0.001", unitOfMeasure: "kg" },
    ],
  };
  const saved = await post("receiving", { operationKey: randomUUID(), draft });
  await page.getByRole("button", { name: "Open reference data", exact: true }).click();
  await page.getByRole("button", { name: "Receiving", exact: true }).click();
  await page.getByRole("button", { name: saved.eventNumber, exact: true }).click();
  await expect(page.getByRole("button", { name: "Finalize", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Save draft", exact: true }).click();
  await expect(page.getByText("Draft saved.", { exact: true })).toBeVisible();
  async function checkAndOpen(locale = "en") {
    await page
      .getByRole("button", {
        name: locale === "en" ? "Check saved draft" : "Revisar borrador guardado",
        exact: true,
      })
      .click();
    await page
      .getByRole("button", { name: locale === "en" ? "Finalize" : "Finalizar", exact: true })
      .click();
    await expect(page.getByRole("dialog")).toBeVisible();
  }
  // Check/cancel all requested locale, theme and width combinations before sending.
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
        await checkAndOpen(locale);
        const dialog = page.getByRole("dialog");
        await expect(dialog.getByText("500.250 lb", { exact: true })).toBeVisible();
        await expect(dialog.getByText("0.001 kg", { exact: true })).toBeVisible();
        await expect(dialog.getByText(/FIN-BOL-0001/)).toBeVisible();
        await expect(
          dialog.getByText("2026-09-07 · America/Chicago", { exact: true }),
        ).toBeVisible();
        assert.equal(
          await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth),
          true,
        );
        assert.equal(
          await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
          true,
        );
        for (let index = 0; index < 5; index++) {
          await page.keyboard.press("Tab");
          assert.equal(
            await dialog.evaluate((element) => element.contains(document.activeElement)),
            true,
          );
        }
        if (
          (locale === "en" && theme === "light" && width === 1440) ||
          (locale === "es" && theme === "dark" && width === 390)
        )
          await dialog.screenshot({
            path: join(screenshots, `receiving-confirm-${locale}-${theme}-${width}.png`),
            animations: "disabled",
          });
        await page.keyboard.press("Escape");
        await expect(dialog).toHaveCount(0);
        await expect(
          page.getByLabel(locale === "en" ? "Quantity" : "Cantidad", { exact: true }),
        ).toHaveValue("500.000");
      }
    }
    await page
      .getByRole("button", { name: locale === "en" ? "Change theme" : "Cambiar tema", exact: true })
      .click();
  }
  await page.getByRole("button", { name: "Idioma", exact: true }).click();
  await page.setViewportSize({ width: 1440, height: 900 });
  // Stale reference: server rejects the old digest, and the browser demands a fresh check.
  await checkAndOpen();
  await fixture.pool.query(
    "UPDATE product_traceability_profiles SET product_name='Frozen apples confirmed' WHERE tenant_id=$1 AND product_id=$2",
    [tenant, product],
  );
  const conflict = page.waitForResponse((response) =>
    response.url().endsWith(`/${saved.id}/finalize`),
  );
  await page.getByRole("button", { name: "Confirm finalization", exact: true }).click();
  assert.equal((await conflict).status(), 409);
  await expect(page.getByText(/Saved data or references have changed/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Finalize", exact: true })).toHaveCount(0);
  await checkAndOpen();
  const attempts = [];
  let finalized;
  const finalizePattern = `**/api/us/traceability/receiving/${saved.id}/finalize`;
  await page.route(finalizePattern, async (route) => {
    attempts.push(route.request().postDataJSON());
    const response = await route.fetch();
    assert.equal(response.status(), 200);
    if (attempts.length === 1) {
      finalized = await response.json();
      return route.abort("failed");
    }
    return route.fulfill({ response });
  });
  await page.getByRole("button", { name: "Confirm finalization", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Retry same finalization", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Retry same finalization", exact: true }).click();
  await expect(page.getByText(actor, { exact: true })).toBeVisible();
  await page.unroute(finalizePattern);
  assert.equal(attempts.length, 2);
  assert.deepEqual(attempts[0], attempts[1]);
  assert.ok(finalized);
  assert.equal(finalized.snapshot.items[1].lotId, lot.id);
  assert.equal(new Set(finalized.snapshot.items.map((line) => line.lotId)).size, 3);
  const lots = await fixture.pool.query(
    "SELECT id,source_locked_at,revision FROM traceability_lots WHERE tenant_id=$1 AND id=ANY($2::uuid[])",
    [tenant, finalized.snapshot.items.map((line) => line.lotId)],
  );
  assert.equal(lots.rows.length, 3);
  for (const row of lots.rows) {
    assert.equal(row.source_locked_at.toISOString(), finalized.finalizedAt);
    assert.equal(row.revision, row.id === lot.id ? 2 : 1);
  }
  const audits = await fixture.pool.query(
    'SELECT actor_user_id,organization_id,action,outcome,target_id,"after" FROM tenant_audit_events WHERE organization_id=$1 AND (target_id=$2 OR target_id=ANY($3::text[]))',
    [tenant, saved.id, finalized.snapshot.items.map((line) => line.lotId)],
  );
  const eventAudit = audits.rows.filter((row) => row.action === "traceability.receiving.finalized");
  assert.equal(eventAudit.length, 1);
  assert.deepEqual(eventAudit[0].after, finalized);
  assert.equal(
    audits.rows.filter((row) => row.action === "traceability.lot.source_locked").length,
    1,
  );
  assert.equal(audits.rows.filter((row) => row.action === "traceability.lot.created").length, 3);
  assert.ok(
    audits.rows.every(
      (row) =>
        row.actor_user_id === actor && row.organization_id === tenant && row.outcome === "success",
    ),
  );
  // Live reference mutations must never rewrite historical labels.
  await fixture.pool.query(
    "UPDATE products SET name='Live renamed apples' WHERE tenant_id=$1 AND id=$2",
    [tenant, product],
  );
  await fixture.pool.query(
    "UPDATE product_traceability_profiles SET product_name='Live renamed apples' WHERE tenant_id=$1 AND product_id=$2",
    [tenant, product],
  );
  await fixture.pool.query(
    "UPDATE traceability_locations SET business_name='Live renamed farm' WHERE tenant_id=$1 AND id=$2",
    [tenant, location],
  );
  await fixture.pool.query(
    "UPDATE reference_documents SET number='LIVE-BOL' WHERE tenant_id=$1 AND id=$2",
    [tenant, document.id],
  );
  await page.reload();
  await page.getByRole("button", { name: "Open reference data", exact: true }).click();
  await page.getByRole("button", { name: "Receiving", exact: true }).click();
  await page.getByRole("button", { name: saved.eventNumber, exact: true }).click();
  await expect(page.getByText("FIN-BOL-0001", { exact: true })).toBeVisible();
  await expect(page.getByText("Frozen apples confirmed", { exact: true })).toHaveCount(3);
  await expect(page.getByText("Live renamed apples", { exact: true })).toHaveCount(0);
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
        await expect(page.getByText("500.250 lb", { exact: true })).toBeVisible();
        assert.equal(
          await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
          true,
        );
        await page.screenshot({
          path: join(screenshots, `receiving-frozen-${locale}-${theme}-${width}.png`),
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
  await page.getByRole("button", { name: "Open current lot", exact: true }).nth(1).click();
  await expect(page.getByRole("heading", { name: lot.tlc, exact: true })).toBeVisible();
  await page.getByRole("button", { name: "← Back to receiving", exact: true }).click();
  await expect(page.getByText("FIN-BOL-0001", { exact: true })).toBeVisible();
  const lotPattern = `**/api/us/traceability/lots/${lot.id}`;
  await page.route(lotPattern, (route) => route.abort());
  await page.getByRole("button", { name: "Open current lot", exact: true }).nth(1).click();
  await expect(page.getByRole("alert")).toBeVisible();
  await page.getByRole("button", { name: "Back to receiving", exact: true }).click();
  await page.unroute(lotPattern);
  await expect(page.getByText("FIN-BOL-0001", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Back to receiving", exact: true }).click();
  await page.getByRole("button", { name: "← Profile", exact: true }).click();
  // Current operator access can read history but cannot finalize a complete draft.
  const operatorDraft = await post("receiving", {
    operationKey: randomUUID(),
    draft: { ...draft, items: [{ ...item, tlc: "FIN-OPERATOR-001" }] },
  });
  await fixture.pool.query(
    "UPDATE member SET role='traceability_receiving' WHERE organization_id=$1 AND user_id=$2",
    [tenant, actor],
  );
  try {
    await page.getByRole("button", { name: "Open reference data", exact: true }).click();
    await page.getByRole("button", { name: "Receiving", exact: true }).click();
    await page.getByRole("button", { name: operatorDraft.eventNumber, exact: true }).click();
    await page.getByRole("button", { name: "Check saved draft", exact: true }).click();
    await expect(page.getByText(/Complete — no blockers/)).toBeVisible();
    await expect(page.getByRole("button", { name: "Finalize", exact: true })).toHaveCount(0);
    await page.getByRole("button", { name: "Back to receiving", exact: true }).click();
    await page.getByRole("button", { name: saved.eventNumber, exact: true }).click();
    await expect(page.getByText("FIN-BOL-0001", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Back to receiving", exact: true }).click();
    await page.getByRole("button", { name: "← Profile", exact: true }).click();
  } finally {
    await fixture.pool.query(
      "UPDATE member SET role='owner' WHERE organization_id=$1 AND user_id=$2",
      [tenant, actor],
    );
  }
  console.log(
    "Receiving finalization: mixed lots, exact audits/latches, lost-response replay, stale digest, frozen references, explicit lot/back including failure, operator denial; EN/ES light/dark 1440/1024/390 passed.",
  );
}
