import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { transformationGenealogyRequestSchema } from "../../../packages/platform-contracts/dist/index.js";
import { isBoundedGenealogyRead } from "./genealogy-read-observer.mjs";

/** Two independent receipts support one lot; only real authenticated commands change them. */
export async function exerciseUsMultipleReceivingBasis({
  page,
  expect,
  screenshots,
  fixture,
  final,
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
    assert.equal(response.status(), status);
    return response.json();
  };
  const snapshot = final.content.snapshot;
  const item = snapshot.items[2];
  assert.ok(item, "The existing mixed receipt must contain its ordinary third line");
  const lotBefore = await read(`lots/${item.lotId}`);
  const basisPath = `lots/${item.lotId}/receiving-basis?limit=50&offset=0`;
  const originalBasis = await read(basisPath);
  assert.equal(originalBasis.supportCount, 1);
  assert.equal(originalBasis.items[0].eventId, final.id);
  const created = await post(
    "receiving",
    {
      operationKey: randomUUID(),
      draft: {
        dateReceived: snapshot.dateReceived,
        locationId: snapshot.locationId,
        previousSourceLocationId: snapshot.previousSourceLocationId,
        receivedAtNote: "Synthetic independent receiving support",
        notes: null,
        documentIds: snapshot.documents.map(({ document }) => document.documentId),
        items: [
          {
            productId: item.productId,
            lotId: item.lotId,
            lotLinkMode: "link_existing",
            tlc: item.tlc,
            source: item.source,
            quantity: item.quantity,
            unitOfMeasure: item.unitOfMeasure,
            supplierLotReference: item.supplierLotReference,
            notes: null,
            exemptSupplier: false,
            exemptReason: null,
          },
        ],
      },
    },
    201,
  );
  const readiness = await read(`receiving/${created.eventId}/readiness?expectedDraftVersion=1`);
  assert.equal(readiness.state, "complete");
  assert.deepEqual(readiness.exemptReviewRequiredLines, []);
  const second = (
    await post(
      `receiving/${created.eventId}/finalize`,
      {
        operationKey: randomUUID(),
        expectedDraftVersion: 1,
        expectedInputDigest: readiness.inputDigest,
        reviewedExemptLines: [],
      },
      200,
    )
  ).record;
  assert.notEqual(second.lifecycle.rootId, final.lifecycle.rootId);
  const two = await read(basisPath);
  assert.equal(two.state, "present");
  assert.equal(two.supportCount, 2);
  assert.deepEqual(two.items.map(({ eventId }) => eventId).sort(), [final.id, second.id].sort());
  assert.equal(two.basisVersion, originalBasis.basisVersion + 1);

  await page.getByRole("button", { name: "← Back to lots", exact: true }).click();
  await page.getByRole("button", { name: lotBefore.tlc, exact: true }).click();
  const card = page.getByRole("region", { name: "Current receiving basis", exact: true });
  await expect(card.getByText("Supporting revisions: 2", { exact: true })).toBeVisible();
  for (const record of [final, second])
    await expect(
      card.getByRole("button", {
        name: `${record.eventNumber} · Revision ${record.revision}`,
        exact: true,
      }),
    ).toBeVisible();
  await capture("two");
  const writes = [];
  const genealogyReads = [];
  const observe = (request) => {
    if (isBoundedGenealogyRead(request, base)) {
      genealogyReads.push(request.postDataJSON());
      return;
    }
    if (request.url().startsWith(base) && !["GET", "HEAD"].includes(request.method()))
      writes.push({ url: request.url(), method: request.method() });
  };
  page.on("request", observe);
  const voidedRecords = [];
  try {
    for (const [index, record] of [final, second].entries()) {
      await card
        .getByRole("button", {
          name: `${record.eventNumber} · Revision ${record.revision}`,
          exact: true,
        })
        .click();
      await expect(
        page.getByRole("heading", { name: record.eventNumber, exact: true }),
      ).toBeFocused();
      await capture(index === 0 ? "before-first" : "before-last", true);
      await page.getByRole("button", { name: "Void receipt", exact: true }).click();
      const dialog = page.getByRole("dialog", { name: "Void receipt", exact: true });
      await expect(
        dialog.getByRole("heading", {
          name: "Lots losing their last receiving basis",
          exact: true,
        }),
      ).toBeVisible();
      if (index === 0) await expect(dialog.getByText(item.tlc, { exact: true })).toHaveCount(0);
      else await expect(dialog.getByText(item.tlc, { exact: true })).toBeVisible();
      await dialog
        .getByRole("textbox", { name: "Reason", exact: true })
        .fill(
          index === 0 ? "Synthetic first support withdrawn" : "Synthetic last support withdrawn",
        );
      await dialog.getByRole("button", { name: "Confirm void", exact: true }).click();
      await expect(page.getByText(/This receipt is void/)).toBeVisible();
      const voided = await read(`receiving/${record.id}`);
      assert.equal(voided.status, "void");
      assert.deepEqual(voided.content, record.content);
      assert.equal(voided.lifecycle.lifecycleVersion, record.lifecycle.lifecycleVersion + 1);
      voidedRecords.push(voided);
      await page.getByRole("button", { name: "Back to lot", exact: true }).click();
      await expect(page.getByRole("heading", { name: lotBefore.tlc, exact: true })).toBeFocused();
      const basis = await read(basisPath);
      assert.equal(basis.supportCount, 1 - index);
      assert.equal(basis.state, index === 0 ? "present" : "missing");
      assert.equal(basis.basisVersion, two.basisVersion + index + 1);
      assert.deepEqual(await read(`lots/${item.lotId}`), lotBefore);
      if (index === 0) {
        assert.deepEqual(
          basis.items.map(({ eventId }) => eventId),
          [second.id],
        );
        await expect(card.getByText("Supporting revisions: 1", { exact: true })).toBeVisible();
        await expect(
          card.getByRole("button", {
            name: `${final.eventNumber} · Revision ${final.revision}`,
            exact: true,
          }),
        ).toHaveCount(0);
        await expect(
          card.getByRole("button", {
            name: `${second.eventNumber} · Revision ${second.revision}`,
            exact: true,
          }),
        ).toBeVisible();
      } else {
        assert.deepEqual(basis.items, []);
        await expect(card.getByText("No current receiving basis", { exact: true })).toBeVisible();
        await expect(card.getByRole("listitem")).toHaveCount(0);
      }
      await capture(index === 0 ? "one" : "none");
    }
    assert.ok(genealogyReads.length > 0);
    for (const body of genealogyReads) {
      assert.equal(transformationGenealogyRequestSchema.safeParse(body).success, true);
      assert.deepEqual(body, {
        startLotId: item.lotId,
        mode: "current",
        direction: "upstream",
        maxDepth: 4,
        maxNodes: 100,
      });
    }
    assert.deepEqual(
      writes,
      [final, second].map(({ id }) => ({ url: `${base}/receiving/${id}/void`, method: "POST" })),
    );
  } finally {
    page.off("request", observe);
  }
  const audit = await fixture.pool.query(
    'SELECT organization_id, actor_user_id, action, outcome, target_type, target_id, "before", "after" FROM tenant_audit_events WHERE organization_id=$1 AND action=$2 AND target_id=ANY($3::text[]) ORDER BY created_at,id',
    [fixture.tenantId, "traceability.receiving.voided", [final.id, second.id]],
  );
  assert.deepEqual(
    audit.rows,
    [final, second].map((record, index) => ({
      organization_id: fixture.tenantId,
      actor_user_id: fixture.userId,
      action: "traceability.receiving.voided",
      outcome: "success",
      target_type: "traceability_event",
      target_id: record.id,
      before: record,
      after: {
        rootId: record.lifecycle.rootId,
        revision: record.revision,
        reason:
          index === 0 ? "Synthetic first support withdrawn" : "Synthetic last support withdrawn",
        result: "voided",
        record: voidedRecords[index],
      },
    })),
  );

  async function capture(state, preview = false) {
    for (const locale of ["en", "es"]) {
      if (locale === "es")
        await page.getByRole("button", { name: "Language", exact: true }).click();
      const regionName = preview
        ? locale === "en"
          ? "Void receipt"
          : "Anular recepción"
        : locale === "en"
          ? "Current receiving basis"
          : "Base de recepción vigente";
      const region = page.getByRole(preview ? "dialog" : "region", {
        name: regionName,
        exact: true,
      });
      const themeControl = page.getByRole("button", {
        name: locale === "en" ? "Change theme" : "Cambiar tema",
        exact: true,
      });
      for (const theme of ["light", "dark"]) {
        if (theme === "dark") await themeControl.click();
        if (preview) {
          await page.getByRole("button", { name: regionName, exact: true }).click();
          await expect(
            region.getByRole("heading", {
              name:
                locale === "en"
                  ? "Lots losing their last receiving basis"
                  : "Lotes que pierden su último respaldo de recepción",
              exact: true,
            }),
          ).toBeVisible();
        }
        for (const width of [1440, 1024, 390]) {
          const height = width === 390 ? 844 : 900;
          await page.setViewportSize({ width, height });
          await region.scrollIntoViewIfNeeded();
          if (preview) {
            if (state === "before-first")
              await expect(region.getByText(item.tlc, { exact: true })).toHaveCount(0);
            else await expect(region.getByText(item.tlc, { exact: true })).toBeVisible();
            const reason = region.getByRole("textbox", {
              name: locale === "en" ? "Reason" : "Motivo",
              exact: true,
            });
            await reason.focus();
            await expect(reason).toBeFocused();
            const confirm = region.getByRole("button", {
              name: locale === "en" ? "Confirm void" : "Confirmar anulación",
              exact: true,
            });
            await expect(confirm).toBeDisabled();
            const box = await confirm.boundingBox();
            assert.ok(
              box && box.y >= 0 && box.y + box.height <= height,
              "Void confirmation footer must fit the viewport",
            );
          } else {
            const count = state === "two" ? 2 : state === "one" ? 1 : 0;
            await expect(region.getByRole("listitem")).toHaveCount(count);
            await expect(
              region.getByText(
                count
                  ? `${locale === "en" ? "Supporting revisions" : "Revisiones de respaldo"}: ${count}`
                  : locale === "en"
                    ? "No current receiving basis"
                    : "Sin base de recepción vigente",
                { exact: true },
              ),
            ).toBeVisible();
            for (const record of state === "two"
              ? [final, second]
              : state === "one"
                ? [second]
                : []) {
              const link = region.getByRole("button", {
                name: `${record.eventNumber} · ${locale === "en" ? "Revision" : "Revisión"} ${record.revision}`,
                exact: true,
              });
              await link.focus();
              await expect(link).toBeFocused();
              if (width === 390) {
                const box = await link.boundingBox();
                assert.ok(box && box.height >= 44, "Mobile revision link needs a 44px target");
              }
            }
          }
          assert.equal(
            await region.evaluate((element) => element.scrollWidth <= element.clientWidth),
            true,
          );
          assert.equal(
            await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
            true,
          );
          await region.screenshot({
            path: join(screenshots, `lot-multiple-basis-${state}-${locale}-${theme}-${width}.png`),
          });
        }
        if (preview) {
          await page.keyboard.press("Escape");
          await expect(region).toHaveCount(0);
        }
      }
      await themeControl.click();
    }
    await page.getByRole("button", { name: "Idioma", exact: true }).click();
    await page.setViewportSize({ width: 1440, height: 900 });
  }
  console.log(
    "Multiple receiving basis: two independent roots, first void preserves exact remaining link, last void removes support, correct last-basis previews, unchanged lot and frozen receipts, two exact audits; all five states EN/ES light/dark 1440/1024/390 passed.",
  );
}
