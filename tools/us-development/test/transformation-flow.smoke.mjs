import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { startUsBrowserFixture } from "../browser-fixture.mjs";

const browserRequire = createRequire(
  new URL("../../production-browser/package.json", import.meta.url),
);
const { chromium, expect } = browserRequire("@playwright/test");
const apiRequire = createRequire(new URL("../../../apps/api/package.json", import.meta.url));
const authRequire = createRequire(apiRequire.resolve("better-auth"));
const { createOTP } = authRequire("@better-auth/utils/otp");
const { base32 } = authRequire("@better-auth/utils/base32");

test(
  "US Events: real MFA, mixed list, Transformation save/readiness/QA finalization, EN/ES at 1024",
  { timeout: 120000 },
  async () => {
    const fixture = await startUsBrowserFixture(process.env.US_TEST_DATABASE_URL);
    let browser;
    try {
      browser = await chromium.launch();
      const context = await browser.newContext({
        viewport: { width: 1024, height: 900 },
        colorScheme: "light",
      });
      const page = await context.newPage();
      const errors = [],
        external = [];
      page.on("pageerror", () => errors.push("pageerror"));
      await page.route("**/*", async (route) => {
        if (new URL(route.request().url()).origin === "http://localhost:5174")
          return route.continue();
        external.push(new URL(route.request().url()).origin);
        return route.abort();
      });
      // Authenticate through the real UI. Never trace or screenshot credentials or MFA material.
      await page.goto("http://localhost:5174");
      await page.getByLabel("Email", { exact: true }).fill(fixture.email);
      await page.getByLabel("Password", { exact: true }).fill(fixture.password);
      await page.getByRole("button", { name: "Sign in", exact: true }).click();
      await page.getByLabel("Confirm password", { exact: true }).fill(fixture.password);
      await page.getByRole("button", { name: "Set up authenticator", exact: true }).click();
      const key = page.getByText("Manual authenticator setup key", { exact: true }).locator("+ dd");
      await expect(key).toBeVisible();
      const secret = new TextDecoder().decode(base32.decode((await key.textContent()).trim()));
      await page.getByRole("checkbox", { name: "I saved these backup codes" }).check();
      await page
        .getByLabel("6-digit authenticator code", { exact: true })
        .fill(await createOTP(secret).totp());
      await page.getByRole("button", { name: "Verify", exact: true }).click();
      await page.getByRole("button", { name: "Synthetic US development", exact: true }).click();
      await page
        .getByLabel("Regulatory profile", { exact: true })
        .selectOption("US_FSMA204_PROCESSOR");
      await page.getByLabel("Time zone", { exact: true }).selectOption("America/Chicago");
      await page.getByRole("button", { name: "Save profile", exact: true }).click();
      await expect(
        page.getByRole("heading", { name: "Traceability profile", exact: true }),
      ).toBeVisible();

      // Synthetic references belong only to this invocation's disposable database; no demo seed.
      const party = randomUUID(),
        location = randomUUID(),
        inputProduct = randomUUID(),
        outputProduct = randomUUID();
      await fixture.pool.query(
        "INSERT INTO traceability_parties(id,tenant_id,name) VALUES ($1,$2,'Synthetic transformation processor')",
        [party, fixture.tenantId],
      );
      await fixture.pool.query(
        "INSERT INTO traceability_locations(id,tenant_id,party_id,name,business_name,phone_number,street_address,city,state_or_region,zip_or_postal_code,country_code,roles) VALUES ($1,$2,$3,'Synthetic transformation facility','Synthetic Processor LLC','+1 509 555 0100','100 Test Way','Yakima','WA','98901','US',ARRAY['processor','tlc_source','receive_at']::traceability_location_role[])",
        [location, fixture.tenantId, party],
      );
      for (const [id, name, coverage] of [
        [inputProduct, "Synthetic non-FTL ingredient", "not_covered"],
        [outputProduct, "Synthetic fresh-cut cups", "covered"],
      ]) {
        await fixture.pool.query("INSERT INTO products(id,tenant_id,name) VALUES ($1,$2,$3)", [
          id,
          fixture.tenantId,
          name,
        ]);
        await fixture.pool.query(
          "INSERT INTO product_traceability_profiles(tenant_id,product_id,product_name,coverage_status,coverage_rationale,ftl_category,ftl_source_url,ftl_source_version,reviewed_by,reviewed_at) VALUES ($1,$2,$3,$4,'Synthetic QA review','Fresh-cut fruits','https://www.fda.gov/food/food-safety-modernization-act-fsma/food-traceability-list','Synthetic 2026',$5,now())",
          [fixture.tenantId, id, name, coverage, fixture.userId],
        );
      }
      const base = "http://localhost:5174/api/us/traceability";
      async function post(path, data) {
        const response = await page.request.post(`${base}/${path}`, {
          headers: { Origin: "http://localhost:5174" },
          data,
        });
        assert.equal(response.ok(), true, `${path}: HTTP ${response.status()}`);
        return response.json();
      }
      const document = await post("reference-documents", {
        type: "other",
        typeOtherLabel: "Work order",
        number: "TRN-SYNTHETIC-001",
        partyId: party,
        issuedOn: "2026-09-27",
        notes: null,
      });
      const receiving = await post("receiving", {
        operationKey: randomUUID(),
        draft: {
          dateReceived: "2026-09-27",
          locationId: location,
          previousSourceLocationId: location,
          receivedAtNote: null,
          notes: "Synthetic mixed-list receipt",
          items: [],
          documentIds: [],
        },
      });

      await page.getByRole("button", { name: "Open reference data", exact: true }).click();
      await page.getByRole("button", { name: "Events", exact: true }).click();
      await expect(
        page.getByRole("button", { name: receiving.record.eventNumber, exact: true }),
      ).toBeVisible();
      await page.getByRole("button", { name: "New transformation", exact: true }).click();
      await page.getByLabel("Completion date", { exact: true }).fill("2026-09-27");
      await page.getByLabel("Transformation location", { exact: true }).selectOption(location);
      await page.getByLabel("Transformation reason", { exact: true }).selectOption("processing");
      await page.getByRole("button", { name: "Add documented non-FTL input", exact: true }).click();
      const input = page.getByRole("group", {
        name: "Input 1 · Documented non-FTL input",
        exact: true,
      });
      await input.getByLabel("Product", { exact: true }).selectOption(inputProduct);
      await input.getByLabel("Source location", { exact: true }).selectOption(location);
      await input
        .getByLabel("Source document or reference", { exact: true })
        .fill("SYNTHETIC-INGREDIENT-001");
      await input.getByLabel("Quantity", { exact: true }).fill("500.000");
      await input.getByLabel("Unit", { exact: true }).selectOption("lb");
      await page.getByRole("button", { name: "Add output", exact: true }).click();
      const output = page.getByRole("group", { name: "Output 1", exact: true });
      const tlc = "00001-SYNTHETIC-TRANSFORMATION-OUTPUT-2026";
      await output.getByLabel("Product", { exact: true }).selectOption(outputProduct);
      await output.getByLabel("Traceability lot code (TLC)", { exact: true }).fill(tlc);
      await output.getByLabel("Quantity", { exact: true }).fill("100.000");
      await output.getByLabel("Unit", { exact: true }).selectOption("case");
      await page.getByLabel("Reference document", { exact: true }).selectOption(document.id);
      await page.getByRole("button", { name: "Attach document", exact: true }).click();
      const created = page.waitForResponse(
        (r) => r.url().endsWith("/transformation") && r.request().method() === "POST",
      );
      await page.getByRole("button", { name: "Save draft", exact: true }).click();
      const createResponse = await created;
      assert.equal(createResponse.status(), 201);
      const saved = await createResponse.json();
      await expect(
        page.getByRole("heading", { name: saved.eventNumber, exact: true }),
      ).toBeVisible();
      await page.getByRole("button", { name: "Check readiness", exact: true }).click();
      await expect(page.getByText("Complete · v1", { exact: true })).toBeVisible();
      await page.getByRole("button", { name: "Finalize transformation", exact: true }).click();
      const dialog = page.getByRole("dialog", { name: "Finalize transformation", exact: true });
      await expect(
        dialog.getByText("Finalization creates output lots; it does not link Cases.", {
          exact: true,
        }),
      ).toBeVisible();
      await expect(dialog).toContainText("100.000 case");
      await dialog.getByRole("button", { name: "Confirm", exact: true }).click();
      await expect(
        page.getByRole("article", { name: "Transformation detail", exact: true }),
      ).toBeVisible();
      const currentResponse = await page.request.get(`${base}/transformation/${saved.id}`);
      assert.equal(currentResponse.status(), 200);
      const current = await currentResponse.json();
      assert.equal(current.status, "finalized");
      assert.equal(current.snapshot.eventDate, "2026-09-27");
      assert.equal(current.snapshot.outputs[0].tlc, tlc);
      assert.equal(current.snapshot.outputs[0].quantity, "100.000");
      const lotId = current.snapshot.outputs[0].lotId;
      const screenshots = await mkdtemp(join(tmpdir(), "markiro-us-transformation-browser-"));
      console.log(`US Transformation safe screenshots: ${screenshots}`);
      for (const locale of ["en", "es"]) {
        if (locale === "es")
          await page.getByRole("button", { name: "Language", exact: true }).click();
        await expect(page.locator("html")).toHaveAttribute("lang", `${locale}-US`);
        const detail = page.getByRole("article", {
          name: locale === "en" ? "Transformation detail" : "Detalle de transformación",
          exact: true,
        });
        const outputs = detail.getByRole("region", {
          name: locale === "en" ? "Outputs" : "Salidas",
          exact: true,
        });
        await expect(outputs.getByRole("button", { name: tlc, exact: true })).toBeVisible();
        await expect(outputs.getByText(lotId, { exact: true })).toBeVisible();
        await expect(outputs.getByText("100.000 case", { exact: true })).toBeVisible();
        await expect(
          detail.getByText(
            locale === "en" ? "No active case links." : "No hay vínculos de cajas activos.",
            { exact: true },
          ),
        ).toBeVisible();
        await expect
          .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
          .toBe(true);
        await page.evaluate(() => window.scrollTo(0, 0));
        await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0);
        const navigation = page.getByRole("button", {
          name: locale === "en" ? "Events" : "Eventos",
          exact: true,
        });
        await expect(navigation).toBeInViewport();
        await page.screenshot({
          path: join(screenshots, `transformation-finalized-${locale}-1024-viewport.png`),
          animations: "disabled",
        });
        await page.screenshot({
          path: join(screenshots, `transformation-finalized-${locale}-1024.png`),
          fullPage: true,
          animations: "disabled",
        });
      }
      await page.getByRole("button", { name: "Idioma", exact: true }).click();
      await page.getByRole("button", { name: "Back to events", exact: true }).click();
      const rows = page.getByRole("row");
      await expect(rows.filter({ hasText: saved.eventNumber })).toContainText("Transformation");
      await expect(rows.filter({ hasText: receiving.record.eventNumber })).toContainText(
        "Receiving",
      );
      await expect(page.getByRole("combobox", { name: "Event type", exact: true })).toHaveText(
        "All types",
      );
      await page.screenshot({
        path: join(screenshots, "events-mixed-en-1024.png"),
        fullPage: true,
      });
      await page.getByRole("combobox", { name: "Event type", exact: true }).click();
      await page.getByRole("option", { name: "Receiving", exact: true }).click();
      await expect(page.getByRole("button", { name: saved.eventNumber, exact: true })).toHaveCount(
        0,
      );
      await page.getByRole("button", { name: receiving.record.eventNumber, exact: true }).click();
      await expect(page.getByLabel("Date received", { exact: true })).toHaveValue("2026-09-27");
      assert.deepEqual(errors, []);
      assert.deepEqual(external, []);
    } finally {
      try {
        await browser?.close();
      } finally {
        await fixture.close();
      }
    }
  },
);
