import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { exerciseUsReceivingHistory } from "./receiving-history-flow.mjs";
import { exerciseUsLotReceivingBasis } from "./lot-receiving-basis-flow.mjs";
import { exerciseUsMultipleReceivingBasis } from "./receiving-multiple-basis-flow.mjs";

/** Real revision finalization in the existing owned synthetic MFA fixture. */
export async function exerciseUsReceivingAmendmentFinalization({
  page,
  expect,
  screenshots,
  fixture,
  original,
}) {
  const base = "http://localhost:5174/api/us/traceability";
  const read = async (path) => {
    const response = await page.request.get(`${base}/${path}`);
    assert.equal(response.status(), 200);
    return response.json();
  };
  const post = async (path, data, status) => {
    const response = await page.request.post(`${base}/${path}`, {
      data,
      headers: { Origin: "http://localhost:5174" },
    });
    assert.equal(response.status(), status, `Synthetic setup ${path}`);
    return response.json();
  };
  // A separate receipt keeps the earlier cancellation/void journey intact. Setup
  // uses real authenticated commands; no state is inserted behind the API.
  const source = (await read(`receiving/${original.id}`)).content.snapshot;
  const draft = {
    dateReceived: source.dateReceived,
    locationId: source.locationId,
    previousSourceLocationId: source.previousSourceLocationId,
    receivedAtNote: "Synthetic amendment acceptance",
    notes: null,
    documentIds: source.documents.map(({ document }) => document.documentId),
    items: source.items.map((item, index) => ({
      productId: item.productId,
      lotId: item.lotId,
      lotLinkMode: "link_existing",
      tlc: item.tlc,
      source: item.source,
      quantity: item.quantity,
      unitOfMeasure: item.unitOfMeasure,
      supplierLotReference: item.supplierLotReference,
      notes: null,
      exemptSupplier: index < 2,
      exemptReason: index < 2 ? "Synthetic supplier declaration" : null,
      ...(index < 2
        ? {
            exemptReceipt: {
              tlcHandling: "preserve_existing",
              proposedTlc: null,
              evidenceUrl: "https://supplier.example.test/review",
            },
          }
        : {}),
    })),
  };
  const created = await post("receiving", { operationKey: randomUUID(), draft }, 201);
  const check = await read(`receiving/${created.eventId}/readiness?expectedDraftVersion=1`);
  assert.equal(check.state, "complete");
  assert.deepEqual(check.exemptReviewRequiredLines, [1, 2]);
  const first = (
    await post(
      `receiving/${created.eventId}/finalize`,
      {
        operationKey: randomUUID(),
        expectedDraftVersion: 1,
        expectedInputDigest: check.inputDigest,
        reviewedExemptLines: [1, 2],
      },
      200,
    )
  ).record;
  const lotIds = [...new Set(source.items.map((line) => line.lotId))];
  const lotsBefore = await Promise.all(lotIds.map((id) => read(`lots/${id}`)));
  const basesBefore = await Promise.all(
    lotIds.map((id) => read(`lots/${id}/receiving-basis?limit=50&offset=0`)),
  );
  await page.getByRole("button", { name: "Open reference data", exact: true }).click();
  await page.getByRole("button", { name: "Receiving", exact: true }).click();
  await page.getByRole("button", { name: first.eventNumber, exact: true }).click();
  await page.getByRole("button", { name: "Correct receipt", exact: true }).click();
  await page
    .getByRole("textbox", { name: "Reason", exact: true })
    .fill("Synthetic reviewed correction");
  // Another authenticated command wins while the browser still holds the old lifecycle.
  const concurrent = await post(
    `receiving/${first.id}/amend`,
    {
      commandVersion: 2,
      operationKey: randomUUID(),
      expectedLifecycleVersion: first.lifecycle.lifecycleVersion,
      reason: "Synthetic reviewed correction",
    },
    201,
  );
  const rejectedResponse = page.waitForResponse(
    (response) =>
      response.url() === `${base}/receiving/${first.id}/amend` &&
      response.request().method() === "POST",
  );
  void rejectedResponse.catch(() => {});
  await page.getByRole("button", { name: "Start correction", exact: true }).click();
  const rejection = await rejectedResponse;
  assert.equal(rejection.status(), 409);
  const conflict = await rejection.json();
  assert.equal(conflict.code, "receiving_lifecycle_conflict");
  assert.equal(conflict.pendingDraftId, concurrent.eventId);
  await expect(page.getByText(/The receipt lifecycle has changed/)).toBeVisible();
  await expect(page.getByText(/A correction draft is already pending/)).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Reason", exact: true })).toHaveValue(
    "Synthetic reviewed correction",
  );
  await expect(page.getByRole("button", { name: "Retry same operation", exact: true })).toHaveCount(
    0,
  );
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    const notice = page.getByRole("alert");
    await notice.scrollIntoViewIfNeeded();
    assert.equal(
      await notice.evaluate((element) => element.scrollWidth <= element.clientWidth),
      true,
    );
    await page.screenshot({
      path: join(screenshots, `receiving-lifecycle-conflict-en-light-${width}.png`),
      animations: "disabled",
    });
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  const recoveryWrites = [];
  const observeRecovery = (request) => {
    if (
      request.url().startsWith(`${base}/receiving`) &&
      ["POST", "PUT", "PATCH", "DELETE"].includes(request.method())
    )
      recoveryWrites.push(request.method());
  };
  page.on("request", observeRecovery);
  try {
    await page.getByRole("button", { name: "Reload current record", exact: true }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await page.getByRole("button", { name: "Open pending correction", exact: true }).click();
    await expect(
      page.getByRole("region", { name: "Previous revision", exact: true }),
    ).toBeVisible();
    assert.deepEqual(recoveryWrites, []);
    assert.deepEqual(await read(`receiving/${concurrent.eventId}`), concurrent.record);
  } finally {
    page.off("request", observeRecovery);
  }
  await expect(page.getByRole("region", { name: "Previous revision", exact: true })).toBeVisible();
  const predecessor = await read(`receiving/${first.id}`);
  const pending = await read(`receiving/${predecessor.lifecycle.pendingDraftId}`);
  await page.getByRole("button", { name: "Open current receipt", exact: true }).click();
  await expect(page.getByRole("button", { name: "Correct receipt", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Open pending correction", exact: true }).click();
  await expect(page.getByRole("region", { name: "Previous revision", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Check saved draft", exact: true }).click();
  await page.getByRole("button", { name: "Finalize", exact: true }).click();
  let dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("checkbox")).toHaveCount(2);
  await expect(
    dialog.getByRole("button", { name: "Confirm finalization", exact: true }),
  ).toBeDisabled();
  await dialog.getByRole("checkbox").nth(0).check();
  await expect(
    dialog.getByRole("button", { name: "Confirm finalization", exact: true }),
  ).toBeDisabled();
  await dialog.getByRole("button", { name: "Cancel", exact: true }).last().click();
  await page.getByRole("button", { name: "Finalize", exact: true }).click();
  dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("checkbox").nth(0)).not.toBeChecked();
  await expect(dialog.getByRole("checkbox").nth(1)).not.toBeChecked();
  await expect(
    dialog.getByText("Lines: 3 · Retained lots: 3 · New lots: 0 · Linked lots: 0", { exact: true }),
  ).toBeVisible();
  for (const locale of ["en", "es"]) {
    // The existing locale/theme buttons remain visible outside the modal.
    if (locale === "es") {
      await dialog.getByRole("button", { name: "Cancel", exact: true }).last().click();
      await page.getByRole("button", { name: "Language", exact: true }).click();
      await page.getByRole("button", { name: "Finalizar", exact: true }).click();
    }
    for (const theme of ["light", "dark"]) {
      if (theme === "dark") {
        await dialog
          .getByRole("button", { name: locale === "en" ? "Cancel" : "Cancelar", exact: true })
          .last()
          .click();
        await page
          .getByRole("button", {
            name: locale === "en" ? "Change theme" : "Cambiar tema",
            exact: true,
          })
          .click();
        await page
          .getByRole("button", { name: locale === "en" ? "Finalize" : "Finalizar", exact: true })
          .click();
      }
      for (const width of [1440, 1024, 390]) {
        await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
        await expect(dialog.getByRole("checkbox").nth(0)).not.toBeChecked();
        assert.equal(
          await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth),
          true,
        );
        await page.screenshot({
          path: join(screenshots, `receiving-amendment-confirm-${locale}-${theme}-${width}.png`),
          animations: "disabled",
        });
      }
    }
    await dialog
      .getByRole("button", { name: locale === "en" ? "Cancel" : "Cancelar", exact: true })
      .last()
      .click();
    await page
      .getByRole("button", { name: locale === "en" ? "Change theme" : "Cambiar tema", exact: true })
      .click();
    await page
      .getByRole("button", { name: locale === "en" ? "Finalize" : "Finalizar", exact: true })
      .click();
  }
  await dialog.getByRole("button", { name: "Cancelar", exact: true }).last().click();
  await page.getByRole("button", { name: "Idioma", exact: true }).click();
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.getByRole("button", { name: "Finalize", exact: true }).click();
  await expect(dialog.getByRole("checkbox")).toHaveCount(2);
  for (const checkbox of await dialog.getByRole("checkbox").all()) await checkbox.check();
  await expect(
    dialog.getByRole("button", { name: "Confirm finalization", exact: true }),
  ).toBeEnabled();
  const pattern = `**/api/us/traceability/receiving/${pending.id}/finalize`;
  const attempts = [];
  await page.route(pattern, async (route) => {
    attempts.push(route.request().postDataJSON());
    if (attempts.length !== 1) return route.continue();
    const response = await route.fetch();
    assert.equal(response.status(), 200);
    return route.abort("failed");
  });
  await dialog.getByRole("button", { name: "Confirm finalization", exact: true }).click();
  await dialog.getByRole("button", { name: "Retry same finalization", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByText("Finalized", { exact: true })).toBeVisible();
  await page.unroute(pattern);
  assert.equal(attempts.length, 2);
  assert.deepEqual(attempts[0], attempts[1]);
  assert.equal(attempts[0].commandVersion, 2);
  assert.equal(attempts[0].previousRevisionId, first.id);
  assert.deepEqual(attempts[0].reviewedExemptLines, [1, 2]);
  const final = await read(`receiving/${pending.id}`);
  const old = await read(`receiving/${first.id}`);
  assert.equal(old.status, "amended");
  assert.equal(old.lifecycle.supersededByEventId, final.id);
  assert.deepEqual(old.content, first.content);
  assert.equal(final.lifecycle.lifecycleVersion, pending.lifecycle.lifecycleVersion + 1);
  assert.equal(final.lifecycle.currentEventId, final.id);
  assert.equal(final.lifecycle.pendingDraftId, null);
  for (const [index, line] of final.content.snapshot.items.entries()) {
    assert.deepEqual(line.lotBinding, {
      kind: "retained",
      previousEventId: first.id,
      previousLineNo: index + 1,
    });
    if (index < 2) {
      assert.equal(line.receiptBasis.reviewedBy, fixture.userId);
      assert.equal(line.receiptBasis.reviewedAt, final.content.finalizedAt);
    }
  }
  for (const [index, id] of lotIds.entries()) {
    assert.deepEqual(await read(`lots/${id}`), lotsBefore[index]);
    const basis = await read(`lots/${id}/receiving-basis?limit=50&offset=0`);
    assert.equal(basis.supportCount, basesBefore[index].supportCount);
    assert.equal(basis.basisVersion, basesBefore[index].basisVersion + 1);
  }
  const audit = await fixture.pool.query(
    'SELECT actor_user_id, organization_id, action, outcome, target_type, target_id, "before", "after" FROM tenant_audit_events WHERE organization_id=$1 AND target_id=$2 AND action=$3',
    [fixture.tenantId, final.id, "traceability.receiving.finalized"],
  );
  assert.deepEqual(audit.rows, [
    {
      actor_user_id: fixture.userId,
      organization_id: fixture.tenantId,
      action: "traceability.receiving.finalized",
      outcome: "success",
      target_type: "traceability_event",
      target_id: final.id,
      before: pending,
      after: {
        rootId: first.id,
        revision: 2,
        reason: "Synthetic reviewed correction",
        result: "finalized",
        effect: {
          kind: "documentary",
          affectedLotIds: [],
          removedPreviousLineNos: [],
          identityLockedLineNos: [],
          invalidBindingLineNos: [],
        },
        record: final,
        predecessor: { before: predecessor, after: old },
        lineLots: {
          before: first.content.snapshot.items.map(({ lineNo, lotId }) => ({ lineNo, lotId })),
          after: first.content.snapshot.items.map(({ lineNo, lotId }) => ({ lineNo, lotId })),
        },
      },
    },
  ]);
  await exerciseUsReceivingHistory({ page, expect, screenshots, first, final });
  await exerciseUsLotReceivingBasis({ page, expect, screenshots, final });
  await exerciseUsMultipleReceivingBasis({ page, expect, screenshots, fixture, final });
  await page.getByRole("button", { name: "← Profile", exact: true }).click();
  console.log(
    "Receiving amendment: fresh exempt QA review, captured v2 finalize with lost-response exact replay, preserved predecessor and lot identity, replaced basis and single audit; EN/ES light/dark 1440/1024/390 passed.",
  );
}
