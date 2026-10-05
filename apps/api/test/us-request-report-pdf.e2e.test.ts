import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import * as ReactPdf from "@react-pdf/renderer";
import { createElement } from "react";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { bindUsRequestPackageInputs } from "../src/modules/traceability/requests/us-request-package-inputs";
import type { UsRequestReportModel } from "../src/modules/traceability/requests/us-request-package-types";
import { renderUsRequestReportPdf } from "../src/modules/traceability/requests/us-request-report-pdf";
import { createUsProfileTestDatabase } from "./support/us-profile-database";
import { createUsRequestPackageFixture } from "./support/us-request-package-fixture";

function extractedPages(bytes: Buffer): string[] {
  const dir = mkdtempSync(join(tmpdir(), "markiro-us-request-pdf-test-"));
  try {
    const path = join(dir, "request-report.pdf");
    writeFileSync(path, bytes);
    return execFileSync("pdftotext", ["-layout", path, "-"], { encoding: "utf8" })
      .split("\f")
      .filter((page) => page.trim());
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
const textOf = (bytes: Buffer) => extractedPages(bytes).join(" ").replace(/\s+/gu, " ");
const compact = (text: string) => text.replace(/\s+/gu, "");
const evidenceDirectory = resolve(
  process.cwd(),
  "../../.superpowers/sdd/2026-10-04-us-09-package-core/task-2-pdf-evidence",
);
function retainEvidence(name: string, bytes: Buffer): void {
  mkdirSync(evidenceDirectory, { recursive: true });
  const path = join(evidenceDirectory, `${name}.pdf`);
  writeFileSync(path, bytes);
  execFileSync("pdftoppm", ["-r", "90", "-png", path, join(evidenceDirectory, name)]);
  writeFileSync(join(evidenceDirectory, `${name}.txt`), extractedPages(bytes).join("\f"));
}
async function failure(
  model: UsRequestReportModel,
  code: string,
  renderer = renderUsRequestReportPdf,
): Promise<void> {
  let caught: unknown;
  try {
    await renderer(model);
  } catch (error) {
    caught = error;
  }
  expect(caught).toHaveProperty("response", { code });
  expect(caught).not.toHaveProperty("cause");
  expect(JSON.stringify(caught)).not.toContain("private@example.test");
}

const url = process.env.US_TEST_DATABASE_URL;
// Removing a report field, collapsing counts or omitting a file/finding must fail real PDF assertions.
describe.skipIf(!url)("US request report real PDF in owned disposable PostgreSQL", () => {
  let db: Awaited<ReturnType<typeof createUsProfileTestDatabase>>;
  const fixtures: Awaited<ReturnType<typeof createUsRequestPackageFixture>>[] = [];
  let ready: UsRequestReportModel;
  let incomplete: UsRequestReportModel;
  let empty: UsRequestReportModel;
  beforeAll(async () => {
    if (!url) throw new Error("Missing isolated US database URL");
    db = await createUsProfileTestDatabase(url);
    for (const options of [
      { mode: "export_ready" as const },
      { mode: "available_records_incomplete" as const },
      { mode: "available_records_incomplete" as const, empty: true, withPlan: false },
    ])
      fixtures.push(await createUsRequestPackageFixture(db.db, options));
    const models = fixtures.map((c) =>
      bindUsRequestPackageInputs(c.run, c.tenantId, c.payloads, c.plan, c.context),
    );
    const a = models[0],
      b = models[1],
      c = models[2];
    if (!a || !b || !c) throw new Error("Missing fixtures");
    ready = a.model;
    incomplete = b.model;
    empty = c.model;
  }, 60_000);
  afterAll(async () => {
    for (const c of fixtures) c.destroy();
    await db?.close();
    vi.restoreAllMocks();
  });

  it("renders identical actual PDF bytes with frozen identity, timing, full upstream hashes and summary", async () => {
    const a = await renderUsRequestReportPdf(ready);
    const b = await renderUsRequestReportPdf(ready);
    expect(a.bytes).toEqual(b.bytes);
    expect(a).toMatchObject({ name: "request-report.pdf", mediaType: "application/pdf" });
    expect(a.sha256).toBe(createHash("sha256").update(a.bytes).digest("hex"));
    expect(a.byteSize).toBe(a.bytes.length);
    expect(a.bytes.subarray(0, 5).toString()).toBe("%PDF-");
    const text = textOf(a.bytes);
    for (const page of extractedPages(a.bytes)) {
      expect(page).toContain("MARKIRO · US trace request report");
      expect(page).toContain("Tenant origin not attested");
      expect(page).toMatch(/Page \d+ of \d+/u);
    }
    for (const value of [
      "Export-ready",
      "Tenant origin not attested",
      ready.identity.requestId,
      ready.request.requestNumber,
      ready.identity.runId,
      "Request revision: 1",
      "Run revision: 1",
      "Preparing actor ID: " + ready.identity.preparedBy,
      "Synthetic package requester",
      "Synthetic organization",
      "private@example.test",
      "Report data prepared at",
      "Elapsed to report data preparation: 2000 ms",
      "Captured revisions: 1",
      "Workbook events: 1",
      "receiving: 1",
      "current_finalized: 1",
      "Frozen validation findings",
      "XLSX-render findings",
      "validation.json",
      "full frozen findings, source revisions, lifecycle and genealogy",
      "Scoped-content digest",
      "Workbook-input digest",
      ready.stamps.baselineId,
      ready.stamps.registryId,
      ready.stamps.build.apiVersion,
      "designed to support applicable FSMA 204 recordkeeping requirements",
      "does not submit directly to FDA",
      "Package prepared in the U.S. instance; delivery to the requester is performed by the covered entity",
    ])
      expect(text).toContain(value);
    for (const value of [
      ready.digests.scopedContentDigest,
      ready.digests.inputDigest,
      ready.stamps.registryHash,
      ready.stamps.build.gitSha,
      ready.plan?.id,
      ready.plan?.pdfSha256,
      ...ready.preReportFiles.map((file) => file.sha256),
    ])
      if (value) expect(compact(text)).toContain(value);
    for (const file of ready.preReportFiles) {
      expect(text).toContain(file.name);
      expect(text).toContain(`${file.byteSize} bytes`);
    }
    for (const forbidden of [
      "Publication completed",
      "Render completed",
      "Verified operational",
      "active human",
      "session age",
      a.sha256,
      "manifest.json",
      "SHA256SUMS",
      "package.zip",
    ])
      expect(text).not.toContain(forbidden);
    const infoDir = mkdtempSync(join(tmpdir(), "markiro-us-request-info-"));
    try {
      const path = join(infoDir, "report.pdf");
      writeFileSync(path, a.bytes);
      const info = execFileSync("pdfinfo", ["-rawdates", path], { encoding: "utf8" });
      expect(info).toContain("612 x 792 pts (letter)");
      expect(info).toContain("us-request-report-pdf-v1");
      expect(info).not.toContain(ready.request.requesterContact);
      const expected =
        "D:" + ready.timing.reportDataPreparedAt.replace(/[-:T]/gu, "").slice(0, 14) + "Z";
      expect(info.match(/CreationDate:\s*(\S+)/u)?.[1]).toBe(expected);
      // Pinned React PDF 4.6.1 emits the frozen date under /ModificationDate.
      const raw = a.bytes.toString("latin1");
      const modificationRef = raw.match(/\/ModificationDate (\d+) 0 R/u)?.[1];
      expect(modificationRef).toBeDefined();
      expect(raw.includes(`${modificationRef} 0 obj\n(${expected})`)).toBe(true);
      expect(raw).not.toMatch(/\/ModDate\s/u);
    } finally {
      rmSync(infoDir, { recursive: true, force: true });
    }
    retainEvidence("ready", a.bytes);
  });

  it("keeps incomplete mode with optional files present and unknown worker time unavailable", async () => {
    const m = structuredClone(incomplete);
    m.timing.workerStartedAt = null;
    const result = await renderUsRequestReportPdf(m);
    const text = textOf(result.bytes);
    expect(text).toContain("Available records — incomplete");
    expect(text).toContain("Worker started: Unavailable");
    expect(text).toContain("Tenant origin not attested");
    expect(text).toContain("records.xlsx");
    expect(text).toContain("plan.pdf");
    expect(text).not.toContain("Export-ready");
    retainEvidence("incomplete", result.bytes);
  });

  it("shows empty selection and original Plan absence explicitly", async () => {
    const text = textOf((await renderUsRequestReportPdf(empty)).bytes);
    for (const value of [
      "Captured revisions: 0",
      "Workbook events: 0",
      "empty_selection",
      "plan_absent",
      "Pinned Plan: Absent",
      "Workbook-input digest: Unavailable",
    ])
      expect(text).toContain(value);
  });

  it("marks every page of trusted synthetic reports without an operational attestation", async () => {
    const m = structuredClone(ready);
    m.tenantOrigin = {
      schemaVersion: 1,
      verificationPolicy: "us-request-tenant-origin-v1",
      result: "trusted_synthetic",
      trustedSeed: { seedId: m.identity.tenantId, verifiedBy: "us-development-owner-v1" },
    };
    const pages = extractedPages((await renderUsRequestReportPdf(m)).bytes);
    for (const page of pages) {
      expect(page).toContain("Synthetic demo — not an operational record");
      expect(page).toMatch(/Page \d+ of \d+/u);
      expect(page).not.toContain("Verified operational");
    }
  });

  it("disambiguates both sides of the repeated DST hour with numeric offsets and UTC", async () => {
    const m = structuredClone(ready);
    m.stamps.timeZone = "America/Chicago";
    m.request.receivedAt = "2026-11-01T06:30:00.000Z";
    m.request.dueAt = "2026-11-01T07:30:00.000Z";
    const text = textOf((await renderUsRequestReportPdf(m)).bytes);
    expect(text).toContain("2026-11-01 01:30:00.000 (America/Chicago, UTC-05:00)");
    expect(text).toContain("2026-11-01 01:30:00.000 (America/Chicago, UTC-06:00)");
    expect(text).toContain("2026-11-01T06:30:00.000Z");
    expect(text).toContain("2026-11-01T07:30:00.000Z");
  });

  it("preserves multilingual requester, long scope/contact/build identifiers and full render findings across pages", async () => {
    const m = structuredClone(incomplete);
    m.request.requesterName = "José Müller — Анна Иванова; café € £ © ™";
    m.request.requesterContact = "contact-" + "B".repeat(480);
    m.request.alternateDeadlineReason = "Frozen alternate deadline: QA requested five more days.";
    m.scope = { tlc: "LOT-" + "A".repeat(116) };
    m.stamps.build.apiVersion = "synthetic-build-" + "C".repeat(600);
    m.renderFindings = Array.from({ length: 24 }, (_, i) => ({
      code: "synthetic_render_warning_" + i,
      severity: "warning" as const,
      sourceRecord: "receiving-source-" + i,
      eventId: m.identity.runId,
      revision: i + 1,
      lineNo: i + 1,
      fieldKey: "tlc",
      message:
        "Full finding " +
        i +
        ": retain the exact frozen source identity and printable punctuation — café.",
    }));
    m.findingsSummary.render = { error: 0, warning: 24, info: 0 };
    const a = await renderUsRequestReportPdf(m),
      b = await renderUsRequestReportPdf(m);
    expect(a.bytes).toEqual(b.bytes);
    retainEvidence("long-text", a.bytes);
    const pages = extractedPages(a.bytes),
      text = pages.join(" ").replace(/\s+/gu, " ");
    expect(pages.length).toBeGreaterThan(2);
    expect(text).toContain(m.request.requesterName);
    expect(text).toContain(m.request.alternateDeadlineReason);
    // Remove only running furniture before rejoining tokens split across a page boundary.
    const body = pages
      .map((page) =>
        page
          .replace(/^MARKIRO · US trace request report\s*Tenant origin not attested\s*/u, "")
          .replace(/us-request-report-pdf-v1 · Page \d+ of \d+/gu, ""),
      )
      .join(" ");
    for (const value of [m.request.requesterContact, m.scope.tlc, m.stamps.build.apiVersion])
      if (value) expect(compact(body).includes(value)).toBe(true);
    for (const finding of m.renderFindings) {
      expect(text).toContain(finding.sourceRecord);
      expect(text).toContain(finding.code);
      expect(text).toContain(`Revision: ${finding.revision}; line: ${finding.lineNo}; field: tlc`);
      expect(text).toContain(finding.message);
    }
    for (const page of pages) {
      expect(page).toContain("Tenant origin not attested");
      expect(page).toMatch(/Page \d+ of \d+/u);
    }
  });

  it("keeps historical validation errors distinct from selected ready workbook event counts", async () => {
    const m = structuredClone(ready);
    m.selectionSummary = {
      capturedRevisionCount: 3,
      workbookEventCount: 1,
      byType: { receiving: 2, transformation: 1, shipping: 0 },
      byLifecycle: { current_finalized: 1, historical_finalized: 1, draft: 1, void: 0 },
    };
    m.findingsSummary.validation = { error: 2, warning: 1, info: 3 };
    const text = textOf((await renderUsRequestReportPdf(m)).bytes);
    expect(text).toContain("Export-ready");
    for (const value of [
      "Captured revisions: 3",
      "Workbook events: 1",
      "historical_finalized: 1",
      "draft: 1",
      "Frozen validation findings: error 2; warning 1; info 3",
    ])
      expect(text).toContain(value);
  });

  it.each(["workbook_unrepresentable", "workbook_writer_failed"] as const)(
    "retains explicit missing workbook reason %s",
    async (code) => {
      const m = structuredClone(incomplete);
      m.preReportFiles = m.preReportFiles.filter((file) => file.name !== "records.xlsx");
      m.missingFiles = [{ name: "records.xlsx", code }];
      expect(textOf((await renderUsRequestReportPdf(m)).bytes)).toContain(`records.xlsx: ${code}`);
    },
  );

  it("rejects unsupported glyphs explicitly instead of losing multilingual text", async () => {
    const m = structuredClone(ready);
    m.request.requesterName = "日本語 😀";
    await failure(m, "us_request_report_render_failed");
  });

  it("characterizes natural measurement required for dynamic fixed footer text", async () => {
    // Minimal pinned-renderer reproduction, independent of the report's content/model.
    const renderFooter = (height?: number) =>
      ReactPdf.renderToBuffer(
        createElement(
          ReactPdf.Document,
          { creationDate: new Date("2026-10-04T00:00:00.000Z") },
          createElement(
            ReactPdf.Page,
            {
              size: "LETTER",
              style: {
                fontFamily: "US IBM Plex Sans",
                fontSize: 9.5,
                lineHeight: 1.4,
                paddingTop: 90,
                paddingBottom: 55,
                paddingHorizontal: 42,
              },
            },
            createElement(ReactPdf.Text, {
              fixed: true,
              style: {
                position: "absolute",
                top: 754,
                left: 42,
                right: 42,
                fontSize: 8,
                ...(height === undefined ? {} : { height }),
              },
              render: ({ pageNumber, totalPages }) => `Page ${pageNumber} of ${totalPages}`,
            }),
            createElement(ReactPdf.Text, null, "Synthetic minimal footer reproduction"),
          ),
        ),
      );
    expect(textOf(await renderFooter())).toContain("Page 1 of 1");
    expect(textOf(await renderFooter(14))).not.toContain("Page 1 of 1");
  });

  it("rejects controls and model excess before allocating the renderer", async () => {
    vi.resetModules();
    const spy = vi.fn();
    vi.doMock("@react-pdf/renderer", async () => ({
      ...(await vi.importActual<typeof ReactPdf>("@react-pdf/renderer")),
      renderToBuffer: spy,
    }));
    try {
      const { renderUsRequestReportPdf: seam } =
        await import("../src/modules/traceability/requests/us-request-report-pdf");
      const control = structuredClone(ready);
      control.stamps.build.apiVersion = "private@example.test\u0000";
      await failure(control, "us_request_package_model_invalid", seam);
      const excess = structuredClone(ready);
      excess.stamps.build.apiVersion = "X".repeat(1024 * 1024);
      await failure(excess, "us_request_package_size_limit", seam);
      expect(spy).not.toHaveBeenCalled();
    } finally {
      vi.doUnmock("@react-pdf/renderer");
      vi.resetModules();
    }
  });

  it("sanitizes provider failures and rejects oversized real renderer boundary output", async () => {
    vi.resetModules();
    const spy = vi.fn();
    vi.doMock("@react-pdf/renderer", async () => ({
      ...(await vi.importActual<typeof ReactPdf>("@react-pdf/renderer")),
      renderToBuffer: spy,
    }));
    try {
      const { renderUsRequestReportPdf: seam } =
        await import("../src/modules/traceability/requests/us-request-report-pdf");
      spy.mockRejectedValueOnce(new Error("private@example.test secret provider cause"));
      await failure(ready, "us_request_report_render_failed", seam);
      spy.mockResolvedValueOnce(Buffer.alloc(4 * 1024 * 1024 + 1));
      await failure(ready, "us_request_package_size_limit", seam);
    } finally {
      vi.doUnmock("@react-pdf/renderer");
      vi.resetModules();
    }
  });
});
