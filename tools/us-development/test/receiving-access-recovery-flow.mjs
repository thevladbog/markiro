import assert from "node:assert/strict";
import { join } from "node:path";

/** Real reads and authorization decisions; only response delivery is held. */
export async function exerciseUsReceivingAccessRecovery({
  page,
  expect,
  screenshots,
  fixture,
  original,
}) {
  const base = "http://localhost:5174/api/us/traceability";
  const target = `${base}/receiving/${original.id}`;
  const read = async (url) => {
    const response = await page.request.get(url);
    assert.equal(response.status(), 200);
    return response.json();
  };
  const before = await read(target);
  const auditRows = async () =>
    (
      await fixture.pool.query(
        "SELECT * FROM tenant_audit_events WHERE organization_id=$1 ORDER BY created_at,id",
        [fixture.tenantId],
      )
    ).rows;
  const auditBefore = await auditRows();
  const writes = [];
  const observe = (request) => {
    if (request.url().startsWith(base) && !["GET", "HEAD"].includes(request.method()))
      writes.push({ url: request.url(), method: request.method() });
  };
  page.on("request", observe);
  try {
    // A late registry-detail read cannot reopen a receipt after leaving the workspace view.
    await page.getByRole("button", { name: "Back to events", exact: true }).click();
    const delivery = Promise.withResolvers();
    let fetched = false;
    const hold = async (route) => {
      assert.equal(route.request().method(), "GET");
      const response = await route.fetch();
      assert.equal(response.status(), 200);
      fetched = true;
      await delivery.promise;
      await route.fulfill({ response });
    };
    await page.route(target, hold);
    try {
      await page.getByRole("button", { name: original.eventNumber, exact: true }).click();
      await expect.poll(() => fetched).toBe(true);
      await page.getByRole("button", { name: "Products", exact: true }).click();
      await expect(page.getByRole("heading", { name: "Products", exact: true })).toBeVisible();
      const received = page.waitForResponse(target);
      delivery.resolve();
      assert.equal(await (await received).finished(), null);
      await expect(page.getByRole("heading", { name: "Products", exact: true })).toBeVisible();
      await expect(
        page.getByRole("heading", { name: original.eventNumber, exact: true }),
      ).toHaveCount(0);
    } finally {
      delivery.resolve();
      await page.unroute(target, hold);
    }
    await page.getByRole("button", { name: "Events", exact: true }).click();
    await page.getByRole("combobox", { name: "Event type", exact: true }).click();
    await page.getByRole("option", { name: "Receiving", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Events", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Correct receipt", exact: true })).toHaveCount(0);
    await page.getByRole("button", { name: original.eventNumber, exact: true }).click();

    const membership = await fixture.pool.query(
      "SELECT role FROM member WHERE organization_id=$1 AND user_id=$2",
      [fixture.tenantId, fixture.userId],
    );
    assert.equal(membership.rows.length, 1);
    const roleBefore = membership.rows[0].role;
    for (const [action, label, submit] of [
      ["amend", "Correct receipt", "Start correction"],
      ["void", "Void receipt", "Confirm void"],
    ]) {
      await page.getByRole("button", { name: label, exact: true }).click();
      const dialog = page.getByRole("dialog", { name: label, exact: true });
      if (action === "void")
        await expect(
          dialog.getByRole("heading", {
            name: "Lots losing their last receiving basis",
            exact: true,
          }),
        ).toBeVisible();
      await dialog
        .getByRole("textbox", { name: "Reason", exact: true })
        .fill(`Synthetic revoked QA ${action}`);
      await fixture.pool.query(
        "UPDATE member SET role='traceability_receiving' WHERE organization_id=$1 AND user_id=$2",
        [fixture.tenantId, fixture.userId],
      );
      try {
        const denied = page.waitForResponse(`${target}/${action}`);
        const refreshed = page.waitForResponse(`${base}/access`);
        await dialog.getByRole("button", { name: submit, exact: true }).click();
        assert.equal((await denied).status(), 403);
        assert.equal((await refreshed).status(), 200);
        await expect(dialog).toHaveCount(0);
        for (const name of ["Correct receipt", "Void receipt", "Retry same operation"])
          await expect(page.getByRole("button", { name, exact: true })).toHaveCount(0);
        await expect(
          page.getByRole("button", { name: "Back to events", exact: true }),
        ).toBeEnabled();
        assert.deepEqual(await read(target), before);
        assert.deepEqual(await auditRows(), auditBefore);
        await capture(action, "denied");
      } finally {
        await fixture.pool.query(
          "UPDATE member SET role=$3 WHERE organization_id=$1 AND user_id=$2",
          [fixture.tenantId, fixture.userId, roleBefore],
        );
      }
      // Explicit workspace re-entry reloads current capabilities, never the old command.
      await page.getByRole("button", { name: "← Profile", exact: true }).click();
      await page.getByRole("button", { name: "Open reference data", exact: true }).click();
      await page.getByRole("button", { name: "Events", exact: true }).click();
      await page.getByRole("combobox", { name: "Event type", exact: true }).click();
      await page.getByRole("option", { name: "Receiving", exact: true }).click();
      await page.getByRole("button", { name: original.eventNumber, exact: true }).click();
      await expect(page.getByRole("dialog")).toHaveCount(0);
      await page.getByRole("button", { name: label, exact: true }).click();
      if (action === "void")
        await expect(
          dialog.getByRole("heading", {
            name: "Lots losing their last receiving basis",
            exact: true,
          }),
        ).toBeVisible();
      await expect(dialog.getByRole("textbox", { name: "Reason", exact: true })).toHaveValue("");
      await expect(dialog.getByRole("button", { name: submit, exact: true })).toBeDisabled();
      await page.keyboard.press("Escape");
      await expect(dialog).toHaveCount(0);
      await capture(action, "restored");
    }
    assert.deepEqual(
      writes,
      ["amend", "void"].map((action) => ({ url: `${target}/${action}`, method: "POST" })),
    );
    assert.deepEqual(await read(target), before);
    assert.deepEqual(await auditRows(), auditBefore);
  } finally {
    page.off("request", observe);
  }

  async function capture(action, state) {
    for (const locale of ["en", "es"]) {
      if (locale === "es")
        await page.getByRole("button", { name: "Language", exact: true }).click();
      await expect(page.locator("html")).toHaveAttribute("lang", `${locale}-US`);
      const amend = locale === "en" ? "Correct receipt" : "Corregir recepción";
      const voidLabel = locale === "en" ? "Void receipt" : "Anular recepción";
      const label = action === "amend" ? amend : voidLabel;
      const themeControl = page.getByRole("button", {
        name: locale === "en" ? "Change theme" : "Cambiar tema",
        exact: true,
      });
      const dialog = page.getByRole("dialog", { name: label, exact: true });
      const notice = page.getByRole("alert").filter({
        hasText:
          locale === "en"
            ? "Your write access changed. The record was not saved."
            : "Su acceso de escritura cambió. El registro no se guardó.",
      });
      for (const theme of ["light", "dark"]) {
        if (theme === "dark") await themeControl.click();
        await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
        if (state === "restored") {
          await expect(notice).toHaveCount(0);
          await page.getByRole("button", { name: label, exact: true }).click();
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
        }
        for (const width of [1440, 1024, 390]) {
          const height = width === 390 ? 844 : 900;
          await page.setViewportSize({ width, height });
          const region = state === "denied" ? notice : dialog;
          await expect(region).toBeVisible();
          if (state === "denied") {
            await expect(page.getByRole("dialog")).toHaveCount(0);
            for (const name of [
              amend,
              voidLabel,
              locale === "en" ? "Retry same operation" : "Reintentar la misma operación",
            ])
              await expect(page.getByRole("button", { name, exact: true })).toHaveCount(0);
            await expect(
              page.getByRole("button", {
                name: locale === "en" ? "Back to events" : "Volver a eventos",
                exact: true,
              }),
            ).toBeEnabled();
            await notice.scrollIntoViewIfNeeded();
            await expect(notice).toBeInViewport({ ratio: 1 });
          } else {
            const reason = dialog.getByRole("textbox", {
              name: locale === "en" ? "Reason" : "Motivo",
              exact: true,
            });
            await expect(reason).toHaveValue("");
            await reason.focus();
            await expect(reason).toBeFocused();
            const confirm = dialog.getByRole("button", {
              name:
                action === "amend"
                  ? locale === "en"
                    ? "Start correction"
                    : "Iniciar corrección"
                  : locale === "en"
                    ? "Confirm void"
                    : "Confirmar anulación",
              exact: true,
            });
            await expect(confirm).toBeDisabled();
            const box = await confirm.boundingBox();
            assert.ok(
              box && box.y >= 0 && box.y + box.height <= height,
              "Restored QA confirmation footer must fit the viewport",
            );
          }
          assert.equal(
            await region.evaluate((element) => element.scrollWidth <= element.clientWidth),
            true,
          );
          assert.equal(
            await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
            true,
          );
          await page.screenshot({
            path: join(
              screenshots,
              `receiving-access-${action}-${state}-${locale}-${theme}-${width}.png`,
            ),
          });
        }
        if (state === "restored") {
          await page.keyboard.press("Escape");
          await expect(dialog).toHaveCount(0);
        }
      }
      await themeControl.click();
    }
    await page.getByRole("button", { name: "Idioma", exact: true }).click();
    await page.setViewportSize({ width: 1440, height: 900 });
  }
  console.log(
    "Receiving recovery: late detail read cannot reopen a departed view; real QA revoke denies amend/void, clears command and reason, explicit access restoration starts empty; unchanged receipt/audit and denied/restored EN/ES light/dark 1440/1024/390 passed.",
  );
}
