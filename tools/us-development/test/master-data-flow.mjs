import assert from "node:assert/strict";
import { join } from "node:path";

async function exerciseAccessRecovery(page, expect) {
  const accessPath = "**/api/us/traceability/access";
  const held = Promise.withResolvers();
  const release = Promise.withResolvers();
  await page.route(accessPath, async (route) => {
    held.resolve();
    await release.promise;
    await route.abort();
  });
  try {
    await page.getByRole("button", { name: "Open reference data", exact: true }).click();
    await held.promise;
    await expect(page.getByText("Checking reference-data access…", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Profile", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: "Traceability profile", exact: true }),
    ).toBeVisible();
  } finally {
    release.resolve();
    await page.unroute(accessPath);
  }
  // A real network failure must also keep the escape path. This injects no
  // synthetic business responses; the CRUD portion below still uses the API.
  await page.route(accessPath, (route) => route.abort());
  try {
    await page.getByRole("button", { name: "Open reference data", exact: true }).click();
    await expect(
      page.getByText("Reference-data access could not be loaded.", { exact: true }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Profile", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: "Traceability profile", exact: true }),
    ).toBeVisible();
  } finally {
    await page.unroute(accessPath);
  }
}

async function captureVariants({ page, expect, screenshots, name, headings, notices }) {
  for (const [locale, heading] of Object.entries(headings)) {
    if (locale === "es") {
      await page.getByRole("button", { name: "Language", exact: true }).click();
    }
    await expect(page.getByRole("heading", { name: heading, exact: true })).toBeVisible();
    await expect(page.getByText(notices[locale], { exact: true })).toBeVisible();
    await expect(page.locator("html")).toHaveAttribute("lang", `${locale}-US`);
    for (const theme of ["light", "dark"]) {
      if (theme === "dark") {
        await page
          .getByRole("button", {
            name: locale === "en" ? "Change theme" : "Cambiar tema",
            exact: true,
          })
          .click();
      }
      await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
      for (const viewport of [
        { width: 1440, height: 900 },
        { width: 390, height: 844 },
      ]) {
        await page.setViewportSize(viewport);
        await expect(
          page.getByText(
            locale === "en"
              ? "Refreshing after a filter change…"
              : "Actualizando después de cambiar el filtro…",
            { exact: true },
          ),
        ).toHaveCount(0);
        await expect
          .poll(() =>
            page.evaluate(() => document.documentElement.scrollWidth <= globalThis.innerWidth),
          )
          .toBe(true);
        await page.evaluate(() => document.fonts.ready);
        await page.screenshot({
          path: join(screenshots, `${name}-${locale}-${theme}-${viewport.width}.png`),
          fullPage: true,
          animations: "disabled",
        });
      }
    }
    // Return to light before the next locale and leave the calling flow unchanged.
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

// Called only after real MFA and profile setup in the disposable US fixture.
// Keep business traffic real; screenshots contain synthetic reference data only.
export async function exerciseUsMasterData({ page, expect, screenshots, fixture }) {
  await exerciseAccessRecovery(page, expect);
  await page.getByRole("button", { name: "Open reference data", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Parties", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Add party", exact: true }).click();
  const partyDialog = page.getByRole("dialog");
  await expect(partyDialog).toBeVisible();
  const name = partyDialog.getByLabel("Name", { exact: true });
  await name.pressSequentially("Synthetic browser supplier");
  await expect(name).toHaveValue("Synthetic browser supplier");
  await expect(name).toBeFocused();
  await partyDialog.getByLabel("Contact name", { exact: true }).fill("Synthetic contact");
  await partyDialog.getByLabel("Contact phone", { exact: true }).fill("+1 503-555-0120");
  await partyDialog.getByLabel("Contact email", { exact: true }).fill("supplier@example.test");
  await partyDialog.getByLabel("Notes", { exact: true }).fill("Synthetic receiving instructions");
  for (let index = 0; index < 12; index += 1) {
    await page.keyboard.press("Tab");
    assert.equal(
      await partyDialog.evaluate((element) => element.contains(document.activeElement)),
      true,
    );
  }
  const createdParty = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/us/traceability/parties") &&
      response.request().method() === "POST",
  );
  // Preserve the primary assertion failure if cleanup closes a held request.
  void createdParty.catch(() => {});
  const partyListPath = (url) => url.pathname === "/api/us/traceability/parties";
  const refreshHeld = Promise.withResolvers();
  const releaseRefresh = Promise.withResolvers();
  const saveHeld = Promise.withResolvers();
  const releaseSave = Promise.withResolvers();
  await page.route(partyListPath, async (route) => {
    if (route.request().method() === "POST") {
      saveHeld.resolve();
      await releaseSave.promise;
    }
    if (route.request().method() === "GET") {
      refreshHeld.resolve();
      await releaseRefresh.promise;
    }
    await route.continue();
  });
  try {
    await partyDialog.getByRole("button", { name: "Save party", exact: true }).click();
    await saveHeld.promise;
    await expect(name).toBeDisabled();
    await expect(partyDialog.getByRole("textbox", { name: "Notes", exact: true })).toBeDisabled();
    releaseSave.resolve();
    const partyResponse = await createdParty;
    assert.equal(partyResponse.status(), 201);
    await refreshHeld.promise;
    // A successful write still owns the busy state until its real list reload
    // settles. A second mutation must not overwrite that ownership.
    await expect(page.getByRole("button", { name: "← Profile", exact: true })).toBeDisabled();
    await expect(page.getByRole("button", { name: "Add party", exact: true })).toBeDisabled();
  } finally {
    releaseSave.resolve();
    releaseRefresh.resolve();
    await page.unroute(partyListPath);
  }
  await expect(partyDialog).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Synthetic browser supplier", exact: true }),
  ).toBeVisible();
  await captureVariants({
    page,
    expect,
    screenshots,
    name: "parties",
    headings: { en: "Parties", es: "Partes" },
    notices: { en: "Party saved.", es: "Parte guardada." },
  });
  await page.getByRole("button", { name: "Synthetic browser supplier", exact: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Add location", exact: true }).click();
  const locationDialog = page.getByRole("dialog").filter({
    has: page.getByRole("heading", { name: "Add location", exact: true }),
  });
  await expect(locationDialog).toBeVisible();
  await locationDialog
    .getByLabel("Internal name", { exact: true })
    .pressSequentially("Synthetic receiving dock");
  await expect(locationDialog.getByLabel("Business name", { exact: true })).toHaveValue(
    "Synthetic browser supplier",
  );
  await locationDialog.getByLabel("City", { exact: true }).fill("Portland");
  await locationDialog.getByLabel("State or region", { exact: true }).fill("OR");
  await locationDialog.getByLabel("ZIP or postal code", { exact: true }).fill("97201");
  await page.screenshot({
    path: join(screenshots, "location-draft-en-light.png"),
    fullPage: true,
    animations: "disabled",
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({
    path: join(screenshots, "location-draft-en-light-mobile.png"),
    fullPage: true,
    animations: "disabled",
  });
  await expect(
    locationDialog.getByRole("button", { name: "Save location", exact: true }),
  ).toBeInViewport();
  assert.equal(
    await locationDialog.evaluate((element) => element.scrollWidth <= element.clientWidth),
    true,
  );
  await page.setViewportSize({ width: 1440, height: 900 });
  const createdLocation = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/us/traceability/locations") &&
      response.request().method() === "POST",
  );
  void createdLocation.catch(() => {});
  const locationPath = (url) => url.pathname === "/api/us/traceability/locations";
  const locationSaveHeld = Promise.withResolvers();
  const releaseLocationSave = Promise.withResolvers();
  await page.route(locationPath, async (route) => {
    if (route.request().method() === "POST") {
      locationSaveHeld.resolve();
      await releaseLocationSave.promise;
    }
    await route.continue();
  });
  let locationResponse;
  try {
    await locationDialog.getByRole("button", { name: "Save location", exact: true }).click();
    await locationSaveHeld.promise;
    await expect(locationDialog.getByLabel("Internal name", { exact: true })).toBeDisabled();
    await expect(locationDialog.getByLabel("Business name", { exact: true })).toBeDisabled();
    await expect(locationDialog.getByLabel("ZIP or postal code", { exact: true })).toBeDisabled();
    releaseLocationSave.resolve();
    locationResponse = await createdLocation;
  } finally {
    releaseLocationSave.resolve();
    await page.unroute(locationPath);
  }
  assert.equal(locationResponse.status(), 201);
  const location = await locationResponse.json();
  assert.equal(location.phoneNumber, null);
  assert.equal(location.streetAddress, null);
  assert.equal(location.descriptionStatus.exportReady, false);
  await expect(locationDialog).toHaveCount(0);
  await page.getByRole("button", { name: "Locations", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Synthetic receiving dock", exact: true }),
  ).toBeVisible();
  await captureVariants({
    page,
    expect,
    screenshots,
    name: "locations",
    headings: { en: "Locations", es: "Ubicaciones" },
    notices: { en: "Location saved.", es: "Ubicación guardada." },
  });
  const locationRow = page.getByRole("row").filter({ hasText: "Synthetic receiving dock" });
  for (const [action, archived] of [
    ["Archive location", true],
    ["Restore location", false],
  ]) {
    await locationRow
      .getByRole("button", { name: "Synthetic receiving dock", exact: true })
      .click();
    await expect(page.getByRole("dialog")).toBeVisible();
    const confirmation = page.waitForEvent("dialog");
    const updated = page.waitForResponse(
      (response) =>
        response.url().endsWith(`/api/us/traceability/locations/${location.id}`) &&
        response.request().method() === "PATCH",
    );
    const clicking = page
      .getByRole("dialog")
      .getByRole("button", { name: action, exact: true })
      .click();
    const dialog = await confirmation;
    const confirmationType = dialog.type();
    const confirmationMessage = dialog.message();
    await dialog.accept();
    await clicking;
    assert.equal(confirmationType, "confirm");
    assert.match(confirmationMessage, archived ? /histor/i : /restore/i);
    const response = await updated;
    assert.equal(response.status(), 200);
    assert.deepEqual(response.request().postDataJSON(), { archived });
    assert.equal((await response.json()).archived, archived);
    await expect(locationRow).toHaveCount(0);
    await page
      .getByLabel("Status", { exact: true })
      .selectOption({ label: archived ? "Archived" : "Active" });
    await expect(locationRow).toBeVisible();
  }
  await page.getByRole("button", { name: "← Profile", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Traceability profile", exact: true }),
  ).toBeVisible();
  // Role changes are made only in this test's disposable synthetic tenant.
  // Re-entering must obtain fresh capabilities, not cache the owner's controls.
  await fixture.pool.query(
    "UPDATE member SET role = $1 WHERE organization_id = $2 AND user_id = $3",
    ["traceability_auditor", fixture.tenantId, fixture.userId],
  );
  try {
    await page.getByRole("button", { name: "Open reference data", exact: true }).click();
    await expect(
      page.getByRole("button", { name: "Synthetic browser supplier", exact: true }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Synthetic browser supplier", exact: true }).click();
    await expect(page.getByRole("dialog")).toBeVisible();
    for (const value of [
      "Synthetic contact",
      "+1 503-555-0120",
      "supplier@example.test",
      "Synthetic receiving instructions",
    ]) {
      await expect(page.getByRole("dialog").getByText(value, { exact: true })).toBeVisible();
    }
    await expect(
      page.getByRole("button", { name: /^(Add|Edit|Archive|Restore) party$/ }),
    ).toHaveCount(0);
    await page.getByRole("button", { name: "Close party details", exact: true }).click();
    await page.getByRole("button", { name: "Locations", exact: true }).click();
    await expect(locationRow).toBeVisible();
    await locationRow
      .getByRole("button", { name: "Synthetic receiving dock", exact: true })
      .click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await expect(page.getByRole("dialog").getByText("97201", { exact: true })).toBeVisible();
    await expect(page.getByRole("dialog").getByText("US", { exact: true })).toBeVisible();
    await expect(
      page.getByRole("dialog").getByText(/Description is incomplete\. Missing: .*phone/),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: /^(Add|Edit|Archive|Restore) location$/ }),
    ).toHaveCount(0);
    await page.screenshot({
      path: join(screenshots, "locations-read-only-en.png"),
      fullPage: true,
      animations: "disabled",
    });
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(
      await page
        .getByRole("dialog")
        .evaluate((element) => element.scrollWidth <= element.clientWidth),
      true,
    );
    await page.screenshot({
      path: join(screenshots, "locations-read-only-en-mobile.png"),
      fullPage: true,
      animations: "disabled",
    });
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.getByRole("button", { name: "Close location details", exact: true }).click();
    await page.getByRole("button", { name: "← Profile", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: "Traceability profile", exact: true }),
    ).toBeVisible();
  } finally {
    await fixture.pool.query(
      "UPDATE member SET role = $1 WHERE organization_id = $2 AND user_id = $3",
      ["owner", fixture.tenantId, fixture.userId],
    );
  }
}
