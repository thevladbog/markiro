import assert from "node:assert/strict";
import { join } from "node:path";

/** Real lifecycle writes in the owned synthetic fixture; faults affect delivery only. */
export async function exerciseUsReceivingLifecycle({
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
  const before = await read(`receiving/${original.id}`);
  const lotIds = [...new Set(before.content.snapshot.items.map((line) => line.lotId))];
  const lotsBefore = await Promise.all(lotIds.map((id) => read(`lots/${id}`)));
  const basesBefore = await Promise.all(
    lotIds.map((id) => read(`lots/${id}/receiving-basis?limit=1&offset=0`)),
  );
  await page.getByRole("button", { name: "Open reference data", exact: true }).click();
  await page.getByRole("button", { name: "Receiving", exact: true }).click();
  await page.getByRole("button", { name: original.eventNumber, exact: true }).click();

  // Inspect both dialogs, translations and themes before sending any operation.
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
      for (const action of ["amend", "void"]) {
        const label =
          action === "amend"
            ? locale === "en"
              ? "Correct receipt"
              : "Corregir recepción"
            : locale === "en"
              ? "Void receipt"
              : "Anular recepción";
        await page.getByRole("button", { name: label, exact: true }).click();
        const dialog = page.getByRole("dialog", { name: label, exact: true });
        if (action === "void")
          await expect(
            dialog.getByRole("heading", {
              name:
                locale === "en"
                  ? "Lots losing their last receiving basis"
                  : "Lotes que pierden su último respaldo de recepción",
              exact: true,
            }),
          ).toBeVisible();
        for (const width of [1440, 1024, 390]) {
          await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
          await expect(dialog).toBeVisible();
          assert.equal(
            await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth),
            true,
          );
          await page.screenshot({
            path: join(screenshots, `receiving-${action}-dialog-${locale}-${theme}-${width}.png`),
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

  const amendPattern = `**/api/us/traceability/receiving/${original.id}/amend`;
  const attempts = [];
  let started;
  await page.route(amendPattern, async (route) => {
    assert.equal(route.request().method(), "POST");
    attempts.push(route.request().postDataJSON());
    if (attempts.length !== 1) return route.continue();
    const response = await route.fetch();
    assert.equal(response.status(), 201);
    started = await response.json();
    return route.abort("failed");
  });
  await page.getByRole("button", { name: "Correct receipt", exact: true }).click();
  await page
    .getByRole("textbox", { name: "Reason", exact: true })
    .fill("Synthetic delivery correction");
  await page.getByRole("button", { name: "Start correction", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Retry same operation", exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Back to receiving", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "Retry same operation", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.unroute(amendPattern);
  assert.equal(attempts.length, 2);
  assert.deepEqual(attempts[0], attempts[1]);
  assert.equal(started.record.status, "draft");
  assert.equal(started.record.lifecycle.currentEventId, original.id);
  await expect(page.getByRole("region", { name: "Previous revision", exact: true })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Lot code (TLC)", exact: true })).toHaveCount(0);
  await page.getByRole("textbox", { name: "Quantity", exact: true }).fill("200.125");
  await page
    .getByRole("textbox", { name: "Line notes", exact: true })
    .fill("Synthetic quantity correction");
  // Both panes stay mounted when narrow layouts switch tabs; unsaved input survives.
  for (const locale of ["en", "es"]) {
    if (locale === "es") await page.getByRole("button", { name: "Language", exact: true }).click();
    const comparisonName = locale === "en" ? "Previous revision" : "Revisión anterior";
    const draftName = locale === "en" ? "Correction draft" : "Borrador de corrección";
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
        if (width < 1100) await page.getByRole("tab", { name: draftName, exact: true }).click();
        const quantity = page.getByRole("textbox", {
          name: locale === "en" ? "Quantity" : "Cantidad",
          exact: true,
        });
        await expect(quantity).toHaveValue("200.125");
        await quantity.scrollIntoViewIfNeeded();
        assert.equal(
          await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
          true,
        );
        await page.screenshot({
          path: join(screenshots, `receiving-correction-${locale}-${theme}-${width}.png`),
          animations: "disabled",
        });
        if (width < 1100) {
          await page.getByRole("tab", { name: draftName, exact: true }).focus();
          await page.keyboard.press("ArrowRight");
          await expect(
            page.getByRole("tab", { name: comparisonName, exact: true }),
          ).toHaveAttribute("aria-selected", "true");
          const comparison = page.getByRole("region", { name: comparisonName, exact: true });
          await expect(comparison).toBeVisible();
          await comparison.scrollIntoViewIfNeeded();
          await page.screenshot({
            path: join(screenshots, `receiving-comparison-${locale}-${theme}-${width}.png`),
            animations: "disabled",
          });
          await page.getByRole("tab", { name: draftName, exact: true }).click();
          await expect(quantity).toHaveValue("200.125");
        }
      }
    }
    await page
      .getByRole("button", { name: locale === "en" ? "Change theme" : "Cambiar tema", exact: true })
      .click();
  }
  await page.getByRole("button", { name: "Idioma", exact: true }).click();
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.getByRole("button", { name: "Move line down", exact: true }).click();
  const savePattern = `**/api/us/traceability/receiving/${started.eventId}`;
  const saveAttempts = [];
  await page.route(savePattern, async (route) => {
    if (route.request().method() !== "PUT") return route.continue();
    saveAttempts.push(route.request().postDataJSON());
    if (saveAttempts.length !== 1) return route.continue();
    const response = await route.fetch();
    assert.equal(response.status(), 200);
    return route.abort("failed");
  });
  await page.getByRole("button", { name: "Save draft", exact: true }).click();
  await page.getByRole("button", { name: "Retry same save", exact: true }).click();
  await expect(page.getByText("Draft saved.", { exact: true })).toBeVisible();
  await page.unroute(savePattern);
  assert.equal(saveAttempts.length, 2);
  assert.deepEqual(saveAttempts[0], saveAttempts[1]);
  const savedCorrection = await read(`receiving/${started.eventId}`);
  assert.equal(savedCorrection.draftVersion, started.record.draftVersion + 1);
  assert.equal(
    savedCorrection.lifecycle.lifecycleVersion,
    started.record.lifecycle.lifecycleVersion,
  );
  assert.deepEqual(
    savedCorrection.content.draft.items.map((line) => line.previousLineNo),
    [2, 1, 3],
  );
  assert.equal(savedCorrection.content.draft.items[1].quantity, "200.125");
  assert.equal(
    savedCorrection.content.draft.items[1].lotId,
    before.content.snapshot.items[0].lotId,
  );
  assert.deepEqual(
    (await read(`receiving/${original.id}`)).content.snapshot,
    before.content.snapshot,
  );
  // Cancelling the amendment preserves the current receipt and its lot basis.
  await page.getByRole("button", { name: "Void receipt", exact: true }).click();
  await page
    .getByRole("textbox", { name: "Reason", exact: true })
    .fill("Synthetic correction cancelled");
  await page.getByRole("button", { name: "Confirm void", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByText(/This receipt is void/)).toBeVisible();
  const cancelled = await read(`receiving/${started.eventId}`);
  assert.equal(cancelled.status, "void");
  assert.equal(cancelled.lifecycle.currentEventId, original.id);
  assert.equal(cancelled.lifecycle.pendingDraftId, null);
  for (const id of lotIds)
    assert.equal((await read(`lots/${id}/receiving-basis?limit=1&offset=0`)).supportCount, 1);
  await page.getByRole("button", { name: "Back to receiving", exact: true }).click();
  await page.getByRole("button", { name: original.eventNumber, exact: true }).click();

  const voidPattern = `**/api/us/traceability/receiving/${original.id}/void`;
  const currentPattern = `**/api/us/traceability/receiving/${original.id}`;
  let voidPosts = 0;
  let reads = 0;
  await page.route(voidPattern, async (route) => {
    voidPosts += 1;
    return route.continue();
  });
  await page.route(currentPattern, async (route) => {
    if (route.request().method() === "GET" && ++reads === 1)
      return route.fulfill({ status: 503, json: { code: "us_database_unavailable" } });
    return route.continue();
  });
  await page.getByRole("button", { name: "Void receipt", exact: true }).click();
  const dialog = page.getByRole("dialog");
  for (const line of before.content.snapshot.items)
    await expect(dialog.getByText(line.tlc, { exact: true })).toBeVisible();
  await page
    .getByRole("textbox", { name: "Reason", exact: true })
    .fill("Synthetic receipt withdrawn");
  await page.getByRole("button", { name: "Confirm void", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Retry current state", exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Retry same operation", exact: true })).toHaveCount(
    0,
  );
  await page.getByRole("button", { name: "Retry current state", exact: true }).click();
  await expect(page.getByText(/This receipt is void/)).toBeVisible();
  assert.equal(voidPosts, 1);
  assert.equal(reads, 2);
  await page.unroute(voidPattern);
  await page.unroute(currentPattern);
  const voided = await read(`receiving/${original.id}`);
  assert.equal(voided.lifecycle.currentEventId, null);
  assert.equal(voided.lifecycle.lifecycleVersion, before.lifecycle.lifecycleVersion + 3);
  for (let index = 0; index < lotIds.length; index++) {
    const basisAfter = await read(`lots/${lotIds[index]}/receiving-basis?limit=1&offset=0`);
    assert.equal(basisAfter.supportCount, 0);
    assert.equal(basisAfter.basisVersion, basesBefore[index].basisVersion + 1);
    const lotAfter = await read(`lots/${lotIds[index]}`);
    // Only the receiving-basis concurrency token changes; no business/identity field does.
    assert.deepEqual(lotAfter, lotsBefore[index]);
  }
  const audit = await fixture.pool.query(
    'SELECT organization_id, actor_user_id, action, outcome, target_type, target_id, "after" FROM tenant_audit_events WHERE organization_id=$1 AND action=ANY($2::text[]) AND target_id=ANY($3::text[]) ORDER BY created_at,id',
    [
      fixture.tenantId,
      ["traceability.receiving.amendment_started", "traceability.receiving.voided"],
      [original.id, started.eventId],
    ],
  );
  assert.equal(audit.rows.length, 3);
  for (const [index, record] of [started.record, cancelled, voided].entries()) {
    const row = audit.rows[index];
    assert.equal(row.organization_id, fixture.tenantId);
    assert.equal(row.actor_user_id, fixture.userId);
    assert.equal(
      row.action,
      index === 0 ? "traceability.receiving.amendment_started" : "traceability.receiving.voided",
    );
    assert.equal(row.outcome, "success");
    assert.equal(row.target_type, "traceability_event");
    assert.equal(row.target_id, record.id);
    assert.deepEqual(row.after, {
      rootId: before.lifecycle.rootId,
      revision: record.revision,
      reason:
        index === 0
          ? "Synthetic delivery correction"
          : index === 1
            ? "Synthetic correction cancelled"
            : "Synthetic receipt withdrawn",
      result: index === 0 ? "draft_started" : "voided",
      record,
    });
  }
  await page.getByRole("button", { name: "Back to receiving", exact: true }).click();
  await page.getByRole("button", { name: "← Profile", exact: true }).click();
  console.log(
    "Receiving lifecycle: real amend with lost-response replay, draft cancellation preserves basis, void with GET-only recovery, exact audits and unchanged lot identity/source/status; EN/ES light/dark dialog layouts 1440/1024/390 passed.",
  );
}
