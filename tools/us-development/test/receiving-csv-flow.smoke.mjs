import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { startUsBrowserFixture } from "../browser-fixture.mjs";
import { expectUsBrand } from "./brand-flow.mjs";
import { decodeReceivingCsvExport } from "../../../packages/platform-contracts/dist/index.js";

const browserRequire = createRequire(
  new URL("../../production-browser/package.json", import.meta.url),
);
const { chromium, expect } = browserRequire("@playwright/test");
const apiRequire = createRequire(new URL("../../../apps/api/package.json", import.meta.url));
const authRequire = createRequire(apiRequire.resolve("better-auth"));
const { createOTP } = authRequire("@better-auth/utils/otp");
const { base32 } = authRequire("@better-auth/utils/base32");
const columns =
  "product_id,product_gtin,lot_link_mode,lot_id,tlc,source_kind,source_location_id,source_reference_url,source_resolved_location_id,quantity,unit_of_measure,exempt_supplier,exempt_reason,exempt_evidence_url,exempt_tlc_handling,proposed_tlc,supplier_lot_reference,notes";

test(
  "US Receiving CSV: real MFA, bounded preview, same-key recovery and live GET",
  { timeout: 120000 },
  async () => {
    const fixture = await startUsBrowserFixture(process.env.US_TEST_DATABASE_URL);
    let browser;
    try {
      browser = await chromium.launch();
      const context = await browser.newContext({
        viewport: { width: 1440, height: 900 },
        colorScheme: "light",
      });
      const page = await context.newPage();
      const errors = [],
        external = [];
      page.on("pageerror", () => errors.push("pageerror"));
      await page.route("**/*", async (route) => {
        if (new URL(route.request().url()).origin === "http://localhost:5174")
          await route.continue();
        else {
          external.push(new URL(route.request().url()).origin);
          await route.abort();
        }
      });
      // Real MFA; never capture credentials, authenticator material or session cookies.
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
      const productResponse = await page.request.post(
        "http://localhost:5174/api/us/traceability/catalog/products",
        {
          headers: { Origin: "http://localhost:5174" },
          data: { name: "Synthetic CSV Apple Slices" },
        },
      );
      assert.equal(productResponse.status(), 201);
      const product = await productResponse.json();
      await page.getByRole("button", { name: "Open reference data", exact: true }).click();
      await page.getByRole("button", { name: "Events", exact: true }).click();
      await page.getByRole("combobox", { name: "Event type", exact: true }).click();
      await page.getByRole("option", { name: "Receiving", exact: true }).click();
      await page.getByRole("button", { name: "Import CSV", exact: true }).click();
      const screenshots = await mkdtemp(join(tmpdir(), "markiro-us-csv-browser-"));
      console.log(`US CSV synthetic screenshots: ${screenshots}`);
      async function capture(state) {
        for (const locale of ["en", "es"]) {
          if (locale === "es")
            await page.getByRole("button", { name: "Language", exact: true }).click();
          await expect(page.locator("html")).toHaveAttribute("lang", `${locale}-US`);
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
              await expect
                .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
                .toBe(true);
              await expectUsBrand({ page, expect });
              await page.screenshot({
                path: join(screenshots, `csv-${state}-${locale}-${theme}-${width}.png`),
                fullPage: true,
                animations: "disabled",
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
      await capture("input");
      const downloading = page.waitForEvent("download");
      await page.getByRole("button", { name: "Download blank template", exact: true }).click();
      const download = await downloading;
      assert.equal(download.suggestedFilename(), "markiro-receiving-v1.csv");
      const chunks = [];
      for await (const chunk of await download.createReadStream()) chunks.push(chunk);
      assert.equal(Buffer.concat(chunks).toString("utf8"), columns + "\n");
      const fileInput = page.getByLabel("CSV file", { exact: true });
      await fileInput.setInputFiles({
        name: "invalid.csv",
        mimeType: "text/csv",
        buffer: Buffer.from(columns + "\n" + ",".repeat(1000) + "\n"),
      });
      await page.getByRole("button", { name: "Preview file", exact: true }).click();
      await expect(
        page.getByText(
          "Showing the first 18 of 1001 cells. Correct the column count in the original file.",
        ),
      ).toBeVisible();
      await expect(
        page.getByRole("button", { name: "Continue to confirmation", exact: true }),
      ).toBeDisabled();
      await capture("invalid");
      await page.getByRole("button", { name: "Back to file", exact: true }).click();
      const cells = [
        product.id,
        "",
        "create_on_finalize",
        "",
        "00042",
        "",
        "",
        "",
        "",
        "5.000",
        "lb",
        "false",
        "",
        "",
        "",
        "",
        "00007",
        "  Synthetic delivery  ",
      ];
      await fileInput.setInputFiles({
        name: "delivery.csv",
        mimeType: "text/csv",
        buffer: Buffer.from(columns + "\n" + cells.join(",") + "\n"),
      });
      await page.getByLabel("Date received", { exact: true }).fill("2026-09-09");
      const previewResponse = page.waitForResponse((r) => r.url().endsWith("/imports/preview"));
      await page.getByRole("button", { name: "Preview file", exact: true }).click();
      const savedPreview = await (await previewResponse).json();
      await expect(
        page.getByRole("button", { name: "Continue to confirmation", exact: true }),
      ).toBeEnabled();
      await page.getByText("Row 1 · file line 2", { exact: true }).click();
      await expect(page.getByText("00007", { exact: true })).toBeVisible();
      await expect(page.getByRole("heading", { name: "Value changes", exact: true })).toBeVisible();
      assert.equal(savedPreview.proposedDraft.items[0].notes, "Synthetic delivery");
      await capture("review");
      await page.getByRole("button", { name: "Continue to confirmation", exact: true }).click();
      await expect(
        page.getByRole("button", { name: "Create receiving draft", exact: true }),
      ).toBeDisabled();
      const confirmation = page.getByRole("checkbox", {
        name: "I reviewed the file and common receiving data.",
        exact: true,
      });
      await confirmation.focus();
      await page.keyboard.press("Space");
      await expect(confirmation).toBeChecked();
      await capture("confirm");
      const attempts = [];
      let ack;
      const pattern = "**/api/us/traceability/receiving/imports/*/apply";
      const loseFirst = async (route) => {
        attempts.push(route.request().postDataJSON());
        if (attempts.length > 1) return route.continue();
        const response = await route.fetch();
        assert.equal(response.status(), 200);
        ack = await response.json();
        return route.abort("failed");
      };
      await page.route(pattern, loseFirst);
      await page.getByRole("button", { name: "Create receiving draft", exact: true }).click();
      await expect(
        page.getByRole("button", { name: "Retry same operation", exact: true }),
      ).toBeVisible();
      await capture("unknown");
      assert.equal(attempts.length, 1);
      // Acknowledgement recovery must not substitute for the subsequent live read.
      let reads = 0;
      const recordPattern = `**/api/us/traceability/receiving/${ack.receipt.eventId}`;
      await page.route(recordPattern, async (route) => {
        reads++;
        if (reads === 1) return route.abort("failed");
        return route.continue();
      });
      await page.getByRole("button", { name: "Retry same operation", exact: true }).click();
      await expect(
        page.getByRole("button", { name: "Load current record", exact: true }),
      ).toBeVisible();
      await capture("read-recovery");
      assert.equal(attempts.length, 2);
      assert.deepEqual(attempts[0], attempts[1]);
      await page.getByRole("button", { name: "Load current record", exact: true }).click();
      await expect(
        page.getByRole("heading", { name: ack.receipt.record.eventNumber, exact: true }),
      ).toBeVisible();
      await expect(page.getByLabel("Quantity", { exact: true })).toHaveValue("5.000");
      await expect(page.getByLabel("Lot code (TLC)", { exact: true })).toHaveValue("00042");
      assert.equal(reads, 2);
      assert.equal(attempts.length, 2);
      await expect(page.getByRole("button", { name: "Export CSV", exact: true })).toBeEnabled();
      await capture("saved-export");
      const exportResponse = page.waitForResponse((response) =>
        response.url().includes(`/receiving/${ack.receipt.eventId}/export.csv?`),
      );
      const exportDownload = page.waitForEvent("download");
      await page.getByRole("button", { name: "Export CSV", exact: true }).click();
      const [binaryResponse, savedDownload] = await Promise.all([exportResponse, exportDownload]);
      assert.equal(binaryResponse.status(), 200);
      const exportChunks = [];
      for await (const chunk of await savedDownload.createReadStream()) exportChunks.push(chunk);
      const exportBytes = Buffer.concat(exportChunks);
      const decodedExport = decodeReceivingCsvExport(new Uint8Array(exportBytes));
      assert.equal(decodedExport.record.id, ack.receipt.eventId);
      assert.equal(decodedExport.record.draftVersion, ack.receipt.record.draftVersion);
      assert.equal(
        decodedExport.record.lifecycle.lifecycleVersion,
        ack.receipt.record.lifecycle.lifecycleVersion,
      );
      assert.equal(
        binaryResponse.headers()["x-markiro-export-sha256"],
        createHash("sha256").update(exportBytes).digest("hex"),
      );
      assert.equal(
        savedDownload.suggestedFilename(),
        `markiro-receiving-${ack.receipt.eventId}-r${ack.receipt.record.revision}-d${ack.receipt.record.draftVersion}-l${ack.receipt.record.lifecycle.lifecycleVersion}.csv`,
      );
      await expect(page.getByRole("status").filter({ hasText: "Download ready." })).toBeVisible();
      const exportAudits = (
        await fixture.pool.query(
          "SELECT organization_id,actor_user_id,action,outcome,target_type,target_id,before,after FROM tenant_audit_events WHERE organization_id=$1 AND action='traceability.receiving.csv_generated'",
          [fixture.tenantId],
        )
      ).rows;
      assert.equal(exportAudits.length, 1);
      assert.equal(exportAudits[0].organization_id, fixture.tenantId);
      assert.equal(exportAudits[0].actor_user_id, fixture.userId);
      assert.equal(exportAudits[0].target_type, "traceability_event");
      assert.equal(exportAudits[0].target_id, ack.receipt.eventId);
      assert.equal(exportAudits[0].action, "traceability.receiving.csv_generated");
      assert.equal(exportAudits[0].outcome, "success");
      assert.equal(exportAudits[0].before, null);
      assert.equal(
        exportAudits[0].after.sha256,
        createHash("sha256").update(exportBytes).digest("hex"),
      );
      assert.equal(exportAudits[0].after.byteCount, exportBytes.length);
      assert.equal(
        (
          await fixture.pool.query(
            "SELECT count(*)::int AS n FROM receiving_csv_applications WHERE tenant_id=$1",
            [fixture.tenantId],
          )
        ).rows[0].n,
        1,
      );
      const audit = (
        await fixture.pool.query(
          "SELECT organization_id,actor_user_id,action,outcome,target_type,target_id,before,after FROM tenant_audit_events WHERE organization_id=$1 AND action IN ('traceability.receiving.csv_applied','traceability.receiving.draft_created') ORDER BY action",
          [fixture.tenantId],
        )
      ).rows;
      assert.deepEqual(audit, [
        {
          organization_id: fixture.tenantId,
          actor_user_id: fixture.userId,
          action: "traceability.receiving.csv_applied",
          outcome: "success",
          target_type: "receiving_csv_preview",
          target_id: savedPreview.id,
          before: null,
          after: {
            importId: savedPreview.id,
            eventId: ack.receipt.eventId,
            fileSha256: savedPreview.fileSha256,
            templateVersion: "markiro-receiving-v1",
            rowCount: 1,
            inputDigest: savedPreview.previewDigest,
          },
        },
        {
          organization_id: fixture.tenantId,
          actor_user_id: fixture.userId,
          action: "traceability.receiving.draft_created",
          outcome: "success",
          target_type: "traceability_event",
          target_id: ack.receipt.eventId,
          before: null,
          after: ack.receipt.record,
        },
      ]);
      assert.equal(
        await page.evaluate(
          () =>
            Object.keys(localStorage).every((key) => key === "markiro.theme") &&
            sessionStorage.length === 0,
        ),
        true,
      );
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
