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
  "US Shipping: saved-origin lot, office finalization, EN/ES and themes at 1024",
  { timeout: 120000 },
  async () => {
    const fixture = await startUsBrowserFixture(process.env.US_TEST_DATABASE_URL);
    let browser;
    try {
      browser = await chromium.launch();
      const context = await browser.newContext({
        viewport: { width: 1024, height: 900 },
        colorScheme: "light",
        locale: "en-US",
      });
      const page = await context.newPage();
      const screenshots = await mkdtemp(join(tmpdir(), "markiro-us-shipping-browser-"));
      console.log(`US Shipping safe screenshots: ${screenshots}`);
      const errors = [];
      const external = [];
      page.on("pageerror", () => errors.push("pageerror"));
      await page.route("**/*", async (route) => {
        const origin = new URL(route.request().url()).origin;
        if (origin === "http://localhost:5174") return route.continue();
        external.push(origin);
        return route.abort();
      });
      // Credentials and MFA material are never traced or included in screenshots.
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

      const party = randomUUID(),
        shipFrom = randomUUID(),
        recipient = randomUUID();
      const product = randomUUID(),
        lot = randomUUID(),
        bol = randomUUID(),
        invoice = randomUUID();
      await fixture.pool.query(
        "INSERT INTO traceability_parties(id,tenant_id,name) VALUES ($1,$2,'Synthetic Shipping party')",
        [party, fixture.tenantId],
      );
      await fixture.pool.query(
        "INSERT INTO traceability_locations(id,tenant_id,party_id,name,business_name,phone_number,street_address,city,state_or_region,zip_or_postal_code,country_code,roles) VALUES ($1,$2,$3,'Synthetic ship-from','Synthetic Ship-from LLC','+1 509 555 0100','100 Test Way','Yakima','WA','98901','US',ARRAY['receive_at','ship_from']::traceability_location_role[])",
        [shipFrom, fixture.tenantId, party],
      );
      await fixture.pool.query(
        "INSERT INTO traceability_locations(id,tenant_id,party_id,name,business_name,phone_number,street_address,city,state_or_region,zip_or_postal_code,country_code,roles) VALUES ($1,$2,$3,'Synthetic recipient','Synthetic Recipient LLC','+1 503 555 0100','200 Test Way','Portland','OR','97201','US',ARRAY['recipient']::traceability_location_role[])",
        [recipient, fixture.tenantId, party],
      );
      await fixture.pool.query(
        "INSERT INTO products(id,tenant_id,name,gtin14) VALUES ($1,$2,'Synthetic apples','00000096385074')",
        [product, fixture.tenantId],
      );
      await fixture.pool.query(
        "INSERT INTO product_traceability_profiles(tenant_id,product_id,product_name,brand_name,commodity,variety,packaging_size_value,packaging_size_uom,packaging_style,coverage_status,coverage_rationale,ftl_category,ftl_source_url,ftl_source_version,reviewed_by,reviewed_at) VALUES ($1,$2,'Synthetic apples','Synthetic Orchard','Fruit','Honeycrisp',1,'case','Sealed case','covered','Synthetic QA review','Fresh-cut fruits','https://www.fda.gov/food/food-safety-modernization-act-fsma/food-traceability-list','Synthetic 2026',$3,now())",
        [fixture.tenantId, product, fixture.userId],
      );
      await fixture.pool.query(
        "INSERT INTO traceability_lots(id,tenant_id,product_id,tlc,assignment_basis,source_location_id,created_by,updated_by) VALUES ($1,$2,$3,'SYNTHETIC-SHIPPING-LOT','imported',$4,$5,$5)",
        [lot, fixture.tenantId, product, shipFrom, fixture.userId],
      );
      for (const [id, type, number] of [
        [bol, "bol", "BOL-SYNTHETIC-1"],
        [invoice, "invoice", "INV-SYNTHETIC-1"],
      ]) {
        await fixture.pool.query(
          "INSERT INTO reference_documents(id,tenant_id,type,number,party_id,created_by) VALUES ($1,$2,$3,$4,$5,$6)",
          [id, fixture.tenantId, type, number, party, fixture.userId],
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
      const received = await post("receiving", {
        operationKey: randomUUID(),
        draft: {
          dateReceived: "2026-09-27",
          locationId: shipFrom,
          previousSourceLocationId: shipFrom,
          receivedAtNote: null,
          notes: null,
          documentIds: [bol],
          items: [
            {
              productId: product,
              lotId: lot,
              lotLinkMode: "link_existing",
              tlc: "SYNTHETIC-SHIPPING-LOT",
              source: { kind: "location", locationId: shipFrom },
              exemptSupplier: false,
              exemptReason: null,
              supplierLotReference: null,
              quantity: "100",
              unitOfMeasure: "case",
              notes: null,
            },
          ],
        },
      });
      const receiptReadinessResponse = await page.request.get(
        `${base}/receiving/${received.record.id}/readiness?expectedDraftVersion=1`,
      );
      assert.equal(receiptReadinessResponse.status(), 200);
      const receiptReadiness = await receiptReadinessResponse.json();
      assert.equal(receiptReadiness.state, "complete");
      await post(`receiving/${received.record.id}/finalize`, {
        operationKey: randomUUID(),
        expectedDraftVersion: 1,
        expectedInputDigest: receiptReadiness.inputDigest,
      });

      await page.getByRole("button", { name: "Open reference data", exact: true }).click();
      await page.getByRole("button", { name: "Events", exact: true }).click();
      await page.getByRole("button", { name: "New shipment", exact: true }).click();
      await page.getByLabel("Date shipped", { exact: true }).fill("2026-09-27");
      await expect(page.getByLabel("Date shipped", { exact: true })).toHaveValue("2026-09-27");
      await page.getByRole("combobox", { name: "Ship-from", exact: true }).selectOption(shipFrom);
      await page
        .getByRole("combobox", { name: "Immediate subsequent recipient", exact: true })
        .selectOption(recipient);
      await page.getByRole("button", { name: "Add lot", exact: true }).click();
      const line = page.getByRole("group", { name: "Line 1", exact: true });
      await line.getByRole("combobox", { name: "Existing lot", exact: true }).selectOption(lot);
      await line.getByLabel("Quantity", { exact: true }).fill("200");
      await line.getByRole("combobox", { name: "Unit", exact: true }).selectOption("case");
      await expect(line).toContainText("Current recorded lot balance: 100 case");
      await expect(line).toContainText("Proposed shipment quantity: 200 case");
      await expect(line).toContainText("Projected after this draft: -100 case");
      await page
        .getByRole("combobox", { name: "Reference document", exact: true })
        .selectOption(bol);
      await page.getByRole("button", { name: "Attach document", exact: true }).click();
      await page
        .getByRole("combobox", { name: "Reference document", exact: true })
        .selectOption(invoice);
      await page.getByRole("button", { name: "Attach document", exact: true }).click();
      const created = page.waitForResponse(
        (response) =>
          response.url().endsWith("/shipments") && response.request().method() === "POST",
      );
      await page.getByRole("button", { name: "Save draft", exact: true }).click();
      const createResponse = await created;
      assert.equal(createResponse.status(), 201);
      const saved = await createResponse.json();
      await expect(
        page.getByRole("heading", { name: saved.eventNumber, exact: true }),
      ).toBeVisible();
      await page.getByRole("button", { name: "Check readiness", exact: true }).click();
      const englishBlockers = page.getByRole("alert", { name: "Shipping blockers" });
      await expect(englishBlockers).toContainText("Line 1 · Quantity");
      await expect(englishBlockers).toContainText("Reduce the shipped quantity");
      await expect(englishBlockers).not.toContainText("over_shipment");
      await page.getByRole("button", { name: "Language", exact: true }).click();
      await expect(page.locator("html")).toHaveAttribute("lang", "es-US");
      const spanishBlockers = page.getByRole("alert", { name: "Bloqueos del envío" });
      await expect(spanishBlockers).toContainText("Línea 1 · Cantidad");
      await expect(spanishBlockers).toContainText("Reduzca la cantidad enviada");
      await expect(spanishBlockers).not.toContainText("over_shipment");
      const spanishLine = page.getByRole("group", { name: "Línea 1", exact: true });
      await expect(spanishLine).toContainText("Saldo registrado actual del lote: 100 case");
      await expect(spanishLine).toContainText("Cantidad propuesta para el envío: 200 case");
      await expect(spanishLine).toContainText("Proyección después de este borrador: -100 case");
      await page.getByRole("button", { name: "Idioma", exact: true }).click();
      await expect(page.locator("html")).toHaveAttribute("lang", "en-US");
      await line.getByLabel("Quantity", { exact: true }).fill("60");
      await expect(line).toContainText("Current recorded lot balance: 100 case");
      await expect(line).toContainText("Proposed shipment quantity: 60 case");
      await expect(line).toContainText("Projected after this draft: 40 case");
      await expect
        .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
        .toBe(true);
      await page.evaluate(() => document.fonts.ready);
      await page.screenshot({
        path: join(screenshots, "shipping-draft-forecast-en-light-1024.png"),
        fullPage: true,
        animations: "disabled",
      });
      await line
        .locator(".us-sh-balance")
        .evaluate((element) => element.scrollIntoView({ block: "center" }));
      await page.evaluate(
        () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
      );
      await page.screenshot({
        path: join(screenshots, "shipping-draft-forecast-en-light-1024-viewport.png"),
        animations: "disabled",
      });
      await page.getByRole("button", { name: "Language", exact: true }).click();
      await page.getByRole("button", { name: "Cambiar tema", exact: true }).click();
      const correctedSpanishLine = page.getByRole("group", { name: "Línea 1", exact: true });
      await expect(correctedSpanishLine).toContainText(
        "Saldo registrado actual del lote: 100 case",
      );
      await expect(correctedSpanishLine).toContainText("Cantidad propuesta para el envío: 60 case");
      await expect(correctedSpanishLine).toContainText(
        "Proyección después de este borrador: 40 case",
      );
      await expect
        .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
        .toBe(true);
      await expect(page.getByLabel("Fecha de envío", { exact: true })).toHaveValue("2026-09-27");
      await expect(
        correctedSpanishLine.getByRole("combobox", { name: "Lote existente", exact: true }),
      ).toHaveValue(lot);
      await expect(
        correctedSpanishLine.getByRole("combobox", { name: "Unidad", exact: true }),
      ).toHaveValue("case");
      for (const selector of [
        correctedSpanishLine.getByRole("combobox", { name: "Lote existente", exact: true }),
        correctedSpanishLine.getByRole("combobox", { name: "Unidad", exact: true }),
      ]) {
        const paint = await selector.evaluate((element) => {
          const style = getComputedStyle(element);
          return {
            text:
              element instanceof HTMLSelectElement ? element.selectedOptions[0]?.textContent : null,
            color: style.color,
            background: style.backgroundColor,
            opacity: style.opacity,
            visibility: style.visibility,
          };
        });
        assert.ok(paint.text);
        assert.notEqual(paint.color, paint.background);
        assert.equal(paint.opacity, "1");
        assert.equal(paint.visibility, "visible");
      }
      await page.evaluate(() => document.fonts.ready);
      await page.evaluate(
        () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
      );
      await page.screenshot({
        path: join(screenshots, "shipping-draft-forecast-es-dark-1024.png"),
        fullPage: true,
        animations: "disabled",
      });
      await correctedSpanishLine
        .locator(".us-sh-balance")
        .evaluate((element) => element.scrollIntoView({ block: "center" }));
      await page.evaluate(
        () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
      );
      await page.screenshot({
        path: join(screenshots, "shipping-draft-forecast-es-dark-1024-viewport.png"),
        animations: "disabled",
      });
      await page.getByRole("button", { name: "Idioma", exact: true }).click();
      await page.getByRole("button", { name: "Change theme", exact: true }).click();
      const updated = page.waitForResponse(
        (response) =>
          response.url().endsWith(`/shipments/${saved.id}`) &&
          response.request().method() === "PUT",
      );
      await page.getByRole("button", { name: "Save draft", exact: true }).click();
      assert.equal((await updated).status(), 200);
      await page.getByRole("button", { name: "Check readiness", exact: true }).click();
      await expect(page.getByText("Complete — ready to finalize", { exact: true })).toBeVisible();
      await page.getByRole("button", { name: "Finalize shipment", exact: true }).click();
      const dialog = page.getByRole("dialog", { name: "Finalize shipment", exact: true });
      await expect(dialog).toContainText("60 case");
      await expect(
        dialog.getByRole("button", { name: "Cancel", exact: true }).first(),
      ).toBeFocused();
      await page.keyboard.press("Escape");
      await expect(dialog).toBeHidden();
      await expect(
        page.getByRole("button", { name: "Finalize shipment", exact: true }),
      ).toBeFocused();
      await page.getByRole("button", { name: "Finalize shipment", exact: true }).click();
      await dialog.getByRole("button", { name: "Confirm finalization", exact: true }).click();
      await expect(
        page.getByRole("article", { name: "Shipping detail", exact: true }),
      ).toBeVisible();
      await expect(
        page.getByRole("article", { name: "Shipping detail", exact: true }),
      ).toContainText("Current recorded lot balance: 40 case");
      const currentResponse = await page.request.get(`${base}/shipments/${saved.id}`);
      assert.equal(currentResponse.status(), 200);
      const current = await currentResponse.json();
      assert.equal(current.status, "finalized");
      assert.equal(current.snapshot.items[0].quantity, "60");
      assert.equal(current.snapshot.items[0].unitOfMeasure, "case");

      for (const [locale, theme] of [
        ["en", "light"],
        ["es", "dark"],
      ]) {
        if (locale === "es") {
          await page.getByRole("button", { name: "Language", exact: true }).click();
          await page.getByRole("button", { name: "Cambiar tema", exact: true }).click();
        }
        await expect(page.locator("html")).toHaveAttribute("lang", `${locale}-US`);
        await expect(
          page.getByRole("article", {
            name: locale === "en" ? "Shipping detail" : "Detalle de envío",
            exact: true,
          }),
        ).toContainText("60 case");
        await expect(page.getByRole("article")).toContainText(
          locale === "en"
            ? "Current recorded lot balance: 40 case"
            : "Saldo registrado actual del lote: 40 case",
        );
        const shipFromDescription = page.getByRole("region", {
          name: locale === "en" ? "Ship-from description" : "Descripción del origen",
        });
        await expect(shipFromDescription).toContainText("+1 509 555 0100");
        await expect(shipFromDescription).toContainText("100 Test Way");
        await expect(shipFromDescription).toContainText("Yakima");
        const recipientDescription = page.getByRole("region", {
          name: locale === "en" ? "Recipient description" : "Descripción del destinatario",
        });
        await expect(recipientDescription).toContainText("+1 503 555 0100");
        await expect(recipientDescription).toContainText("200 Test Way");
        const productDescription = page.getByRole("region", {
          name: locale === "en" ? "Product description" : "Descripción del producto",
        });
        await expect(productDescription).toContainText("Synthetic Orchard");
        await expect(productDescription).toContainText("Honeycrisp");
        await expect(productDescription).toContainText("00000096385074");
        const documents = page.getByRole("region", {
          name: locale === "en" ? "Reference documents" : "Documentos de referencia",
        });
        await expect(documents).toContainText("Synthetic Shipping party");
        await expect(page.getByRole("article")).toContainText(/\d{2}\/\d{2}\/\d{4} \d{2}:\d{2}/);
        await expect
          .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
          .toBe(true);
        await page.evaluate(() => document.fonts.ready);
        await page.evaluate(() => window.scrollTo(0, 0));
        await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0);
        await page.screenshot({
          path: join(screenshots, `shipping-finalized-${locale}-${theme}-1024-viewport.png`),
          animations: "disabled",
        });
        await page.screenshot({
          path: join(screenshots, `shipping-finalized-${locale}-${theme}-1024.png`),
          fullPage: true,
          animations: "disabled",
        });
      }
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
