import assert from "node:assert/strict";
import { join } from "node:path";

/** Read-only navigation over real revision records from the owned receiving fixture. */
export async function exerciseUsReceivingHistory({ page, expect, screenshots, first, final }) {
  const base = "http://localhost:5174/api/us/traceability/receiving";
  let reads = 0;
  const target = `${base}/${first.id}`;
  const failFirst = async (route) => {
    assert.equal(route.request().method(), "GET");
    reads += 1;
    if (reads === 1) return route.fulfill({ status: 503, json: {} });
    return route.continue();
  };
  await page.getByRole("button", { name: "Show revision history", exact: true }).click();
  let history = page.getByRole("region", { name: "Revision history", exact: true });
  await expect(history.getByRole("listitem")).toHaveCount(2);
  await page.route(target, failFirst);
  try {
    const link = history.getByRole("button", { name: "Open revision 1", exact: true });
    await link.focus();
    await expect(link).toBeFocused();
    await link.press("Enter");
    await expect(
      page.getByText("The selected revision could not be loaded. Your current view is unchanged.", {
        exact: true,
      }),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: "Correct receipt", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Retry selected revision", exact: true }).click();
    await expect(
      page.getByText(
        "This revision has been replaced. The frozen content below is historical, not the current receiving basis.",
        { exact: true },
      ),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: "Correct receipt", exact: true })).toHaveCount(0);
    assert.equal(reads, 2);
  } finally {
    await page.unroute(target, failFirst);
  }
  await page.getByRole("button", { name: "Open current receipt", exact: true }).click();
  await expect(page.getByRole("button", { name: "Correct receipt", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Show revision history", exact: true }).click();
  for (const locale of ["en", "es"]) {
    if (locale === "es") await page.getByRole("button", { name: "Language", exact: true }).click();
    history = page.getByRole("region", {
      name: locale === "en" ? "Revision history" : "Historial de revisiones",
      exact: true,
    });
    const navigation = page.getByRole("region", {
      name: locale === "en" ? "Receipt revisions" : "Revisiones de la recepción",
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
        await expect(history.getByRole("listitem")).toHaveCount(2);
        await expect(
          history.getByText(locale === "en" ? "Viewing this revision" : "Revisión abierta", {
            exact: true,
          }),
        ).toBeVisible();
        assert.equal(
          await navigation.evaluate((element) => element.scrollWidth <= element.clientWidth),
          true,
        );
        assert.equal(
          await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
          true,
        );
        if (width === 390) {
          for (const button of await navigation.getByRole("button").all()) {
            assert.ok(
              await button.evaluate((element) => element.getBoundingClientRect().height >= 44),
              `Mobile revision control needs a 44px target: ${await button.textContent()}`,
            );
          }
        }
        await navigation.screenshot({
          path: join(screenshots, `receiving-revisions-${locale}-${theme}-${width}.png`),
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
  await page.getByRole("combobox", { name: "Status", exact: true }).click();
  await page.getByRole("option", { name: "Amended", exact: true }).click();
  await expect(page.getByRole("combobox", { name: "History selection", exact: true })).toHaveText(
    "All revisions",
  );
  await page.getByRole("button", { name: first.eventNumber, exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Open current receipt", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Back to receiving", exact: true }).click();
  await expect(page.getByRole("combobox", { name: "Status", exact: true })).toHaveText("Amended");
  await expect(page.getByRole("combobox", { name: "History selection", exact: true })).toHaveText(
    "All revisions",
  );
  await page.getByRole("combobox", { name: "History selection", exact: true }).click();
  await page.getByRole("option", { name: "Current receipts and drafts", exact: true }).click();
  await expect(page.getByRole("combobox", { name: "Status", exact: true })).toHaveText(
    "All statuses",
  );
  // The history journey performs no writes and cannot change frozen content.
  const response = await page.request.get(`${base}/${final.id}`);
  assert.equal(response.status(), 200);
  assert.deepEqual(await response.json(), final);
  console.log(
    "Receiving history: exact historical/current links, failed GET/read-only retry, amended/all selection and preserved return filters; EN/ES light/dark 1440/1024/390 passed.",
  );
}
