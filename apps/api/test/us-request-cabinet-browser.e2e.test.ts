import { createHash } from "node:crypto";
import { access, mkdir, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { createDb, schema } from "@markiro/db";
import { and, eq } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import {
  usRequestRunDetailSchema,
  usRequestCommandResponseSchema,
  usRequestPrepareResponseSchema,
} from "@markiro/platform-contracts";
import * as processes from "./support/us-request-worker-process-fixture";
import { startRequestCabinetBrowserFixture } from "./support/us-request-cabinet-browser-fixture";
import {
  createResponseObservation,
  readActionResponseBody,
} from "./support/us-browser-response-body";

const browserRequire = createRequire(resolve("../../tools/production-browser/package.json"));
const apiRequire = createRequire(resolve("package.json"));
const authRequire = createRequire(apiRequire.resolve("better-auth"));
// A small test-only structural bridge keeps API builds independent of installation
// in the separately pinned browser workspace. Its actual runtime is required below.
type Locator = {
  getByRole(role: string, options: { name: string; exact?: boolean }): Locator;
  getByText(name: string, options?: { exact: boolean }): Locator;
  locator(selector: string): Locator;
  and(other: Locator): Locator;
  click(): Promise<void>;
  fill(value: string): Promise<void>;
  check(): Promise<void>;
  pressSequentially(value: string): Promise<void>;
  textContent(): Promise<string | null>;
  selectOption(value: string): Promise<unknown>;
  focus(): Promise<void>;
  scrollIntoViewIfNeeded(): Promise<void>;
  evaluate<T>(callback: (element: HTMLElement) => T | Promise<T>): Promise<T>;
  count(): Promise<number>;
};
type BrowserRequest = { url(): string; method(): string; resourceType(): string };
type ObservationEvents = {
  request: (request: BrowserRequest) => void;
  requestfinished: (request: BrowserRequest) => void;
  requestfailed: (request: BrowserRequest) => void;
  framenavigated: (frame: object) => void;
  close: () => void;
  crash: () => void;
};
type BrowserResponse = {
  url(): string;
  request(): BrowserRequest;
  status(): number;
  fromServiceWorker(): boolean;
  json(): Promise<unknown>;
};
type BrowserDownload = { suggestedFilename(): string; saveAs(path: string): Promise<void> };
type BrowserPage = {
  getByRole(role: string, options: { name: string; exact?: boolean }): Locator;
  getByLabel(name: string, options?: { exact: boolean }): Locator;
  getByText(name: string, options?: { exact: boolean }): Locator;
  locator(selector: string): Locator;
  goto(url: string): Promise<unknown>;
  setDefaultTimeout(ms: number): void;
  setViewportSize(size: { width: number; height: number }): Promise<void>;
  screenshot(options: { path: string; fullPage: boolean }): Promise<unknown>;
  on(event: "pageerror", callback: () => void): void;
  on<K extends keyof ObservationEvents>(event: K, callback: ObservationEvents[K]): void;
  off<K extends keyof ObservationEvents>(event: K, callback: ObservationEvents[K]): void;
  mainFrame(): object;
  route(
    pattern: string,
    callback: (route: {
      request(): { url(): string };
      continue(): Promise<void>;
      abort(): Promise<void>;
    }) => Promise<void>,
  ): Promise<void>;
  waitForResponse(predicate: (response: BrowserResponse) => boolean): Promise<BrowserResponse>;
  waitForEvent(event: "download"): Promise<BrowserDownload>;
  evaluate<T>(callback: () => T | Promise<T>): Promise<T>;
  keyboard: { press(key: string): Promise<void> };
};
type BrowserContext = {
  newPage(): Promise<BrowserPage>;
  close(): Promise<void>;
  request: { get(url: string): Promise<BrowserResponse> };
};
type Browser = {
  close(): Promise<void>;
  newContext(options: {
    viewport: { width: number; height: number };
    colorScheme: "light";
    acceptDownloads: boolean;
  }): Promise<BrowserContext>;
};
type BrowserAssertions = {
  toBeVisible(options?: { timeout: number }): Promise<void>;
  toHaveCount(count: number): Promise<void>;
  toHaveText(text: string): Promise<void>;
  toHaveAttribute(name: string, value: string): Promise<void>;
  toBeDisabled(): Promise<void>;
  toBeFocused(): Promise<void>;
};
const { createOTP } = authRequire("@better-auth/utils/otp") as {
  createOTP(secret: string): { totp(): Promise<string> };
};
const { base32 } = authRequire("@better-auth/utils/base32") as {
  base32: { decode(input: string): Uint8Array };
};
const url = process.env.US_TEST_DATABASE_URL;
const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

describe.skipIf(url === undefined)("Configured real Requests cabinet browser", () => {
  it("uses real MFA, fresh validation, separate worker, verified frozen packages and closed history", async () => {
    const { chromium, expect: webExpect } = browserRequire("@playwright/test") as {
      chromium: { executablePath(): string; launch(): Promise<Browser> };
      expect(locator: Locator): BrowserAssertions;
    };
    const runtime = browserRequire("@playwright/test/package.json") as { version: string };
    expect(runtime.version).toBe("1.62.0");
    await access(chromium.executablePath());
    const observed = vi.spyOn(processes, "createWorkerProcessFixture");
    const fixture = await startRequestCabinetBrowserFixture(url!);
    const owned: processes.WorkerProcessFixture = await observed.mock.results[0]?.value;
    let databaseName: string | undefined;
    let browser: Browser | undefined;
    let context: BrowserContext | undefined;
    try {
      databaseName = (
        await owned.database.pool.query<{ name: string }>("SELECT current_database() AS name")
      ).rows[0]?.name;
      browser = await chromium.launch();
      context = await browser.newContext({
        viewport: { width: 1440, height: 900 },
        colorScheme: "light",
        acceptDownloads: true,
      });
      const page = await context.newPage();
      page.setDefaultTimeout(15_000);
      const errors: string[] = [];
      page.on("pageerror", () => errors.push("pageerror"));
      await page.route("**/*", async (route) => {
        if (new URL(route.request().url()).origin === fixture.origin) await route.continue();
        else {
          errors.push("unexpected origin");
          await route.abort();
        }
      });
      await page.goto(fixture.origin);
      await page.getByLabel("Email", { exact: true }).fill(fixture.email);
      await page.getByLabel("Password", { exact: true }).fill(fixture.password);
      await page.getByRole("button", { name: "Sign in", exact: true }).click();
      await webExpect(
        page.getByRole("heading", { name: "Set up multi-factor authentication" }),
      ).toBeVisible();
      await page.getByLabel("Confirm password", { exact: true }).fill(fixture.password);
      await page.getByRole("button", { name: "Set up authenticator", exact: true }).click();
      const key = page.getByText("Manual authenticator setup key", { exact: true }).locator("+ dd");
      await webExpect(key).toBeVisible();
      const encoded = await key.textContent();
      if (!encoded) throw new Error("Missing private authenticator material");
      const secret = new TextDecoder().decode(base32.decode(encoded.trim()));
      await page.getByRole("checkbox", { name: "I saved these backup codes" }).check();
      await page
        .getByLabel("6-digit authenticator code", { exact: true })
        .pressSequentially(await createOTP(secret).totp());
      await page.getByRole("button", { name: "Verify", exact: true }).click();
      await webExpect(page.getByRole("heading", { name: "Select an organization" })).toBeVisible();
      await webExpect(key).toHaveCount(0);
      await page.getByRole("button", { name: "Synthetic receiving", exact: true }).click();
      await page.getByRole("button", { name: "Open reference data", exact: true }).click();
      await page.getByRole("button", { name: "Requests", exact: true }).click();
      await page.getByRole("button", { name: "New request", exact: true }).click();
      await page.getByLabel("Request number", { exact: true }).fill("SYNTHETIC-BROWSER-001");
      await page.getByLabel("Requester name", { exact: true }).fill("Synthetic browser requester");
      const received = new Date(Date.now() - 3_600_000);
      received.setUTCSeconds(0, 0);
      const parts = new Intl.DateTimeFormat("en-US", {
        timeZone: "America/Chicago",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        hourCycle: "h23",
      }).formatToParts(received);
      const part = (type: Intl.DateTimeFormatPartTypes) => {
        const value = parts.find((entry) => entry.type === type)?.value;
        if (!value) throw new Error("Missing actual-clock wall-time field");
        return value;
      };
      const receiptWall = `${part("year")}-${part("month")}-${part("day")}T${part("hour")}:${part("minute")}`;
      await page.getByLabel("Received at", { exact: true }).fill(receiptWall);
      const offset = page.getByLabel("Receipt UTC offset", { exact: true });
      if (await offset.count()) {
        await offset.selectOption(
          String((Date.parse(`${receiptWall}:00Z`) - received.getTime()) / 1000),
        );
      }
      const command = await (async () => {
        // Post-auth, first create only. No request/response objects enter the ledger.
        const observation = createResponseObservation();
        const started = performance.now();
        const elapsed = () => performance.now() - started;
        let matched: BrowserRequest | undefined;
        const invalid = () => observation.record(undefined, elapsed());
        const requestStarted = (request: BrowserRequest) => {
          try {
            if (!request.url().endsWith("/traceability/requests") || request.method() !== "POST")
              return;
            if (matched) {
              invalid();
              return;
            }
            matched = request;
            observation.record("request-started", elapsed());
          } catch {
            invalid();
          }
        };
        const requestFinished = (request: BrowserRequest) => {
          if (request === matched) observation.record("request-finished", elapsed());
        };
        const requestFailed = (request: BrowserRequest) => {
          if (request === matched) observation.record("request-failed", elapsed());
        };
        const navigated = (frame: object) =>
          observation.record(
            frame === page.mainFrame() ? "main-frame-navigation" : "child-frame-navigation",
            elapsed(),
          );
        const closed = () => observation.record("page-close", elapsed());
        const crashed = () => observation.record("page-crash", elapsed());
        page.on("request", requestStarted);
        page.on("requestfinished", requestFinished);
        page.on("requestfailed", requestFailed);
        page.on("framenavigated", navigated);
        page.on("close", closed);
        page.on("crash", crashed);
        try {
          const created = page
            .waitForResponse(
              (r) => r.url().endsWith("/traceability/requests") && r.request().method() === "POST",
            )
            .then((response) => {
              try {
                if (response.request() !== matched) invalid();
                else
                  observation.record("response", elapsed(), {
                    status: response.status(),
                    sameOrigin: new URL(response.url()).origin === fixture.origin,
                    fromServiceWorker: response.fromServiceWorker(),
                    resourceType: response.request().resourceType(),
                  });
              } catch {
                invalid();
              }
              // Delegates the original single body read, retaining its receiver and exact result.
              return { json: () => observation.observe("body", elapsed, () => response.json()) };
            });
          return usRequestCommandResponseSchema.parse(
            await readActionResponseBody(created, () =>
              observation.observe("action", elapsed, () =>
                page.getByRole("button", { name: "Save request", exact: true }).click(),
              ),
            ),
          );
        } catch (error) {
          // Diagnostic output must never replace the original action/body/schema failure.
          try {
            const line = observation.failureLine();
            if (line !== undefined) console.error(line);
          } catch {
            /* No raw diagnostic errors. */
          }
          throw error;
        } finally {
          observation.stop();
          page.off("request", requestStarted);
          page.off("requestfinished", requestFinished);
          page.off("requestfailed", requestFailed);
          page.off("framenavigated", navigated);
          page.off("close", closed);
          page.off("crash", crashed);
        }
      })();
      const request = { id: command.requestId };
      await webExpect(page.getByRole("tab", { name: "Scope", exact: true })).toBeVisible();
      await page.getByRole("tab", { name: "Scope", exact: true }).click();
      await page.getByRole("button", { name: "Edit scope", exact: true }).click();
      await page.getByLabel("Lot ID", { exact: true }).selectOption(fixture.lotId);
      const savedScopeResponse = page.waitForResponse(
        (r) => r.url().endsWith(`/requests/${request.id}`) && r.request().method() === "PATCH",
      );
      const savedScope = usRequestCommandResponseSchema.parse(
        await readActionResponseBody(savedScopeResponse, () =>
          page.getByRole("button", { name: "Save scope", exact: true }).click(),
        ),
      );
      await page.getByRole("tab", { name: "Validation", exact: true }).click();
      await page.getByRole("button", { name: "Validate current sources", exact: true }).click();
      await webExpect(
        page.getByText("Fresh validation of captured request revision", { exact: true }),
      ).toBeVisible();
      await webExpect(page.getByText("plan_absent", { exact: true })).toBeVisible();
      await page.getByRole("tab", { name: "Package", exact: true }).click();
      await webExpect(
        page.getByRole("button", { name: "Prepare Export-ready response", exact: true }),
      ).toBeDisabled();
      const prepare = () =>
        page.waitForResponse(
          (r) =>
            r.url().endsWith(`/requests/${request.id}/prepare`) && r.request().method() === "POST",
        );
      const incompleteResponse = prepare();
      const incomplete = usRequestPrepareResponseSchema.parse(
        await readActionResponseBody(incompleteResponse, () =>
          page.getByRole("button", { name: "Prepare incomplete response", exact: true }).click(),
        ),
      );
      const frozen = page.getByRole("region", { name: "Frozen run", exact: true });
      await webExpect(frozen.getByText("Queued", { exact: true })).toBeVisible();
      await webExpect(
        frozen.getByRole("button", { name: "Download Package ZIP", exact: true }),
      ).toBeDisabled();
      expect(fixture.workerPid()).toBeNull();
      await fixture.startWorker();
      expect(fixture.workerPid()).toBeTypeOf("number");
      expect(fixture.workerPid()).not.toBe(process.pid);
      await webExpect(frozen.getByText("Ready", { exact: true })).toBeVisible({ timeout: 150_000 });
      const readRun = async (runId: string) => {
        const response = await context!.request.get(
          `${fixture.origin}/api/us/traceability/export-runs/${runId}`,
        );
        expect(response.status()).toBe(200);
        return usRequestRunDetailSchema.parse(await response.json());
      };
      const first = await readRun(incomplete.runId);
      expect(first.request.receivedAt).toBe(received.toISOString());
      expect(
        Date.parse(first.startedAt) - Date.parse(first.request.receivedAt),
      ).toBeGreaterThanOrEqual(0);
      expect(first.mode).toBe("available_records_incomplete");
      expect(first.missingFiles).toEqual(
        expect.arrayContaining([expect.objectContaining({ code: "plan_absent" })]),
      );
      const screenshots = resolve(
        "../../.superpowers/sdd/2026-10-05-us-09-requests-cabinet/task-8-screenshots",
      );
      await mkdir(screenshots, { recursive: true });
      const verifyDownload = async (run: typeof first, kind: "package_zip" | "plan_pdf") => {
        const descriptor = run.artifacts.find((a) => a.kind === kind);
        if (!descriptor) throw new Error("Expected actual published artifact");
        const download = page.waitForEvent("download");
        await frozen
          .getByRole("button", {
            name: kind === "package_zip" ? "Download Package ZIP" : "Download Plan PDF",
            exact: true,
          })
          .click();
        const result = await download;
        expect(result.suggestedFilename()).toBe(descriptor.name);
        const file = resolve(screenshots, `${run.runRevision}-${kind}-${descriptor.name}`);
        await result.saveAs(file);
        const bytes = await readFile(file);
        expect(bytes.length).toBe(descriptor.byteSize);
        expect(hash(bytes)).toBe(descriptor.sha256);
        return hash(bytes);
      };
      const firstZip = await verifyDownload(first, "package_zip");
      await fixture.approvePlan();
      expect(await readRun(first.runId)).toEqual(first);
      await page.getByRole("button", { name: "Refresh request", exact: true }).click();
      await page.getByRole("tab", { name: "Validation", exact: true }).click();
      await page.getByRole("button", { name: "Validate current sources", exact: true }).click();
      await webExpect(
        page.getByText("Fresh validation of captured request revision", { exact: true }),
      ).toBeVisible();
      await webExpect(page.getByText("plan_absent", { exact: true })).toHaveCount(0);
      await page.getByRole("tab", { name: "Package", exact: true }).click();
      const readyResponse = prepare();
      const accepted = usRequestPrepareResponseSchema.parse(
        await readActionResponseBody(readyResponse, () =>
          page.getByRole("button", { name: "Prepare Export-ready response", exact: true }).click(),
        ),
      );
      await webExpect(frozen.getByText(accepted.runId, { exact: true })).toBeVisible();
      await webExpect(frozen.getByText("Ready", { exact: true })).toBeVisible({ timeout: 150_000 });
      const second = await readRun(accepted.runId);
      expect(second.mode).toBe("export_ready");
      expect(second.runRevision).toBe(first.runRevision + 1);
      expect(second.missingFiles).toEqual([]);
      expect(second.artifacts.some((a) => a.kind === "plan_pdf")).toBe(true);
      await verifyDownload(second, "package_zip");
      await verifyDownload(second, "plan_pdf");
      expect(await readRun(first.runId)).toEqual(first);
      await page.getByRole("tab", { name: "Requester and timing", exact: true }).click();
      await page.getByRole("button", { name: "Edit request", exact: true }).click();
      await page
        .getByLabel("Requester name", { exact: true })
        .fill("Synthetic edited live requester");
      const editResponse = page.waitForResponse(
        (r) => r.url().endsWith(`/requests/${request.id}`) && r.request().method() === "PATCH",
      );
      const edited = usRequestCommandResponseSchema.parse(
        await readActionResponseBody(editResponse, () =>
          page.getByRole("button", { name: "Save request", exact: true }).click(),
        ),
      );
      await webExpect(
        page.getByText("Synthetic edited live requester", { exact: true }),
      ).toBeVisible();
      expect(await readRun(second.runId)).toEqual(second);
      await page.getByRole("button", { name: "Close request", exact: true }).click();
      const closeResponse = page.waitForResponse(
        (r) => r.url().endsWith(`/requests/${request.id}/close`) && r.request().method() === "POST",
      );
      const closed = usRequestCommandResponseSchema.parse(
        await readActionResponseBody(closeResponse, () =>
          page.getByRole("button", { name: "Confirm close", exact: true }).click(),
        ),
      );
      await webExpect(page.getByRole("button", { name: "Edit request", exact: true })).toHaveCount(
        0,
      );
      await page.getByRole("tab", { name: "Package", exact: true }).click();
      await page.getByRole("button", { name: "Load run history", exact: true }).click();
      await page.getByRole("button", { name: `Open run ${first.runId}`, exact: true }).click();
      await webExpect(
        frozen.getByText("Synthetic browser requester", { exact: true }),
      ).toBeVisible();
      expect(await verifyDownload(first, "package_zip")).toBe(firstZip);
      await frozen
        .getByRole("heading", { name: "Frozen run", exact: true })
        .scrollIntoViewIfNeeded();
      for (const language of ["en-US", "es-US"] as const) {
        if (language === "es-US")
          await page.getByRole("button", { name: "Language", exact: true }).click();
        for (const theme of ["light", "dark"] as const) {
          await webExpect(page.locator("html")).toHaveAttribute("data-theme", theme);
          for (const width of language === "es-US" ? [1440, 1024, 390] : [1440, 1024]) {
            await page.setViewportSize({ width, height: 900 });
            const brand = page.getByRole("img", { name: "Markiro", exact: true });
            const timingWidths = await page.evaluate(() =>
              Array.from(
                document.querySelectorAll(
                  ".us-requests > .mk-table tbody tr:first-child td:nth-child(2), .us-requests > .mk-table tbody tr:first-child td:nth-child(3)",
                ),
                (cell) => cell.getBoundingClientRect().width,
              ),
            );
            expect(timingWidths).toHaveLength(2);
            for (const timingWidth of timingWidths)
              expect(
                timingWidth,
                `${language} ${theme} ${width} timing column`,
              ).toBeGreaterThanOrEqual(240);
            await webExpect(brand).toHaveText("MARKIRO");
            await webExpect(brand.locator("svg rect")).toHaveCount(9);
            if (
              (language === "en-US" && theme === "light" && width === 1440) ||
              (language === "es-US" && theme === "dark" && width === 1024)
            ) {
              await page.evaluate(() => scrollTo(0, 0));
              await page.screenshot({
                path: resolve(screenshots, `requests-${language}-${theme}-${width}-viewport.png`),
                fullPage: false,
              });
            }
            if (width === 390) {
              await page
                .getByRole("heading", { name: "Ejecución congelada", exact: true })
                .scrollIntoViewIfNeeded();
              await page.screenshot({
                path: resolve(screenshots, `requests-${language}-${theme}-${width}-summary.png`),
                fullPage: false,
              });
              await page
                .getByRole("button", { name: "Descargar Paquete ZIP", exact: true })
                .scrollIntoViewIfNeeded();
              await page.screenshot({
                path: resolve(screenshots, `requests-${language}-${theme}-${width}-downloads.png`),
                fullPage: false,
              });
              const table = page
                .getByRole("region", { name: "Solicitudes", exact: true })
                .and(page.locator('[tabindex="0"]'));
              await table.focus();
              await webExpect(table).toBeFocused();
              const before = await table.evaluate((element) => ({
                left: element.scrollLeft,
                client: element.clientWidth,
                scroll: element.scrollWidth,
                overflow: getComputedStyle(element).overflowX,
              }));
              expect(before.overflow).toBe("auto");
              expect(before.client).toBeLessThanOrEqual(width);
              expect(before.scroll).toBeGreaterThan(before.client);
              await page.keyboard.press("ArrowRight");
              expect(await table.evaluate((element) => element.scrollLeft)).toBeGreaterThan(
                before.left,
              );
            }
            await page.screenshot({
              path: resolve(screenshots, `requests-${language}-${theme}-${width}.png`),
              fullPage: true,
            });
            const layout = await page.evaluate(async () => {
              const loaded = await document.fonts.load('600 16px "IBM Plex Mono"', "MARKIRO");
              return {
                font: loaded.some((f) => f.status === "loaded"),
                overflow: document.documentElement.scrollWidth > innerWidth,
                overflowing: Array.from(document.querySelectorAll("body *"))
                  .filter(
                    (e) =>
                      e.children.length === 0 &&
                      e.getBoundingClientRect().right > innerWidth + 1 &&
                      !e.closest('[role="region"][tabindex="0"]'),
                  )
                  .slice(-12)
                  .map((e) => ({
                    tag: e.tagName,
                    class: e.className,
                    width: e.getBoundingClientRect().width,
                  })),
              };
            });
            expect(layout.font).toBe(true);
            expect(
              layout.overflow,
              JSON.stringify({ language, theme, width, geometry: layout.overflowing }),
            ).toBe(false);
          }
          await page
            .getByRole("button", {
              name: language === "en-US" ? "Change theme" : "Cambiar tema",
              exact: true,
            })
            .click();
        }
      }
      await page.getByRole("tab", { name: "Paquete", exact: true }).focus();
      await page.keyboard.press("ArrowLeft");
      await webExpect(page.getByRole("tab", { name: "Validación", exact: true })).toBeFocused();
      expect(errors).toEqual([]);
      const audits = await owned.database.db
        .select()
        .from(schema.tenantAuditEvents)
        .where(
          and(
            eq(schema.tenantAuditEvents.organizationId, fixture.tenantId),
            eq(schema.tenantAuditEvents.targetId, request.id),
          ),
        );
      const prepared = audits.filter((a) => a.action === "traceability.request.prepared");
      expect(prepared).toHaveLength(2);
      expect(audits).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            action: "traceability.request.created",
            requestId: command.httpRequestId,
            organizationId: fixture.tenantId,
            actorUserId: fixture.actorId,
            outcome: "success",
            targetType: "trace_request",
            targetId: request.id,
            before: null,
            after: { revision: 1, status: "open", lastValidationDigest: null },
          }),
          expect.objectContaining({
            action: "traceability.request.updated",
            requestId: savedScope.httpRequestId,
            organizationId: fixture.tenantId,
            actorUserId: fixture.actorId,
            outcome: "success",
            targetType: "trace_request",
            targetId: request.id,
            before: { revision: 1, status: "open", lastValidationDigest: null },
            after: { revision: savedScope.revision, status: "open", lastValidationDigest: null },
          }),
          expect.objectContaining({
            action: "traceability.request.updated",
            requestId: edited.httpRequestId,
            organizationId: fixture.tenantId,
            actorUserId: fixture.actorId,
            outcome: "success",
            targetType: "trace_request",
            targetId: request.id,
            after: { revision: edited.revision, status: "open", lastValidationDigest: null },
          }),
          expect.objectContaining({
            action: "traceability.request.closed",
            requestId: closed.httpRequestId,
            organizationId: fixture.tenantId,
            actorUserId: fixture.actorId,
            outcome: "success",
            targetType: "trace_request",
            targetId: request.id,
            before: { revision: edited.revision, status: "open", lastValidationDigest: null },
            after: { revision: closed.revision, status: "closed", lastValidationDigest: null },
          }),
        ]),
      );
      for (const [index, run] of [first, second].entries()) {
        expect(prepared).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              requestId: index === 0 ? incomplete.httpRequestId : accepted.httpRequestId,
              organizationId: fixture.tenantId,
              actorUserId: fixture.actorId,
              outcome: "success",
              targetType: "trace_request",
              targetId: request.id,
              after: {
                runId: run.runId,
                revision: run.runRevision,
                requestRevision: run.requestRevision,
                mode: run.mode,
                digest: run.scopedContentDigest,
                inputDigest: run.inputDigest,
              },
            }),
          ]),
        );
        const publications = await owned.database.db
          .select()
          .from(schema.tenantAuditEvents)
          .where(
            and(
              eq(schema.tenantAuditEvents.organizationId, fixture.tenantId),
              eq(schema.tenantAuditEvents.targetId, run.runId),
              eq(schema.tenantAuditEvents.action, "traceability.request.worker.published"),
            ),
          );
        const attempts = await owned.database.db
          .select()
          .from(schema.traceExportAttempts)
          .where(
            and(
              eq(schema.traceExportAttempts.tenantId, fixture.tenantId),
              eq(schema.traceExportAttempts.runId, run.runId),
            ),
          );
        expect(attempts).toHaveLength(1);
        expect(attempts[0]).toMatchObject({
          status: "succeeded",
          runId: run.runId,
          tenantId: fixture.tenantId,
          attemptNumber: 1,
          cycle: 1,
        });
        expect(publications).toHaveLength(1);
        expect(publications[0]).toMatchObject({
          organizationId: fixture.tenantId,
          actorUserId: null,
          targetType: "trace_export_run",
          targetId: run.runId,
          outcome: "success",
          before: null,
          after: {
            actorKind: "system",
            initiatorId: fixture.actorId,
            requestId: request.id,
            runId: run.runId,
            runRevision: run.runRevision,
            mode: run.mode,
            attemptId: attempts[0]?.id,
            attemptNumber: 1,
            cycle: 1,
            cycleAttemptCount: 1,
            lifecycleVersion: run.lifecycleVersion,
            commandDigest: run.commandDigest,
            scopedContentDigest: run.scopedContentDigest,
            inputDigest: run.inputDigest,
            artifacts: expect.arrayContaining(
              run.artifacts.map(({ name, kind, sha256, byteSize }) => ({
                name,
                kind,
                sha256,
                byteSize,
              })),
            ),
          },
        });
      }
    } finally {
      try {
        await context?.close();
      } finally {
        try {
          await browser?.close();
        } finally {
          try {
            await fixture.close();
          } finally {
            observed.mockRestore();
          }
        }
      }
    }
    await expect(access(owned.build.root)).rejects.toThrow();
    if (!url || !databaseName || !/^markiro_us_profile_[a-f0-9_]+$/.test(databaseName))
      throw new Error("Owned database identity required for cleanup evidence");
    const connection = createDb(url);
    try {
      const result = await connection.pool.query<{ present: boolean }>(
        "SELECT EXISTS(SELECT 1 FROM pg_database WHERE datname = $1) AS present",
        [databaseName],
      );
      expect(result.rows[0]?.present).toBe(false);
    } finally {
      await connection.pool.end();
    }
    const pid = fixture.workerPid();
    if (pid === null) throw new Error("Real worker PID required for cleanup evidence");
    expect(() => process.kill(pid, 0)).toThrow();
  }, 300_000);
});
