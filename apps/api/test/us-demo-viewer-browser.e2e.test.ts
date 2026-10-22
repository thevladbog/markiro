import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { unzipSync } from "fflate";
import { afterAll, beforeAll, describe, it } from "vitest";
import {
  usEventListSchema,
  usTraceSearchPageSchema,
  usCurrentTraceResultSchema,
  usLotCardSchema,
  usReadinessResultSchema,
  usRequestRunDetailSchema,
} from "@markiro/platform-contracts";
import { makeUsSixMonthRegularChain } from "../src/modules/traceability/demo/us-six-month-chains";
import {
  makeUsSixMonthSpecialExamples,
  usSixMonthRequestSelections,
} from "../src/modules/traceability/demo/us-six-month-definition";
import {
  startUsDemoViewerBrowserFixture,
  viewerBrowserPhase,
  viewerBrowserFailure,
  viewerHistoryPresentation,
  type ViewerHistoryExpectation,
  type UsDemoViewerBrowserFixture,
  type ViewerResponse,
} from "./support/us-demo-viewer-browser-fixture";

const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const authTables = new Set([
  "user",
  "session",
  "verification",
  "us_two_factors",
  "us_session_assurances",
]);
const business = (snapshot: Record<string, string>) =>
  Object.fromEntries(
    Object.entries(snapshot).filter(
      ([name]) => !authTables.has(name) && name !== "tenant_audit_events",
    ),
  );
const withoutAudit = (snapshot: Record<string, string>) =>
  Object.fromEntries(Object.entries(snapshot).filter(([name]) => name !== "tenant_audit_events"));

// One context/installation deliberately owns the serial journey and every release.
describe.skipIf(process.env.US_TEST_DATABASE_URL === undefined)(
  "Actual CI full-volume synthetic viewer",
  () => {
    let fixture: UsDemoViewerBrowserFixture | undefined;
    beforeAll(async () => {
      fixture = await startUsDemoViewerBrowserFixture();
    }, 960_000);
    afterAll(async () => {
      await fixture?.close();
    }, 60_000);

    it(
      "uses normal UI MFA, browses six months and verifies all 18 releases plus Plan and three ZIP downloads without business writes",
      async () =>
        viewerBrowserPhase("journey", async () => {
          if (!fixture) throw viewerBrowserFailure("installation");
          const f = fixture,
            { page, context, webExpect } = f;
          const start = performance.now();
          let pageErrors = 0,
            offOrigin = 0,
            authenticated = false;
          page.on("pageerror", () => {
            pageErrors++;
          });
          await page.route("**/*", async (route) => {
            if (new URL(route.request().url()).origin === f.origin) await route.continue();
            else {
              offOrigin++;
              await route.abort();
            }
          });
          const before = await f.snapshot(),
            identityBefore = await f.identitySnapshot(),
            auditBefore = await f.auditSnapshot();
          assert.ok(Object.keys(before).length > 190);
          assert.deepEqual(await f.authFacts(), {
            users: 2,
            accounts: 2,
            sessions: 0,
            verifications: 0,
            factors: 0,
            assurances: 0,
            valid_session: true,
            valid_factor: true,
            valid_assurance: true,
            enabled: false,
          });
          const privateBefore = await f.privateSnapshot();
          const providerBefore = f.providerSnapshot();
          assert.equal(providerBefore.active, 0);
          await viewerBrowserPhase("authentication", async () => {
            const apiRequire = createRequire(resolve(__dirname, "../package.json"));
            const authRequire = createRequire(apiRequire.resolve("better-auth"));
            const { createOTP } = authRequire("@better-auth/utils/otp") as {
              createOTP(secret: string): { totp(): Promise<string> };
            };
            const { base32 } = authRequire("@better-auth/utils/base32") as {
              base32: { decode(value: string): Uint8Array };
            };
            await page.goto(f.origin);
            await page
              .getByLabel("Email", { exact: true })
              .fill("viewer@us-development.example.test");
            await page.getByLabel("Password", { exact: true }).fill(f.password);
            await page.getByRole("button", { name: "Sign in", exact: true }).click();
            await webExpect(
              page.getByRole("heading", {
                name: "Set up multi-factor authentication",
                exact: true,
              }),
            ).toBeVisible();
            await page.getByLabel("Confirm password", { exact: true }).fill(f.password);
            await page.getByRole("button", { name: "Set up authenticator", exact: true }).click();
            const key = page
              .getByText("Manual authenticator setup key", { exact: true })
              .locator("+ dd");
            await webExpect(key).toBeVisible();
            const encoded = await key.textContent();
            if (!encoded) throw viewerBrowserFailure("authentication");
            const secret = new TextDecoder().decode(base32.decode(encoded.trim()));
            await page
              .getByRole("checkbox", { name: "I saved these backup codes", exact: true })
              .check();
            await page
              .getByLabel("6-digit authenticator code", { exact: true })
              .pressSequentially(await createOTP(secret).totp());
            await page.getByRole("button", { name: "Verify", exact: true }).click();
            await webExpect(
              page.getByRole("heading", { name: "Select an organization", exact: true }),
            ).toBeVisible();
            await webExpect(key).toHaveCount(0);
            await webExpect(page.locator('input[type="password"]')).toHaveCount(0);
            await webExpect(
              page.getByLabel("6-digit authenticator code", { exact: true }),
            ).toHaveCount(0);
            await webExpect(
              page.getByRole("checkbox", { name: "I saved these backup codes", exact: true }),
            ).toHaveCount(0);
            await page
              .getByRole("button", { name: "Synthetic US development", exact: true })
              .click();
            await webExpect(
              page.getByText("Synthetic demo data — not real customer activity.", { exact: true }),
            ).toBeVisible();
            await webExpect(page.getByText("Read-only access", { exact: true })).toBeVisible();
            assert.deepEqual(await f.authFacts(), {
              users: 2,
              accounts: 2,
              sessions: 1,
              verifications: 0,
              factors: 1,
              assurances: 1,
              valid_session: true,
              valid_factor: true,
              valid_assurance: true,
              enabled: true,
            });
            authenticated = true;
          });
          const afterAuth = await f.snapshot();
          assert.deepEqual(business(afterAuth), business(before));
          assert.equal(await f.identitySnapshot(), identityBefore);
          assert.deepEqual(await f.auditSnapshot(), auditBefore);
          await page.getByRole("button", { name: "Open reference data", exact: true }).click();
          const nav = page.getByRole("navigation", { name: "Reference data", exact: true });
          const navigate = (name: string) => nav.getByRole("button", { name, exact: true }).click();
          async function boundedRead<T>(action: () => Promise<T>): Promise<T> {
            const started = performance.now();
            let closing: Promise<void> | undefined;
            const timer = setTimeout(() => {
              closing = context.close().catch(() => undefined);
            }, 5000);
            try {
              const value = await action();
              if (closing || performance.now() - started > 5000)
                throw viewerBrowserFailure("download");
              return value;
            } finally {
              clearTimeout(timer);
              await closing;
            }
          }
          async function jsonAction(
            predicate: (response: ViewerResponse) => boolean,
            action: () => Promise<unknown>,
          ) {
            const response = page.waitForResponse(predicate).then(async (value) => {
              assert.equal(value.status(), 200);
              return boundedRead(() => value.json());
            });
            // Observe immediately, so an action failure never leaves a rejected body promise.
            const captured = response.then(
              (value) => ({ value }),
              () => ({ failed: true as const }),
            );
            await action();
            const result = await captured;
            if (!("value" in result)) throw viewerBrowserFailure("journey");
            return result.value;
          }
          const apiPath = (value: ViewerResponse, path: string) =>
            new URL(value.url()).pathname === `/api/us${path}` &&
            value.request().method() === "GET";
          const events = usEventListSchema.parse(
            await jsonAction(
              (r) => apiPath(r, "/traceability/events"),
              () => navigate("Events"),
            ),
          );
          assert.equal(events.items.length, 50);
          assert.equal(events.offset, 0);
          const next = usEventListSchema.parse(
            await jsonAction(
              (r) =>
                apiPath(r, "/traceability/events") &&
                new URL(r.url()).searchParams.get("offset") === "50",
              () => page.getByRole("button", { name: "Next", exact: true }).click(),
            ),
          );
          assert.equal(next.items.length, 50);
          assert.equal(next.offset, 50);
          assert.equal(
            next.items.some((row) => events.items.some((old) => old.id === row.id)),
            false,
          );
          await webExpect(
            page.getByRole("button", { name: "New receiving", exact: true }),
          ).toHaveCount(0);
          await webExpect(
            page.getByRole("button", { name: "New transformation", exact: true }),
          ).toHaveCount(0);
          await webExpect(
            page.getByRole("button", { name: "New shipping", exact: true }),
          ).toHaveCount(0);

          async function openLot(tlc: string, sscc?: string, history?: ViewerHistoryExpectation) {
            await navigate("Search");
            await page.getByRole("button", { name: "Reset", exact: true }).click();
            await page.getByLabel(sscc ? "SSCC" : "Exact TLC", { exact: true }).fill(sscc ?? tlc);
            const result = usTraceSearchPageSchema.parse(
              await jsonAction(
                (r) => apiPath(r, "/traceability/search"),
                () =>
                  page
                    .getByRole("region", { name: "Search", exact: true })
                    .getByRole("button", { name: "Search", exact: true })
                    .click(),
              ),
            );
            assert.equal(result.items.length, 1);
            const item = result.items[0];
            if (!item) throw viewerBrowserFailure("journey");
            assert.equal(item.tlc, tlc);
            const target = page.getByRole("button", {
              name: new RegExp(`^Open lot 1 · .+ · ${item.lotId}$`),
            });
            await webExpect(target).toHaveCount(1);
            let historyResponse: unknown;
            const card = usLotCardSchema.parse(
              await jsonAction(
                (r) => apiPath(r, `/traceability/lots/${item.lotId}/card`),
                async () => {
                  if (history)
                    historyResponse = await jsonAction(
                      (r) => apiPath(r, `/traceability/lots/${item.lotId}/trace/history`),
                      () => target.click(),
                    );
                  else await target.click();
                },
              ),
            );
            assert.equal(card.lot.id, item.lotId);
            assert.equal(card.lot.tlc, tlc);
            if (history) {
              const presentation = viewerHistoryPresentation(historyResponse, history);
              const row = page
                .getByRole("region", { name: "Excluded history", exact: true })
                .getByRole("listitem")
                .filter({
                  has: page.getByRole("button", { name: presentation.eventLabel, exact: true }),
                });
              await webExpect(row).toHaveCount(1);
              await webExpect(
                row.getByRole("button", { name: presentation.eventLabel, exact: true }),
              ).toBeVisible();
              await webExpect(
                row.getByText(presentation.statusDate, { exact: true }),
              ).toBeVisible();
            }
            await webExpect(
              page.getByRole("heading", { name: "Current lot summary", exact: true }),
            ).toBeVisible();
            return card;
          }
          const scenario = makeUsSixMonthRegularChain(259);
          assert.equal(scenario.transformation.output.tlc, "NRF-260915-APL01");
          const card = await openLot("NRF-260915-APL01", scenario.cases[0]);
          assert.deepEqual(card.balance, {
            state: "known",
            supply: "100",
            used: "100",
            remaining: "0",
            unitOfMeasure: "case",
          });
          assert.equal(card.caseSummary.activeCount, 100);
          assert.equal(card.firstEventDate, "2026-09-15");
          assert.equal(card.lastEventDate, "2026-09-16");
          await webExpect(
            page.getByText("Active Cases: 100 · Historical Cases: 0", { exact: true }),
          ).toBeVisible();
          await webExpect(
            page.getByText("Supply: 100 case · Used: 100 case", { exact: true }),
          ).toBeVisible();
          const back = usCurrentTraceResultSchema.parse(
            await jsonAction(
              (r) =>
                apiPath(r, `/traceability/lots/${card.lot.id}/trace`) &&
                new URL(r.url()).searchParams.get("direction") === "backward",
              () => page.getByRole("button", { name: "Trace backward", exact: true }).click(),
            ),
          );
          assert.equal(
            back.edges.filter(
              (edge) =>
                edge.kind === "transformation_input" &&
                edge.quantity === "500" &&
                edge.unitOfMeasure === "lb",
            ).length,
            2,
          );
          await page.getByRole("tab", { name: "Table", exact: true }).click();
          for (const tlc of ["OSS-260914-A1", "OSS-260914-A2"])
            await webExpect(
              page
                .getByRole("tabpanel")
                .getByRole("button", { name: new RegExp(`^Open lot ${tlc} · [a-f0-9-]{36}$`) }),
            ).toBeVisible();
          const forward = usCurrentTraceResultSchema.parse(
            await jsonAction(
              (r) =>
                apiPath(r, `/traceability/lots/${card.lot.id}/trace`) &&
                new URL(r.url()).searchParams.get("direction") === "forward",
              () => page.getByLabel("Direction", { exact: true }).selectOption("forward"),
            ),
          );
          assert.equal(
            forward.edges.filter(
              (edge) =>
                edge.kind === "shipping" &&
                edge.quantity === "100" &&
                edge.unitOfMeasure === "case",
            ).length,
            1,
          );
          await page.getByRole("tab", { name: "Graph", exact: true }).click();
          await webExpect(page.getByText("Current trace complete", { exact: true })).toBeVisible();
          const partial = makeUsSixMonthRegularChain(0);
          const partialCard = await openLot(partial.transformation.output.tlc);
          assert.deepEqual(partialCard.balance, {
            state: "known",
            supply: "55",
            used: "45",
            remaining: "10",
            unitOfMeasure: "case",
          });
          await webExpect(
            page.getByText("Supply: 55 case · Used: 45 case", { exact: true }),
          ).toBeVisible();
          const special = makeUsSixMonthSpecialExamples();
          const correctedLine = special.correction.correctedChain.receiving.lines[0];
          if (!correctedLine) throw viewerBrowserFailure("journey");
          const correctedHistory = f.history.find((entry) => entry.key === "corrected");
          assert.ok(correctedHistory);
          const correctedCard = await openLot(
            correctedLine.tlc,
            undefined,
            correctedHistory.expected,
          );
          assert.equal(correctedCard.balance.state, "known");
          if (correctedCard.balance.state === "known")
            assert.equal(correctedCard.balance.supply, "300");
          await webExpect(
            page.getByRole("heading", { name: "Excluded history", exact: true }),
          ).toBeVisible();
          const orphanLine = special.orphan.receiving.lines[0];
          if (!orphanLine) throw viewerBrowserFailure("journey");
          const orphanHistory = f.history.find((entry) => entry.key === "orphan");
          assert.ok(orphanHistory);
          const orphanCard = await openLot(orphanLine.tlc, undefined, orphanHistory.expected);
          assert.equal(orphanCard.originState, "gap");
          await webExpect(page.getByText("Current origin gap", { exact: true })).toBeVisible();
          await navigate("Data readiness");
          await page.getByLabel("Event date from", { exact: true }).fill("2026-04-01");
          await page.getByLabel("Event date to", { exact: true }).fill("2026-09-30");
          await page.getByLabel("Search lots", { exact: true }).fill(orphanLine.tlc);
          await jsonAction(
            (r) => apiPath(r, "/traceability/lots"),
            () => page.getByRole("button", { name: "Search lots", exact: true }).click(),
          );
          await page.getByLabel("Lot ID", { exact: true }).selectOption(orphanCard.lot.id);
          const readiness = usReadinessResultSchema.parse(
            await jsonAction(
              (r) =>
                apiPath(r, "/traceability/readiness") &&
                new URL(r.url()).searchParams.get("lotId") === orphanCard.lot.id,
              () => page.getByRole("button", { name: "Check scope", exact: true }).click(),
            ),
          );
          assert.ok(readiness.findings.some((finding) => finding.code === "origin_gap"));
          await webExpect(
            page.getByText("Current origin is missing", { exact: true }),
          ).toBeVisible();

          const expectedAudits: {
            action: string;
            targetType: string;
            targetId: string;
            requestId: string;
            after: unknown;
          }[] = [];
          function headers(
            response: ViewerResponse,
            descriptor: { name: string; mediaType: string; byteSize: number },
          ) {
            assert.equal(response.status(), 200);
            const h = response.headers();
            assert.equal(
              h["content-type"],
              descriptor.mediaType === "application/json"
                ? "application/json; charset=utf-8"
                : descriptor.mediaType,
            );
            assert.equal(h["content-length"], String(descriptor.byteSize));
            assert.equal(h["content-disposition"], `attachment; filename="${descriptor.name}"`);
            assert.equal(h["cache-control"], "no-store");
            assert.equal(h["x-content-type-options"], "nosniff");
            assert.equal(h.etag, undefined);
            const requestId = h["x-request-id"];
            if (!requestId || !/^[a-f0-9-]{36}$/.test(requestId))
              throw viewerBrowserFailure("download");
            return requestId;
          }
          async function browserDownload(
            path: string,
            button: () => Promise<void>,
            descriptor: { name: string; mediaType: string; byteSize: number; sha256: string },
            browserName = descriptor.name,
          ) {
            const responsePending = page
              .waitForResponse((r) => apiPath(r, path))
              .then(
                (value) => ({ value }),
                () => ({ failed: true as const }),
              );
            const pending = page.waitForEvent("download").then(
              (value) => ({ value }),
              () => ({ failed: true as const }),
            );
            await button();
            const received = await responsePending,
              downloaded = await pending;
            if (!("value" in received) || !("value" in downloaded))
              throw viewerBrowserFailure("download");
            const requestId = headers(received.value, descriptor),
              download = downloaded.value;
            assert.equal(download.suggestedFilename(), browserName);
            const bytes = await boundedRead(async () => {
              const stream = await download.createReadStream(),
                chunks: Buffer[] = [];
              let bytesRead = 0;
              try {
                for await (const value of stream) {
                  const bytes = Buffer.from(value as Uint8Array);
                  bytesRead += bytes.length;
                  if (bytesRead > descriptor.byteSize || bytesRead > 64 * 1024 * 1024)
                    throw viewerBrowserFailure("download");
                  chunks.push(bytes);
                }
              } finally {
                stream.destroy();
                await download.delete();
              }
              return Buffer.concat(chunks);
            });
            assert.equal(bytes.length, descriptor.byteSize);
            assert.equal(hash(bytes), descriptor.sha256);
            return { bytes, requestId };
          }
          await navigate("Plan");
          await page.getByRole("button", { name: "View v1", exact: true }).click();
          await webExpect(page.getByRole("button", { name: "New draft", exact: true })).toHaveCount(
            0,
          );
          const planDescriptor = {
            name: "traceability-plan.pdf",
            mediaType: "application/pdf",
            ...f.planResult.artifact,
          };
          const planDownload = await browserDownload(
            `/traceability/plans/${f.plan.id}/pdf`,
            () => page.getByRole("button", { name: "Download published PDF", exact: true }).click(),
            planDescriptor,
            "traceability-plan-v1.pdf",
          );
          assert.equal(planDownload.bytes.subarray(0, 5).toString(), "%PDF-");
          expectedAudits.push({
            requestId: planDownload.requestId,
            action: "traceability.plan.downloaded",
            targetType: "traceability_plan_version",
            targetId: f.plan.id,
            after: {
              versionNumber: f.planResult.plan.versionNumber,
              sha256: f.planResult.artifact.sha256,
            },
          });
          for (const selected of f.requests) {
            await navigate("Requests");
            const reference = usSixMonthRequestSelections.find(
              (row) => row.unitKey === selected.result.unitKey,
            )?.reference;
            if (!reference) throw viewerBrowserFailure("journey");
            await page.getByRole("button", { name: reference, exact: true }).click();
            await page.getByRole("tab", { name: "Package", exact: true }).click();
            await page.getByRole("button", { name: "Load run history", exact: true }).click();
            await page
              .getByRole("button", { name: `Open run ${selected.result.run.id}`, exact: true })
              .click();
            const frozen = page.getByRole("region", { name: "Frozen run", exact: true });
            await webExpect(frozen.getByText("Ready", { exact: true })).toBeVisible();
            for (const forbidden of [
              "New request",
              "Validate current sources",
              "Prepare Export-ready response",
              "Prepare incomplete response",
              "Retry",
            ])
              await webExpect(
                page.getByRole("button", { name: forbidden, exact: true }),
              ).toHaveCount(0);
            const detailResponse = await context.request.get(
              `${f.origin}/api/us/traceability/export-runs/${selected.result.run.id}`,
              { timeout: 5000, maxRedirects: 0 },
            );
            let detail;
            try {
              assert.equal(detailResponse.status(), 200);
              detail = usRequestRunDetailSchema.parse(
                await boundedRead(() => detailResponse.json()),
              );
            } finally {
              await detailResponse.dispose();
            }
            assert.equal(detail.runId, selected.result.run.id);
            assert.equal(detail.status, "ready");
            assert.equal(detail.mode, "export_ready");
            assert.equal(detail.exportReady, true);
            const releaseAudit = (
              requestId: string,
              artifact: (typeof selected.publication.artifacts)[number],
            ) =>
              expectedAudits.push({
                requestId,
                action: "traceability.request.artifact_downloaded",
                targetType: "trace_export_run",
                targetId: selected.result.run.id,
                after: {
                  requestId: selected.result.request.id,
                  requestRevision: selected.result.request.revision,
                  runRevision: selected.result.run.revision,
                  mode: "export_ready",
                  kind: artifact.kind,
                  byteSize: artifact.byteSize,
                  sha256: artifact.sha256,
                },
              });
            function verifyZip(bytes: Buffer) {
              const entries = unzipSync(bytes);
              assert.deepEqual(
                Object.keys(entries).sort(),
                selected.publication.expectation.entries.map((entry) => entry.name).sort(),
              );
              for (const entry of selected.publication.expectation.entries) {
                const bytes = entries[entry.name];
                if (!bytes) throw viewerBrowserFailure("download");
                assert.equal(bytes.length, entry.byteSize);
                assert.equal(hash(bytes), entry.sha256);
              }
              const manifest = entries["manifest.json"],
                pdf = entries["plan.pdf"],
                report = entries["request-report.pdf"];
              if (!manifest || !pdf || !report) throw viewerBrowserFailure("download");
              assert.deepEqual(
                JSON.parse(Buffer.from(manifest).toString()) as unknown,
                selected.publication.expectation.manifest,
              );
              assert.equal(hash(pdf), f.planResult.artifact.sha256);
              assert.equal(Buffer.from(report).subarray(0, 5).toString(), "%PDF-");
            }
            const zip = selected.publication.artifacts.find((row) => row.kind === "package_zip");
            if (!zip) throw viewerBrowserFailure("download");
            const browserZip = await browserDownload(
              `/traceability/export-runs/${selected.result.run.id}/artifacts/package_zip`,
              () =>
                frozen.getByRole("button", { name: "Download Package ZIP", exact: true }).click(),
              zip,
            );
            verifyZip(browserZip.bytes);
            releaseAudit(browserZip.requestId, zip);
            assert.deepEqual(selected.publication.artifacts.map((row) => row.kind).sort(), [
              "manifest",
              "package_zip",
              "plan_pdf",
              "request_report",
              "validation_report",
              "xlsx",
            ]);
            for (const artifact of selected.publication.artifacts) {
              const response = await context.request.get(
                `${f.origin}/api/us/traceability/export-runs/${selected.result.run.id}/artifacts/${artifact.kind}`,
                { timeout: 5000, maxRedirects: 0 },
              );
              try {
                const requestId = headers(response, artifact);
                assert.ok(artifact.byteSize > 0 && artifact.byteSize <= 64 * 1024 * 1024);
                const body = await boundedRead(() => response.body());
                assert.equal(body.length, artifact.byteSize);
                assert.equal(hash(body), artifact.sha256);
                if (artifact.kind === "package_zip") verifyZip(body);
                if (artifact.kind === "plan_pdf")
                  assert.equal(hash(body), f.planResult.artifact.sha256);
                releaseAudit(requestId, artifact);
              } finally {
                await response.dispose();
              }
            }
          }
          const evidence = resolve(
            __dirname,
            "../../../.superpowers/sdd/2026-10-22-us-11-demo-viewer/task-4-screenshots",
          );
          const screenshots: { name: string; sha256: string }[] = [];
          for (const viewport of [
            { width: 1440, height: 900 },
            { width: 390, height: 844 },
          ]) {
            await page.setViewportSize(viewport);
            for (const language of ["en", "es"] as const) {
              if (language === "es")
                await page.getByRole("button", { name: "Language", exact: true }).click();
              for (const theme of ["light", "dark"] as const) {
                if (theme === "dark")
                  await page
                    .getByRole("button", {
                      name: language === "en" ? "Change theme" : "Cambiar tema",
                      exact: true,
                    })
                    .click();
                await webExpect(page.locator("html")).toHaveAttribute("data-theme", theme);
                await webExpect(page.locator("html")).toHaveAttribute("lang", `${language}-US`);
                await webExpect(
                  page.getByText(
                    language === "en"
                      ? "Synthetic demo data — not real customer activity."
                      : "Datos de demostración sintéticos — no son actividad real de clientes.",
                    { exact: true },
                  ),
                ).toBeVisible();
                await webExpect(
                  page.getByText(
                    language === "en" ? "Read-only access" : "Acceso de solo lectura",
                    { exact: true },
                  ),
                ).toBeVisible();
                const themeControl = page.getByRole("button", {
                  name: language === "en" ? "Change theme" : "Cambiar tema",
                  exact: true,
                });
                await themeControl.focus();
                await webExpect(themeControl).toBeFocused();
                await page.keyboard.press("Space");
                await webExpect(page.locator("html")).toHaveAttribute(
                  "data-theme",
                  theme === "light" ? "dark" : "light",
                );
                await page.keyboard.press("Space");
                await webExpect(page.locator("html")).toHaveAttribute("data-theme", theme);
                if (!authenticated) throw viewerBrowserFailure("authentication");
                await mkdir(evidence, { recursive: true, mode: 0o700 });
                const name = `${viewport.width}-${language}-${theme}.png`,
                  bytes = await page.screenshot({ fullPage: true });
                await writeFile(resolve(evidence, name), bytes, { mode: 0o600, flag: "wx" });
                screenshots.push({ name, sha256: hash(bytes) });
              }
              await page
                .getByRole("button", {
                  name: language === "en" ? "Change theme" : "Cambiar tema",
                  exact: true,
                })
                .click();
              if (language === "es")
                await page.getByRole("button", { name: "Idioma", exact: true }).click();
            }
          }
          assert.equal(pageErrors, 0);
          assert.equal(offOrigin, 0);
          assert.equal(expectedAudits.length, 22);
          assert.equal(new Set(expectedAudits.map((row) => row.requestId)).size, 22);
          const audits = await f.auditSnapshot(),
            oldIds = new Set(auditBefore.map((row) => row.id));
          assert.deepEqual(
            audits.filter((row) => oldIds.has(row.id)),
            auditBefore,
          );
          const added = audits.filter((row) => !oldIds.has(row.id));
          assert.equal(added.length, 22);
          for (const wanted of expectedAudits) {
            const matching = added.filter((row) => row.requestId === wanted.requestId);
            assert.equal(matching.length, 1);
            const row = matching[0];
            if (!row) throw viewerBrowserFailure("snapshot");
            assert.match(row.id, /^[a-f0-9-]{36}$/);
            assert.ok(row.createdAt instanceof Date);
            const { id, createdAt, ...observed } = row;
            void id;
            void createdAt;
            assert.deepEqual(observed, {
              organizationId: f.tenantId,
              actorUserId: f.viewerUserId,
              outcome: "success",
              before: null,
              ...wanted,
            });
          }
          assert.deepEqual(withoutAudit(await f.snapshot()), withoutAudit(afterAuth));
          const providerAfter = f.providerSnapshot();
          assert.equal(providerAfter.mutations - providerBefore.mutations, 0);
          assert.equal(providerAfter.failures - providerBefore.failures, 0);
          assert.equal(providerAfter.active, 0);
          assert.equal(providerAfter.reads - providerBefore.reads, 22);
          const privateAfter = await f.privateSnapshot();
          assert.deepEqual(privateAfter, privateBefore);
          const finalProvider = f.providerSnapshot();
          assert.equal(finalProvider.mutations, providerBefore.mutations);
          assert.equal(finalProvider.failures, providerBefore.failures);
          assert.equal(finalProvider.active, 0);
          assert.equal(finalProvider.reads - providerAfter.reads, 19);
          assert.ok(performance.now() - start <= 300_000);
          console.info(
            "Viewer acceptance measured",
            JSON.stringify({
              ...f.measurements,
              journeyMs: performance.now() - start,
              releases: 22,
              individualReleases: 18,
              browserZipReleases: 3,
              browserPlanReleases: 1,
              viewerProviderReads: 22,
              independentVerificationReads:
                privateBefore.verificationReads + privateAfter.verificationReads,
              mutations: 0,
              failures: 0,
              active: 0,
              screenshots,
            }),
          );
        }),
      300_000,
    );
  },
);
