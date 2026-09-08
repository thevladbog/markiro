import assert from "node:assert/strict";
import { join } from "node:path";

/** Read-only basis and exact-revision navigation over the owned synthetic API fixture. */
export async function exerciseUsLotReceivingBasis({ page, expect, screenshots, final }) {
  const base = "http://localhost:5174/api/us/traceability";
  const read = async (path) => {
    const response = await page.request.get(`${base}/${path}`);
    assert.equal(response.status(), 200);
    return response.json();
  };
  const lotId = final.content.snapshot.items[0].lotId;
  const before = await read(`lots/${lotId}`);
  const basis = await read(`lots/${lotId}/receiving-basis?limit=50&offset=0`);
  assert.equal(basis.state, "present");
  assert.equal(basis.supportCount, 1);
  assert.equal(basis.items[0].eventId, final.id);
  const writes = [];
  const observe = (request) => {
    if (request.url().startsWith(base) && !["GET", "HEAD"].includes(request.method()))
      writes.push({ method: request.method(), url: request.url() });
  };
  page.on("request", observe);
  try {
    const failBasis = (route) => route.fulfill({ status: 503, json: {} });
    const basisPattern = `${base}/lots/${lotId}/receiving-basis?*`;
    await page.route(basisPattern, failBasis);
    await page.getByRole("button", { name: "Lots", exact: true }).click();
    await page.getByRole("button", { name: before.tlc, exact: true }).click();
    const card = () => page.getByRole("region", { name: "Current receiving basis", exact: true });
    try {
      await expect(
        card().getByText("The receiving basis could not be loaded.", { exact: true }),
      ).toBeVisible();
      await expect(card().getByText("No current receiving basis", { exact: true })).toHaveCount(0);
    } finally {
      await page.unroute(basisPattern, failBasis);
    }
    await card().getByRole("button", { name: "Refresh receiving basis", exact: true }).click();
    await expect(card().getByText("Supporting revisions: 1", { exact: true })).toBeVisible();
    const revisionName = `${final.eventNumber} · Revision ${final.revision}`;
    let reads = 0;
    const failReceipt = (route) => {
      assert.equal(route.request().method(), "GET");
      reads += 1;
      return reads === 1 ? route.fulfill({ status: 503, json: {} }) : route.continue();
    };
    const receiptPath = `${base}/receiving/${final.id}`;
    await page.route(receiptPath, failReceipt);
    try {
      await card().getByRole("button", { name: revisionName, exact: true }).click();
      await expect(
        card().getByText(
          "This receiving revision could not be opened. Retry the revision or refresh its current basis.",
          { exact: true },
        ),
      ).toBeVisible();
      await expect(page.getByRole("heading", { name: before.tlc, exact: true })).toBeVisible();
      const link = card().getByRole("button", { name: revisionName, exact: true });
      await link.focus();
      await link.press("Enter");
      await expect(
        page.getByRole("heading", { name: final.eventNumber, exact: true }),
      ).toBeFocused();
      assert.equal(reads, 2);
    } finally {
      await page.unroute(receiptPath, failReceipt);
    }
    await page.getByRole("button", { name: "Back to lot", exact: true }).click();
    await expect(page.getByRole("heading", { name: before.tlc, exact: true })).toBeFocused();
    await expect(card().getByText("Supporting revisions: 1", { exact: true })).toBeVisible();
    await capture("present");

    await page.getByRole("button", { name: "← Back to lots", exact: true }).click();
    const unsupported = (
      await read(`lots?limit=50&offset=0&search=${encodeURIComponent("=Supplier-🍎")}`)
    ).items;
    assert.equal(unsupported.length, 1);
    const missingLot = await read(`lots/${unsupported[0].id}`);
    assert.equal(
      (await read(`lots/${missingLot.id}/receiving-basis?limit=50&offset=0`)).state,
      "missing",
    );
    await page.getByRole("button", { name: missingLot.tlc, exact: true }).click();
    await expect(card().getByText("No current receiving basis", { exact: true })).toBeVisible();
    await capture("missing");
    assert.deepEqual(await read(`lots/${lotId}`), before);
    assert.deepEqual(await read(`lots/${missingLot.id}`), missingLot);
    assert.deepEqual(await read(`receiving/${final.id}`), final);
    assert.deepEqual(writes, []);
  } finally {
    page.off("request", observe);
  }

  async function capture(state) {
    for (const locale of ["en", "es"]) {
      if (locale === "es")
        await page.getByRole("button", { name: "Language", exact: true }).click();
      const card = page.getByRole("region", {
        name: locale === "en" ? "Current receiving basis" : "Base de recepción vigente",
        exact: true,
      });
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
          await expect(card).toBeVisible();
          assert.equal(
            await card.evaluate((element) => element.scrollWidth <= element.clientWidth),
            true,
          );
          assert.equal(
            await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
            true,
          );
          if (width === 390)
            for (const button of await card.getByRole("button").all()) {
              const box = await button.boundingBox();
              assert.ok(box && box.height >= 44, "Basis actions must be at least 44px tall");
            }
          await card.screenshot({
            path: join(screenshots, `lot-receiving-basis-${state}-${locale}-${theme}-${width}.png`),
          });
        }
      }
      await page
        .getByRole("button", {
          name: locale === "en" ? "Change theme" : "Cambiar tema",
          exact: true,
        })
        .click();
    }
    await page.getByRole("button", { name: "Idioma", exact: true }).click();
    await page.setViewportSize({ width: 1440, height: 900 });
  }
  console.log(
    "Lot receiving basis: real present/missing support, GET failures and exact retry, lot return, unchanged lot/receipt, no business writes; EN/ES light/dark 1440/1024/390 passed.",
  );
}
