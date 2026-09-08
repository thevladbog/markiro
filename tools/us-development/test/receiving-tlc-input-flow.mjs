import assert from "node:assert/strict";

/** Native input must preserve valid Unicode; the shared draft contract rejects overflow. */
export async function exerciseUsReceivingTlcInput({ page, expect }) {
  const base = "http://localhost:5174/api/us/traceability/receiving";
  await page.getByRole("button", { name: "Open reference data", exact: true }).click();
  await page.getByRole("button", { name: "Receiving", exact: true }).click();
  await page.getByRole("button", { name: "New receiving", exact: true }).click();
  await page.getByRole("button", { name: "Add line", exact: true }).click();
  const tlc = page.getByRole("textbox", { name: "Lot code (TLC)", exact: true });
  const valid = "𐐀".repeat(120);
  await tlc.click();
  await tlc.pressSequentially(valid);
  await expect(tlc).toHaveValue(valid);
  const created = page.waitForResponse(
    (response) => response.url() === base && response.request().method() === "POST",
  );
  void created.catch(() => {});
  await page.getByRole("button", { name: "Save draft", exact: true }).click();
  const response = await created;
  assert.equal(response.status(), 201);
  const receipt = await response.json();
  assert.equal(receipt.record.content.draft.items[0].tlc, valid);
  await expect(page.getByText("Draft saved.", { exact: true })).toBeVisible();
  const currentResponse = await page.request.get(`${base}/${receipt.eventId}`);
  assert.equal(currentResponse.status(), 200);
  const before = await currentResponse.json();
  assert.equal(before.content.draft.items[0].tlc, valid);

  const writes = [];
  const observe = (request) => {
    if (
      request.url().startsWith(base) &&
      ["POST", "PUT", "PATCH", "DELETE"].includes(request.method())
    )
      writes.push(request.method());
  };
  page.on("request", observe);
  try {
    await tlc.press("End");
    await tlc.pressSequentially("𐐀");
    await expect(tlc).toHaveValue("𐐀".repeat(121));
    await page.getByRole("button", { name: "Save draft", exact: true }).click();
    await expect(
      page.getByText("Check the format of these fields:", { exact: true }),
    ).toBeVisible();
    await expect(page.getByText("Line 1: Lot code (TLC)", { exact: true })).toBeVisible();
    const afterResponse = await page.request.get(`${base}/${receipt.eventId}`);
    assert.equal(afterResponse.status(), 200);
    assert.deepEqual(await afterResponse.json(), before);
    assert.deepEqual(writes, []);
    await expect(tlc).toHaveValue("𐐀".repeat(121));
  } finally {
    page.off("request", observe);
  }
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Back to receiving", exact: true }).click();
  await page.getByRole("button", { name: "← Profile", exact: true }).click();
  console.log(
    "Ordinary TLC: native 120 supplementary points saved exactly; 121st retained with validation error, no write, unchanged saved text and draft version.",
  );
}
