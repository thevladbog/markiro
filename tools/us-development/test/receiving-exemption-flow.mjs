import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { join } from "node:path";

const longReason =
  "Receipt-specific declaration reviewed against the supplier statement for this delivery; the wording is intentionally long so the grouped line remains readable without changing the saved compliance basis.";
const evidenceOne =
  "https://supplier.example.test/evidence/receipts/2026-09-07/preserved-existing-tlc/declaration-with-a-deliberately-long-safe-path?shipment=EXEMPT-4001&line=1";
const evidenceTwo =
  "https://supplier.example.test/evidence/receipts/2026-09-07/own-assignment/declaration-with-a-deliberately-long-safe-path?shipment=EXEMPT-4001&line=2";
const sourceReference =
  "https://source.example.test/traceability/receipts/2026-09-07/preserved-existing-tlc/source-with-a-deliberately-long-safe-path?shipment=EXEMPT-4001&line=1";

/** Runs after ordinary finalization and owns only its synthetic exempt receipt rows. */
export async function exerciseUsReceivingExemption({ page, expect, screenshots, fixture }) {
  const base = "http://localhost:5174/api/us/traceability";
  const tenant = fixture.tenantId,
    actor = fixture.userId;
  const party = randomUUID(),
    receivingLocation = randomUUID(),
    previousLocation = randomUUID(),
    product = randomUUID();

  await fixture.pool.query(
    "INSERT INTO traceability_parties (id,tenant_id,name,legal_name) VALUES ($1,$2,'Exempt browser supplier','Frozen Exempt Supplier Cooperative')",
    [party, tenant],
  );
  await fixture.pool.query(
    "INSERT INTO traceability_locations (id,tenant_id,party_id,name,business_name,phone_number,street_address,city,state_or_region,zip_or_postal_code,country_code,roles) VALUES ($1,$2,$3,'Exempt receiving dock','Frozen Receiving Facility LLC','+1 509 555 0191','900 Receiving Way','Yakima','WA','98901','US',ARRAY['receive_at','tlc_source']::traceability_location_role[]),($4,$2,$3,'Exempt supplier cold store','Frozen Supplier Orchard LLC','+1 509 555 0192','17 Orchard Road','Wenatchee','WA','98801','US',ARRAY['supplier','ship_from','tlc_source']::traceability_location_role[])",
    [receivingLocation, tenant, party, previousLocation],
  );
  await fixture.pool.query(
    "INSERT INTO products (id,tenant_id,name) VALUES ($1,$2,'Frozen exempt apples')",
    [product, tenant],
  );
  await fixture.pool.query(
    "INSERT INTO product_traceability_profiles (tenant_id,product_id,product_name,coverage_status,coverage_rationale,reviewed_by,reviewed_at) VALUES ($1,$2,'Frozen exempt apples','not_covered','Synthetic exempt browser evidence',$3,now())",
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

  const document = await post("reference-documents", {
    type: "bol",
    typeOtherLabel: null,
    number: "EXEMPT-BOL-4001",
    partyId: party,
    issuedOn: "2026-09-07",
    notes: "Synthetic exempt receipt browser document",
  });
  const preserved = {
    productId: product,
    lotId: null,
    lotLinkMode: "create_on_finalize",
    tlc: "EXEMPT-SUPPLIER-Ä-001",
    source: {
      kind: "reference",
      referenceKind: "web_url",
      referenceValue: sourceReference,
      resolvedLocationId: previousLocation,
    },
    quantity: "25.000",
    unitOfMeasure: "lb",
    exemptSupplier: true,
    exemptReason: longReason,
    exemptReceipt: {
      evidenceUrl: evidenceOne,
      tlcHandling: "preserve_existing",
      proposedTlc: null,
    },
    supplierLotReference: "SUPPLIER-LOT-EXEMPT-A",
    notes: "Preserve the received identity and physical source.",
  };
  const assigned = {
    ...preserved,
    tlc: null,
    source: { kind: "location", locationId: receivingLocation },
    quantity: "10.500",
    exemptReason: "No TLC arrived with this exempt shipment; QA assigns only for this receipt.",
    exemptReceipt: {
      evidenceUrl: evidenceTwo,
      tlcHandling: "assign_if_missing",
      proposedTlc: "=OWN/Ä-EXEMPT-002",
    },
    supplierLotReference: "SUPPLIER-LOT-EXEMPT-B",
    notes: "Assign at the physical receiving site only after line review.",
  };
  const draft = {
    dateReceived: "2026-09-07",
    locationId: receivingLocation,
    previousSourceLocationId: previousLocation,
    receivedAtNote: "Dock 9",
    notes: "Mixed receipt-specific exemption paths",
    documentIds: [document.id],
    items: [preserved, assigned],
  };
  const saved = await post("receiving", { operationKey: randomUUID(), draft });
  const second = await post("receiving", {
    operationKey: randomUUID(),
    draft: {
      ...draft,
      notes: "Separate same-supplier receipt with independent review",
      items: [{ ...preserved, tlc: "EXEMPT-SUPPLIER-SECOND-001" }],
    },
  });
  const unicodeEntry = await post("receiving", {
    operationKey: randomUUID(),
    draft: {
      ...draft,
      notes: "Native supplementary Unicode proposal entry boundary",
      items: [
        {
          ...assigned,
          exemptReceipt: { ...assigned.exemptReceipt, proposedTlc: null },
        },
      ],
    },
  });

  const readinessResponse = await page.request.get(
    `${base}/receiving/${saved.id}/readiness?expectedDraftVersion=${saved.draftVersion}`,
    { headers: { Origin: "http://localhost:5174" } },
  );
  assert.equal(readinessResponse.ok(), true);
  const readiness = await readinessResponse.json();
  assert.equal(readiness.state, "complete");
  assert.deepEqual(readiness.exemptReviewRequiredLines, [1, 2]);
  const secondReadinessResponse = await page.request.get(
    `${base}/receiving/${second.id}/readiness?expectedDraftVersion=${second.draftVersion}`,
    { headers: { Origin: "http://localhost:5174" } },
  );
  assert.equal(secondReadinessResponse.ok(), true);
  const secondReadiness = await secondReadinessResponse.json();
  assert.deepEqual(secondReadiness.exemptReviewRequiredLines, [1]);

  await page.getByRole("button", { name: "Open reference data", exact: true }).click();
  await page.getByRole("button", { name: "Receiving", exact: true }).click();
  await page.getByRole("button", { name: unicodeEntry.eventNumber, exact: true }).click();
  const unicodeProposal = page.getByLabel("Proposed TLC for own assignment", { exact: true });
  const validUnicodeProposal = "🚀".repeat(120);
  await unicodeProposal.click();
  await unicodeProposal.pressSequentially(validUnicodeProposal);
  await expect(unicodeProposal).toHaveValue(validUnicodeProposal);
  assert.equal(Array.from(await unicodeProposal.inputValue()).length, 120);
  await page.getByRole("button", { name: "Save draft", exact: true }).click();
  await expect(page.getByText("Draft saved.", { exact: true })).toBeVisible();
  const acceptedUnicodeResponse = await page.request.get(`${base}/receiving/${unicodeEntry.id}`, {
    headers: { Origin: "http://localhost:5174" },
  });
  assert.equal(acceptedUnicodeResponse.ok(), true);
  const acceptedUnicode = await acceptedUnicodeResponse.json();
  assert.equal(acceptedUnicode.draft.items[0].exemptReceipt.proposedTlc, validUnicodeProposal);
  await unicodeProposal.pressSequentially("🚀");
  assert.equal(Array.from(await unicodeProposal.inputValue()).length, 121);
  await page.getByRole("button", { name: "Save draft", exact: true }).click();
  await expect(page.getByText("Check the format of these fields:", { exact: true })).toBeVisible();
  const rejectedUnicodeResponse = await page.request.get(`${base}/receiving/${unicodeEntry.id}`, {
    headers: { Origin: "http://localhost:5174" },
  });
  assert.equal(rejectedUnicodeResponse.ok(), true);
  const rejectedUnicode = await rejectedUnicodeResponse.json();
  assert.equal(rejectedUnicode.draftVersion, acceptedUnicode.draftVersion);
  assert.equal(rejectedUnicode.draft.items[0].exemptReceipt.proposedTlc, validUnicodeProposal);
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Back to receiving", exact: true }).click();
  await page.getByRole("button", { name: saved.eventNumber, exact: true }).click();
  await expect(page.getByLabel("Lot code (TLC)", { exact: true }).first()).toHaveValue(
    preserved.tlc,
  );
  await expect(page.getByLabel("Resolved source location", { exact: true }).first()).toHaveValue(
    previousLocation,
  );
  await expect(page.getByRole("radio", { name: "Existing TLC", exact: true })).toBeChecked();
  await page.getByRole("button", { name: /^Line 2\b/ }).click();
  await expect(page.getByRole("radio", { name: "No TLC assigned", exact: true })).toBeChecked();
  await expect(page.getByText("Exempt receiving dock", { exact: true }).last()).toBeVisible();

  async function openReview(locale) {
    await page
      .getByRole("button", {
        name: locale === "en" ? "Check saved draft" : "Revisar borrador guardado",
        exact: true,
      })
      .click();
    const pendingNotice =
      locale === "en"
        ? "Pending QA review for saved exempt lines: 1, 2."
        : "Revisión de Calidad pendiente para las líneas exentas guardadas: 1, 2.";
    await expect(page.getByText(pendingNotice, { exact: true })).toBeVisible();
    await page
      .getByRole("button", { name: locale === "en" ? "Finalize" : "Finalizar", exact: true })
      .click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await expect(
      dialog.getByRole("checkbox", {
        name: locale === "en" ? "Review exemption for line 1" : "Revisar exención de la línea 1",
        exact: true,
      }),
    ).toBeVisible();
    return dialog;
  }

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
        await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
        await page.evaluate(() => document.fonts.ready);
        assert.equal(
          await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
          true,
        );
        await page
          .getByRole("button", { name: locale === "en" ? /^Line 1\b/ : /^Línea 1\b/ })
          .click();
        await page.screenshot({
          path: join(
            screenshots,
            `receiving-exempt-draft-preserve-${locale}-${theme}-${width}.png`,
          ),
          fullPage: true,
          animations: "disabled",
        });
        await page
          .getByRole("button", { name: locale === "en" ? /^Line 2\b/ : /^Línea 2\b/ })
          .click();
        await page.screenshot({
          path: join(screenshots, `receiving-exempt-draft-own-${locale}-${theme}-${width}.png`),
          fullPage: true,
          animations: "disabled",
        });
        await page
          .getByRole("button", {
            name: locale === "en" ? "Check saved draft" : "Revisar borrador guardado",
            exact: true,
          })
          .click();
        const pendingNotice =
          locale === "en"
            ? "Pending QA review for saved exempt lines: 1, 2."
            : "Revisión de Calidad pendiente para las líneas exentas guardadas: 1, 2.";
        await expect(page.getByText(pendingNotice, { exact: true })).toBeVisible();
        if (
          (locale === "en" && theme === "light" && width === 1440) ||
          (locale === "es" && theme === "dark" && width === 390)
        )
          await page.screenshot({
            path: join(
              screenshots,
              `receiving-exempt-readiness-pending-${locale}-${theme}-${width}.png`,
            ),
            fullPage: true,
            animations: "disabled",
          });
        await page
          .getByRole("button", { name: locale === "en" ? "Finalize" : "Finalizar", exact: true })
          .click();
        const dialog = page.getByRole("dialog");
        await expect(dialog).toBeVisible();
        const first = dialog.getByRole("checkbox", {
          name: locale === "en" ? "Review exemption for line 1" : "Revisar exención de la línea 1",
          exact: true,
        });
        const secondLine = dialog.getByRole("checkbox", {
          name: locale === "en" ? "Review exemption for line 2" : "Revisar exención de la línea 2",
          exact: true,
        });
        const confirm = dialog.getByRole("button", {
          name: locale === "en" ? "Confirm finalization" : "Confirmar finalización",
          exact: true,
        });
        await expect(first).not.toBeChecked();
        await expect(secondLine).not.toBeChecked();
        await expect(confirm).toBeDisabled();
        await first.check();
        await expect(confirm).toBeDisabled();
        await secondLine.check();
        await expect(confirm).toBeEnabled();
        await expect(dialog.getByText(longReason, { exact: true })).toBeVisible();
        await expect(dialog.getByRole("link", { name: evidenceTwo, exact: true })).toHaveAttribute(
          "rel",
          "noopener noreferrer",
        );
        await expect(
          dialog.getByRole("link", { name: sourceReference, exact: true }),
        ).toHaveAttribute("rel", "noopener noreferrer");
        await expect(
          dialog.getByText(locale === "en" ? "Source reference" : "Referencia del origen", {
            exact: true,
          }),
        ).toBeVisible();
        await expect(
          dialog.getByText(
            locale === "en" ? "Resolved source location" : "Ubicación del origen resuelta",
            { exact: true },
          ),
        ).toBeVisible();
        assert.equal(await dialog.evaluate((node) => node.scrollWidth <= node.clientWidth), true);
        assert.equal(
          await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
          true,
        );
        await page.keyboard.press("Tab");
        const focusVisible = await page.evaluate(() => {
          const active = document.activeElement;
          if (!(active instanceof HTMLElement)) return false;
          const style = getComputedStyle(active);
          return style.outlineStyle !== "none" || style.boxShadow !== "none";
        });
        assert.equal(focusVisible, true);
        await dialog.screenshot({
          path: join(screenshots, `receiving-exempt-confirm-${locale}-${theme}-${width}.png`),
          animations: "disabled",
        });
        if (
          (locale === "en" && theme === "light" && width === 1440) ||
          (locale === "es" && theme === "dark" && width === 390)
        ) {
          await dialog
            .getByRole("link", { name: sourceReference, exact: true })
            .scrollIntoViewIfNeeded();
          await dialog.screenshot({
            path: join(
              screenshots,
              `receiving-exempt-confirm-source-reference-${locale}-${theme}-${width}.png`,
            ),
            animations: "disabled",
          });
          await dialog.getByText(saved.eventNumber, { exact: true }).scrollIntoViewIfNeeded();
          await dialog.screenshot({
            path: join(screenshots, `receiving-exempt-confirm-top-${locale}-${theme}-${width}.png`),
            animations: "disabled",
          });
        }
        await page.keyboard.press("Escape");
        await expect(dialog).toHaveCount(0);
      }
    }
    await page
      .getByRole("button", { name: locale === "en" ? "Change theme" : "Cambiar tema", exact: true })
      .click();
  }
  await page.getByRole("button", { name: "Idioma", exact: true }).click();
  await page.setViewportSize({ width: 1440, height: 900 });

  const dialog = await openReview("en");
  await dialog.getByRole("checkbox", { name: "Review exemption for line 1", exact: true }).check();
  await dialog.getByRole("checkbox", { name: "Review exemption for line 2", exact: true }).check();
  const attempts = [];
  let committed;
  const finalizePattern = `**/api/us/traceability/receiving/${saved.id}/finalize`;
  const loseCommittedResponse = async (route) => {
    attempts.push(route.request().postDataJSON());
    const response = await route.fetch();
    assert.equal(response.status(), 200);
    if (attempts.length === 1) {
      committed = await response.json();
      return route.abort("failed");
    }
    return route.fulfill({ response });
  };
  await page.route(finalizePattern, loseCommittedResponse);
  await dialog.getByRole("button", { name: "Confirm finalization", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Retry same finalization", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("checkbox", { name: "Review exemption for line 1", exact: true }),
  ).toBeDisabled();
  await page.getByRole("button", { name: "Retry same finalization", exact: true }).click();
  await expect(
    page.getByText("Exempt receipt — TLC assigned at finalization", { exact: true }),
  ).toBeVisible();
  await page.unroute(finalizePattern, loseCommittedResponse);
  assert.equal(attempts.length, 2);
  assert.deepEqual(attempts[0], attempts[1]);
  assert.deepEqual(attempts[0].reviewedExemptLines, [1, 2]);
  assert.ok(committed);

  const currentResponse = await page.request.get(`${base}/receiving/${saved.id}`, {
    headers: { Origin: "http://localhost:5174" },
  });
  assert.equal(currentResponse.ok(), true);
  const frozen = await currentResponse.json();
  assert.equal(frozen.snapshot.snapshotVersion, 2);
  assert.deepEqual(frozen.snapshot.confirmation.reviewedExemptLines, [1, 2]);
  assert.equal(frozen.snapshot.items[0].tlc, preserved.tlc);
  assert.equal(frozen.snapshot.items[0].source.referenceValue, sourceReference);
  assert.equal(frozen.snapshot.items[0].source.resolvedLocationId, previousLocation);
  assert.equal(frozen.snapshot.items[0].receiptBasis.kind, "exempt_existing_tlc");
  assert.equal(frozen.snapshot.items[1].tlc, assigned.exemptReceipt.proposedTlc);
  assert.equal(frozen.snapshot.items[1].source.locationId, receivingLocation);
  assert.equal(frozen.snapshot.items[1].receiptBasis.kind, "exempt_assigned_tlc");
  assert.equal(frozen.snapshot.items[1].receiptBasis.receivedTlc, null);

  const stored = await fixture.pool.query(
    "SELECT line_no,tlc,exempt_receipt FROM receiving_event_items WHERE tenant_id=$1 AND event_id=$2 ORDER BY line_no",
    [tenant, saved.id],
  );
  assert.equal(stored.rows[0].tlc, preserved.tlc);
  assert.equal(stored.rows[1].tlc, null);
  assert.deepEqual(stored.rows[1].exempt_receipt, assigned.exemptReceipt);
  const lotIds = frozen.snapshot.items.map((item) => item.lotId);
  const lots = await fixture.pool.query(
    "SELECT id,product_id,tlc,assignment_basis,source_location_id,source_reference_kind,source_reference_value,source_reference_location_id,source_locked_at,revision FROM traceability_lots WHERE tenant_id=$1 AND id=ANY($2::uuid[]) ORDER BY tlc",
    [tenant, lotIds],
  );
  assert.equal(lots.rows.length, 2);
  const existingLot = lots.rows.find((row) => row.id === frozen.snapshot.items[0].lotId);
  const ownLot = lots.rows.find((row) => row.id === frozen.snapshot.items[1].lotId);
  assert.deepEqual(
    {
      product: existingLot.product_id,
      tlc: existingLot.tlc,
      basis: existingLot.assignment_basis,
      sourceLocation: existingLot.source_location_id,
      sourceReferenceKind: existingLot.source_reference_kind,
      sourceReferenceValue: existingLot.source_reference_value,
      sourceReferenceLocation: existingLot.source_reference_location_id,
      revision: existingLot.revision,
    },
    {
      product,
      tlc: preserved.tlc,
      basis: "imported",
      sourceLocation: null,
      sourceReferenceKind: "web_url",
      sourceReferenceValue: sourceReference,
      sourceReferenceLocation: previousLocation,
      revision: 1,
    },
  );
  assert.deepEqual(
    {
      product: ownLot.product_id,
      tlc: ownLot.tlc,
      basis: ownLot.assignment_basis,
      source: ownLot.source_location_id,
      revision: ownLot.revision,
    },
    {
      product,
      tlc: assigned.exemptReceipt.proposedTlc,
      basis: "exempt_supplier_receipt",
      source: receivingLocation,
      revision: 1,
    },
  );
  assert.equal(existingLot.source_locked_at.toISOString(), frozen.finalizedAt);
  assert.equal(ownLot.source_locked_at.toISOString(), frozen.finalizedAt);
  const audits = await fixture.pool.query(
    'SELECT actor_user_id,organization_id,action,outcome,target_type,target_id,"after" FROM tenant_audit_events WHERE organization_id=$1 AND (target_id=$2 OR target_id=ANY($3::text[]))',
    [tenant, saved.id, lotIds],
  );
  assert.equal(
    audits.rows.filter((row) => row.action === "traceability.receiving.finalized").length,
    1,
  );
  assert.equal(audits.rows.filter((row) => row.action === "traceability.lot.created").length, 2);
  assert.ok(
    audits.rows.every(
      (row) =>
        row.actor_user_id === actor &&
        row.organization_id === tenant &&
        row.outcome === "success" &&
        ((row.target_type === "traceability_event" && row.target_id === saved.id) ||
          (row.target_type === "traceability_lot" && lotIds.includes(row.target_id))),
    ),
  );
  assert.deepEqual(
    audits.rows.find((row) => row.action === "traceability.receiving.finalized").after,
    frozen,
  );

  await page.getByRole("button", { name: "Back to receiving", exact: true }).click();
  await page.getByRole("button", { name: second.eventNumber, exact: true }).click();
  await page.getByRole("button", { name: "Check saved draft", exact: true }).click();
  await page.getByRole("button", { name: "Finalize", exact: true }).click();
  const secondDialog = page.getByRole("dialog");
  await expect(
    secondDialog.getByRole("checkbox", { name: "Review exemption for line 1", exact: true }),
  ).not.toBeChecked();
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Back to receiving", exact: true }).click();
  await page.getByRole("button", { name: saved.eventNumber, exact: true }).click();

  await fixture.pool.query(
    "UPDATE products SET name='Live renamed exempt apples' WHERE tenant_id=$1 AND id=$2",
    [tenant, product],
  );
  await fixture.pool.query(
    "UPDATE product_traceability_profiles SET product_name='Live renamed exempt apples' WHERE tenant_id=$1 AND product_id=$2",
    [tenant, product],
  );
  await fixture.pool.query(
    "UPDATE traceability_locations SET business_name=CASE id WHEN $2 THEN 'Live receiving facility' ELSE 'Live supplier orchard' END WHERE tenant_id=$1 AND id=ANY($3::uuid[])",
    [tenant, receivingLocation, [receivingLocation, previousLocation]],
  );
  await page.reload();
  await page.getByRole("button", { name: "Open reference data", exact: true }).click();
  await page.getByRole("button", { name: "Receiving", exact: true }).click();
  await page.getByRole("button", { name: saved.eventNumber, exact: true }).click();
  await expect(page.getByText("Frozen exempt apples", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("Live renamed exempt apples", { exact: true })).toHaveCount(0);
  await expect(page.getByText(/Frozen Receiving Facility LLC/).first()).toBeVisible();
  await expect(page.getByText(/Frozen Supplier Orchard LLC/).first()).toBeVisible();

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
        await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
        assert.equal(
          await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
          true,
        );
        await page.screenshot({
          path: join(screenshots, `receiving-exempt-frozen-${locale}-${theme}-${width}.png`),
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
  await page.getByRole("button", { name: "Back to receiving", exact: true }).click();
  await page.getByRole("button", { name: "← Profile", exact: true }).click();

  await fixture.pool.query(
    "UPDATE member SET role='traceability_receiving' WHERE organization_id=$1 AND user_id=$2",
    [tenant, actor],
  );
  try {
    const denied = await page.request.post(`${base}/receiving/${second.id}/finalize`, {
      headers: { Origin: "http://localhost:5174" },
      data: {
        operationKey: randomUUID(),
        expectedDraftVersion: second.draftVersion,
        expectedInputDigest: secondReadiness.inputDigest,
        reviewedExemptLines: [1],
      },
    });
    assert.equal(denied.status(), 403);
  } finally {
    await fixture.pool.query(
      "UPDATE member SET role='owner' WHERE organization_id=$1 AND user_id=$2",
      [tenant, actor],
    );
  }
  console.log(
    "Receiving exemption: native 120/121-code-point entry boundary, mixed preserved/own lines, exact source-reference review and pending-QA notice, receipt-only review, exact lost-response retry, v2 frozen history, stable lot/audit identities, live-reference mutation, operator 403; EN/ES light/dark 1440/1024/390 passed.",
  );
}
