import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { expectUsBrand } from "./brand-flow.mjs";
import { exerciseUsReceivingFinalization } from "./receiving-finalization-flow.mjs";
import { exerciseUsReceivingExemption } from "./receiving-exemption-flow.mjs";

/** Real saved drafts; only the first response is intentionally lost after server commit. */
export async function exerciseUsReceiving({ page, expect, screenshots, fixture }) {
  await page.getByRole("button", { name: "Open reference data", exact: true }).click();
  await page.getByRole("button", { name: "Receiving", exact: true }).click();
  await expect(page.getByText("No receiving records match this search.")).toBeVisible();
  await page.getByRole("button", { name: "New receiving", exact: true }).click();
  await page.getByLabel("Date received", { exact: true }).fill("2026-09-07");
  await page.getByLabel("Dock / note", { exact: true }).fill("Dock 2");
  await page
    .getByRole("textbox", { name: "Receiving notes", exact: true })
    .fill("Supplier delivery awaiting remaining details");
  await page
    .getByLabel("Immediate previous source", { exact: true })
    .selectOption({ label: "Synthetic receiving dock" });
  await page.getByRole("button", { name: "Add line", exact: true }).click();
  await page
    .getByLabel("Product", { exact: true })
    .selectOption({ label: "Fresh-Cut Apple Slices" });
  await page.getByLabel("Lot code (TLC)", { exact: true }).fill("OSS-260907-A1");
  await page.getByLabel("Quantity", { exact: true }).fill("500.000");
  await page.getByLabel("Unit", { exact: true }).selectOption("lb");
  await page.getByRole("checkbox", { name: "Exempt supplier", exact: true }).check();
  await page
    .getByRole("textbox", { name: "Exemption reason", exact: true })
    .fill("Supplier declaration recorded for review");
  await page.getByRole("button", { name: "Add line", exact: true }).click();
  await page.getByLabel("Lot code (TLC)", { exact: true }).fill("OSS-260907-A2");
  await page.getByLabel("Quantity", { exact: true }).fill("25.500");
  await page.getByLabel("Unit", { exact: true }).selectOption("case");

  await page.getByText("Create document metadata", { exact: true }).click();
  await page.getByLabel("Document number", { exact: true }).fill("BOL-260907-RECEIVING");
  const documentResponse = page.waitForResponse(
    (r) => r.url().endsWith("/reference-documents") && r.request().method() === "POST",
  );
  void documentResponse.catch(() => {});
  await page.getByRole("button", { name: "Create and attach", exact: true }).click();
  assert.equal((await documentResponse).status(), 201);
  await expect(page.getByText("Document created and attached.", { exact: true })).toBeVisible();

  const routePattern = "**/api/us/traceability/receiving";
  const attempts = [];
  let committed;
  const loseFirstResponse = async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    attempts.push(route.request().postDataJSON());
    if (attempts.length === 1) {
      const response = await route.fetch();
      assert.equal(response.status(), 201);
      const acknowledgement = await response.json();
      assert.equal(acknowledgement.receiptVersion, 2);
      assert.equal(acknowledgement.command, "receiving.create");
      committed = acknowledgement.record;
      return route.abort("failed");
    }
    return route.continue();
  };
  await page.route(routePattern, loseFirstResponse);
  await page.getByRole("button", { name: "Save draft", exact: true }).click();
  await expect(page.getByRole("button", { name: "Retry same save", exact: true })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Receiving notes", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "Retry same save", exact: true }).click();
  await expect(page.getByText("Draft saved.", { exact: true })).toBeVisible();
  await page.unroute(routePattern, loseFirstResponse);
  assert.equal(attempts.length, 2);
  assert.deepEqual(attempts[0], attempts[1]);
  assert.ok(committed?.id);
  assert.equal(committed.content.draft.items.length, 2);
  assert.equal(committed.content.draft.items[0].quantity, "500.000");
  assert.equal(committed.content.draft.items[0].tlc, "OSS-260907-A1");
  assert.equal(committed.content.draft.items[0].source, null);
  assert.equal(committed.content.draft.documentIds.length, 1);
  await expect(
    page.getByRole("heading", { name: committed.eventNumber, exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: /finalize|import|delete/i })).toHaveCount(0);

  // Leave and reload the application, then reopen the server record.
  await page.getByRole("button", { name: "Back to receiving", exact: true }).click();
  await expect(
    page.getByRole("button", { name: committed.eventNumber, exact: true }),
  ).toBeVisible();
  await page.screenshot({
    path: join(screenshots, "receiving-list-en.png"),
    fullPage: true,
    animations: "disabled",
  });
  await page.reload();
  await page.getByRole("button", { name: "Open reference data", exact: true }).click();
  await page.getByRole("button", { name: "Receiving", exact: true }).click();
  await page.getByRole("button", { name: committed.eventNumber, exact: true }).click();
  await expect(page.getByLabel("Quantity", { exact: true })).toHaveValue("500.000");
  await expect(page.getByText("BOL-260907-RECEIVING", { exact: true }).first()).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Exemption reason", exact: true })).toHaveValue(
    "Supplier declaration recorded for review",
  );

  // Readiness is an explicit read of the saved version, never a draft mutation.
  const checkSaved = async (version) => {
    const response = page.waitForResponse(
      (r) =>
        r.url().endsWith(`/receiving/${committed.id}/readiness?expectedDraftVersion=${version}`) &&
        r.request().method() === "GET",
    );
    void response.catch(() => {});
    await page.getByRole("button", { name: "Check saved draft", exact: true }).click();
    const checked = await response;
    assert.equal(checked.status(), 200);
    const result = await checked.json();
    assert.equal(result.eventId, committed.id);
    assert.equal(result.draftVersion, version);
    assert.equal(result.ruleVersion, "receiving-readiness-v4");
    assert.equal(result.expectedLifecycleVersion, 1);
    assert.equal(result.state, "blocked");
    assert.match(result.inputDigest, /^[a-f0-9]{64}$/);
    assert.ok(
      result.issues.some((issue) => issue.field === "location" && issue.code === "required"),
    );
    assert.deepEqual(result.exemptReviewRequiredLines, [1]);
    await expect(page.getByText(/required elements need attention\./)).toBeVisible();
    return result;
  };
  const readiness1 = await checkSaved(1);
  const notes = page.getByRole("textbox", { name: "Receiving notes", exact: true });
  await notes.fill("Unsaved readiness change");
  await expect(
    page.getByText("Previous check is out of date. Check the saved draft again."),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Check saved draft", exact: true })).toBeDisabled();
  await notes.fill("Supplier delivery awaiting remaining details");
  await expect(
    page.getByText("Previous check is out of date. Check the saved draft again."),
  ).toBeVisible();
  const readinessAgain = await checkSaved(1);
  assert.equal(readinessAgain.inputDigest, readiness1.inputDigest);

  for (const locale of ["en", "es"]) {
    if (locale === "es") await page.getByRole("button", { name: "Language", exact: true }).click();
    const readinessPanel = page.getByRole("region", {
      name: locale === "en" ? "Saved-draft data check" : "Revisión de datos del borrador guardado",
      exact: true,
    });
    await expect(
      readinessPanel.getByRole("heading", {
        name: locale === "en" ? "Header" : "Cabecera",
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      readinessPanel.getByRole("heading", {
        name: locale === "en" ? "Lines" : "Líneas",
        exact: true,
      }),
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
        await expectUsBrand({ page, expect });
        await expect
          .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
          .toBe(true);
        await page.evaluate(() => document.fonts.ready);
        // Every finding and the scope note remain readable above the sticky save bar.
        for (const finding of await readinessPanel.locator("li, .us-rec-readiness-scope").all()) {
          // Viewport intersection alone ignores the sticky footer's occlusion.
          await finding.evaluate((element) => element.scrollIntoView({ block: "center" }));
          await expect
            .poll(async () => {
              const content = await finding.boundingBox();
              const footer = await page.locator(".us-rec-save").boundingBox();
              return {
                locale,
                theme,
                width,
                content,
                footer,
                readable:
                  content !== null && footer !== null && content.y + content.height <= footer.y,
              };
            })
            .toEqual(expect.objectContaining({ readable: true }));
        }
        await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
        await page.screenshot({
          path: join(screenshots, `receiving-draft-${locale}-${theme}-${width}.png`),
          fullPage: true,
          animations: "disabled",
        });
        await page.screenshot({
          path: join(screenshots, `receiving-readiness-${locale}-${theme}-${width}.png`),
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

  // A second writer saves while this editor holds version 1.
  const otherDraft = { ...committed.content.draft, notes: "Saved in another editor" };
  const concurrent = await page.request.put(
    `http://localhost:5174/api/us/traceability/receiving/${committed.id}`,
    {
      headers: { Origin: "http://localhost:5174" },
      data: { operationKey: randomUUID(), expectedDraftVersion: 1, draft: otherDraft },
    },
  );
  assert.equal(concurrent.status(), 200);
  const saveReceipt = await concurrent.json();
  assert.equal(saveReceipt.receiptVersion, 2);
  const version2 = saveReceipt.record;
  await page
    .getByRole("textbox", { name: "Receiving notes", exact: true })
    .fill("My local edits are still here");
  await page.getByRole("button", { name: "Save draft", exact: true }).click();
  await expect(page.getByRole("button", { name: "Reload saved draft", exact: true })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Receiving notes", exact: true })).toHaveValue(
    "My local edits are still here",
  );
  await page.screenshot({
    path: join(screenshots, "receiving-conflict-en.png"),
    fullPage: true,
    animations: "disabled",
  });
  page.once("dialog", (dialog) => dialog.dismiss());
  await page.getByRole("button", { name: "Reload saved draft", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "Receiving notes", exact: true })).toHaveValue(
    "My local edits are still here",
  );
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Reload saved draft", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "Receiving notes", exact: true })).toHaveValue(
    "Saved in another editor",
  );
  const readiness2 = await checkSaved(2);
  assert.notEqual(readiness2.inputDigest, readiness1.inputDigest);
  const audits = await fixture.pool.query(
    'SELECT organization_id, actor_user_id, action, outcome, target_type, target_id, "before", "after" FROM tenant_audit_events WHERE organization_id=$1 AND target_id=$2 ORDER BY created_at,id',
    [fixture.tenantId, committed.id],
  );
  assert.equal(audits.rows.length, 2);
  for (const row of audits.rows) {
    assert.equal(row.organization_id, fixture.tenantId);
    assert.equal(row.actor_user_id, fixture.userId);
    assert.equal(row.outcome, "success");
    assert.equal(row.target_type, "traceability_event");
    assert.equal(row.target_id, committed.id);
  }
  assert.equal(audits.rows[0].action, "traceability.receiving.draft_created");
  assert.equal(audits.rows[0].before, null);
  assert.deepEqual(audits.rows[0].after, committed);
  assert.equal(audits.rows[1].action, "traceability.receiving.draft_saved");
  assert.deepEqual(audits.rows[1].before, committed);
  assert.deepEqual(audits.rows[1].after, version2);
  const events = await fixture.pool.query("SELECT id FROM traceability_events WHERE tenant_id=$1", [
    fixture.tenantId,
  ]);
  assert.deepEqual(events.rows, [{ id: committed.id }]);
  await page.getByRole("button", { name: "Back to receiving", exact: true }).click();
  await page.getByRole("button", { name: "← Profile", exact: true }).click();
  await exerciseUsReceivingFinalization({ page, expect, screenshots, fixture });
  await exerciseUsReceivingExemption({ page, expect, screenshots, fixture });
}
