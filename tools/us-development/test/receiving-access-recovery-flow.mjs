import assert from "node:assert/strict";

/** Real reads and authorization decisions; only response delivery is held. */
export async function exerciseUsReceivingAccessRecovery({ page, expect, fixture, original }) {
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
    await page.getByRole("button", { name: "Back to receiving", exact: true }).click();
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
    await page.getByRole("button", { name: "Receiving", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Receiving", exact: true })).toBeVisible();
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
          page.getByRole("button", { name: "Back to receiving", exact: true }),
        ).toBeEnabled();
        assert.deepEqual(await read(target), before);
        assert.deepEqual(await auditRows(), auditBefore);
      } finally {
        await fixture.pool.query(
          "UPDATE member SET role=$3 WHERE organization_id=$1 AND user_id=$2",
          [fixture.tenantId, fixture.userId, roleBefore],
        );
      }
      // Explicit workspace re-entry reloads current capabilities, never the old command.
      await page.getByRole("button", { name: "← Profile", exact: true }).click();
      await page.getByRole("button", { name: "Open reference data", exact: true }).click();
      await page.getByRole("button", { name: "Receiving", exact: true }).click();
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
  console.log(
    "Receiving recovery: late detail read cannot reopen a departed view; real QA revoke denies amend/void, clears command and reason, explicit access restoration starts empty; unchanged receipt/audit passed.",
  );
}
