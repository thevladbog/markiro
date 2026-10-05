import { createHash, randomUUID } from "node:crypto";
import { schema } from "@markiro/db";
import { eq } from "drizzle-orm";
import { unzipSync } from "fflate";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as exportAdapter from "../src/modules/traceability/export/adapter";
import type { UsExportCoreResult } from "../src/modules/traceability/export/adapter";
import * as evidence from "../src/modules/traceability/requests/us-request-run-evidence";
import type { UsTraceExportRunRow } from "../src/modules/traceability/requests/us-request-run-evidence";
import { renderUsRequestPayloads } from "../src/modules/traceability/requests/us-request-payloads";
import { UsRequestPrepareStore } from "../src/modules/traceability/requests/us-request-prepare";
import { UsRequestStore } from "../src/modules/traceability/requests/us-request-store";
import { UsRequestValidationStore } from "../src/modules/traceability/requests/us-request-validation";
import { stableStringify } from "../src/modules/traceability/requests/us-request-snapshot";
import { createUsProfileTestDatabase } from "./support/us-profile-database";
import { seedCompleteReceiving } from "./support/us-receiving-fixture";
import {
  finalizeUsRequestPayloadReceiving,
  seedUsRequestPayloadPlan,
} from "./support/us-request-payload-fixture";
import { UsReceivingStore } from "../src/modules/traceability/receiving/us-receiving-store";

const url = process.env.US_TEST_DATABASE_URL;
const build = { apiVersion: "test-us09-payload", gitSha: "a".repeat(40), dirty: false } as const;
const modes = ["export_ready", "available_records_incomplete"] as const;
const limit = 16 * 1024 * 1024;
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const rejected = (code: string) => ({ status: 503, response: { code } });
const expectTechnicalFailure = async (operation: Promise<unknown>, code: string) => {
  const failure = await operation.catch((error: unknown) => error);
  expect(failure).toMatchObject({ status: 503 });
  expect(failure).toHaveProperty("response", { code });
  expect(failure).not.toHaveProperty("cause");
};

// These scenarios catch live recapture, altered bytes, wrong failure modes, missed
// limits, private exception leakage and writes during read-only composition.
describe.skipIf(!url)("US request byte payloads from disposable saved runs", () => {
  let f: Awaited<ReturnType<typeof createUsProfileTestDatabase>>;
  let c: Awaited<ReturnType<typeof seedCompleteReceiving>>;
  beforeAll(async () => {
    if (!url) throw new Error("Missing isolated US database URL");
    f = await createUsProfileTestDatabase(url);
  }, 60_000);
  afterAll(async () => {
    await f?.close();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });
  beforeEach(async () => {
    c = await seedCompleteReceiving(f.db);
  });

  const prepare = async (mode: (typeof modes)[number], empty = false) => {
    if (!empty) await finalizeUsRequestPayloadReceiving(f.db, c);
    if (!empty) await seedUsRequestPayloadPlan(f.db, c);
    const request = await new UsRequestStore(f.db).create(c.tenant, c.actor, {
      requestNumber: randomUUID(),
      requesterName: "Synthetic payload requester",
      requesterOrganization: null,
      requesterContact: "private@example.test",
      receivedAt: "2026-10-04T00:00:00Z",
      scope: empty ? { tlcs: ["NO-MATCH-PAYLOAD-FIXTURE"] } : { lotId: c.lot },
    });
    await new UsRequestValidationStore(f.db).validate(c.tenant, c.actor, request.id, build);
    return new UsRequestPrepareStore(f.db).prepare(
      c.tenant,
      c.actor,
      request.id,
      { mode, idempotencyKey: randomUUID() },
      build,
    );
  };
  const persisted = async () => ({
    runs: await f.db
      .select()
      .from(schema.traceExportRuns)
      .where(eq(schema.traceExportRuns.tenantId, c.tenant)),
    artifacts: await f.db
      .select()
      .from(schema.traceExportArtifacts)
      .where(eq(schema.traceExportArtifacts.tenantId, c.tenant)),
    audits: await f.db
      .select()
      .from(schema.tenantAuditEvents)
      .where(eq(schema.tenantAuditEvents.organizationId, c.tenant)),
  });
  const rendered = async (run: UsTraceExportRunRow) => {
    const input = evidence.verifyUsRequestRunEvidence(run, c.tenant).exportInput;
    if (!input) throw new Error("Missing real frozen Receiving input");
    return exportAdapter.renderUsExportCore(input);
  };
  const stub = (result: UsExportCoreResult) =>
    vi.spyOn(exportAdapter, "renderUsExportCore").mockResolvedValue(result);

  it("returns canonical validation only for an empty selection, without calling the core or writing evidence", async () => {
    const run = await prepare("available_records_incomplete", true);
    const adapter = vi.spyOn(exportAdapter, "renderUsExportCore");
    const before = await persisted();
    const result = await renderUsRequestPayloads(run, c.tenant);
    const bytes = Buffer.from(stableStringify(run.inputSnapshot), "utf8");
    expect(result).toEqual({
      runId: run.id,
      revision: 1,
      mode: "available_records_incomplete",
      scopedContentDigest: run.scopedContentDigest,
      inputDigest: null,
      validation: {
        name: "validation.json",
        contentType: "application/json",
        bytes,
        sha256: hash(bytes),
        byteSize: bytes.length,
      },
      workbook: null,
      missingWorkbook: { code: "empty_selection" },
      renderFindings: [],
    });
    expect(adapter).not.toHaveBeenCalled();
    expect(await renderUsRequestPayloads(run, c.tenant)).toEqual(result);
    expect(await persisted()).toEqual(before);
  });

  it.each(modes)(
    "renders actual Receiving XLSX from exactly saved input twice in %s",
    async (mode) => {
      const run = await prepare(mode);
      const saved = structuredClone(run);
      const input = evidence.verifyUsRequestRunEvidence(run, c.tenant).exportInput;
      const adapter = vi.spyOn(exportAdapter, "renderUsExportCore");
      const before = await persisted();
      const first = await renderUsRequestPayloads(run, c.tenant);
      const second = await renderUsRequestPayloads(run, c.tenant);
      expect(first).toEqual(second);
      expect(adapter).toHaveBeenNthCalledWith(1, input);
      expect(adapter).toHaveBeenNthCalledWith(2, input);
      const validation = Buffer.from(stableStringify(run.inputSnapshot), "utf8");
      expect(first.validation).toEqual({
        name: "validation.json",
        contentType: "application/json",
        bytes: validation,
        sha256: hash(validation),
        byteSize: validation.length,
      });
      expect(first.missingWorkbook).toBeNull();
      expect(first.workbook).toMatchObject({
        name: "records.xlsx",
        contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      });
      if (!first.workbook) throw new Error("Missing actual Receiving workbook");
      expect(first.workbook.byteSize).toBe(first.workbook.bytes.length);
      expect(first.workbook.sha256).toBe(hash(first.workbook.bytes));
      const parts = unzipSync(first.workbook.bytes);
      const shared = new TextDecoder().decode(parts["xl/sharedStrings.xml"]);
      expect(parts["xl/workbook.xml"]).toBeInstanceOf(Uint8Array);
      expect(shared).toContain("Case");
      expect(shared).toContain("lb");
      const source = input?.events[0];
      if (!source) throw new Error("Missing frozen event");
      expect(shared).toContain(`receiving:${source.eventId}:1:item:1`);
      expect(first.renderFindings.some((finding) => finding.severity === "error")).toBe(false);
      expect(run).toEqual(saved);
      expect(await persisted()).toEqual(before);
      first.validation.bytes.fill(0);
      first.workbook.bytes.fill(0);
      expect(await renderUsRequestPayloads(run, c.tenant)).toEqual(second);
      expect(run).toEqual(saved);
    },
  );

  it.each(modes)("accepts exactly 16 MiB and denies one byte over in %s", async (mode) => {
    const run = await prepare(mode);
    const actual = await rendered(run);
    const bytes = new Uint8Array(limit).fill(42);
    const adapter = stub({ ...actual, workbook: bytes, workbookSha256: hash(bytes) });
    const result = await renderUsRequestPayloads(run, c.tenant);
    expect(result.workbook).toMatchObject({ byteSize: limit, sha256: hash(bytes) });
    result.workbook?.bytes.fill(0);
    expect(bytes[0]).toBe(42);
    const over = new Uint8Array(limit + 1);
    adapter.mockResolvedValue({ ...actual, workbook: over, workbookSha256: hash(over) });
    await expectTechnicalFailure(
      renderUsRequestPayloads(run, c.tenant),
      "us_request_payload_size_limit",
    );
  });

  it("bounds validation bytes independently at exact 16 MiB and one byte over", async () => {
    const run = await prepare("available_records_incomplete", true);
    const frozen = evidence.verifyUsRequestRunEvidence(run, c.tenant);
    // Narrow verified-envelope double isolates the renderer's second defensive
    // byte guard; real persisted oversized envelopes are tested below.
    const padded = structuredClone(frozen);
    padded.validationSnapshot.request.requesterName = "";
    const overhead = Buffer.byteLength(stableStringify(padded), "utf8");
    padded.validationSnapshot.request.requesterName = "x".repeat(limit - overhead);
    const verifier = vi.spyOn(evidence, "verifyUsRequestRunEvidence").mockReturnValue(padded);
    expect((await renderUsRequestPayloads(run, c.tenant)).validation.byteSize).toBe(limit);
    padded.validationSnapshot.request.requesterName += "x";
    verifier.mockReturnValue(padded);
    await expectTechnicalFailure(
      renderUsRequestPayloads(run, c.tenant),
      "us_request_payload_size_limit",
    );
  });

  it.each(modes)(
    "rejects invalid saved evidence and another expected tenant before adapter calls in %s",
    async (mode) => {
      const run = await prepare(mode);
      const before = await persisted();
      const adapter = vi.spyOn(exportAdapter, "renderUsExportCore");
      for (const invalid of [
        { ...run, inputSnapshot: null },
        { ...run, inputSnapshot: { secret: "private@example.test", padding: "x".repeat(limit) } },
        { ...run, inputDigest: "0".repeat(64) },
      ])
        await expectTechnicalFailure(
          renderUsRequestPayloads(invalid, c.tenant),
          "us_request_run_stored_invalid",
        );
      await expectTechnicalFailure(
        renderUsRequestPayloads(run, randomUUID()),
        "us_request_run_stored_invalid",
      );
      expect(adapter).not.toHaveBeenCalled();
      expect(await persisted()).toEqual(before);
    },
  );

  it.each(modes)(
    "rejects adapter evidence and workbook/failure inconsistencies in %s",
    async (mode) => {
      const run = await prepare(mode);
      const actual = await rendered(run);
      const adapter = stub(actual);
      const variants: UsExportCoreResult[] = [
        { ...actual, inputDigest: "0".repeat(64) },
        { ...actual, registryHash: "0".repeat(64) },
        { ...actual, registryVersion: 2 } as unknown as UsExportCoreResult,
        { ...actual, workbookSha256: "0".repeat(64) },
        { ...actual, workbookSha256: null },
        { ...actual, workbook: new Uint8Array(), workbookSha256: hash(new Uint8Array()) },
        { ...actual, workbook: null },
        { ...actual, workbook: null, workbookSha256: null },
        {
          ...actual,
          failure: {
            code: "XLSX_RENDER_FAILED",
            sourceRecord: "metadata",
            fieldKey: "scope_label",
          },
        },
        { ...actual, workbook: "not bytes" } as unknown as UsExportCoreResult,
        {
          ...actual,
          workbook: null,
          workbookSha256: null,
          failure: { code: "UNKNOWN_LIBRARY_CODE" },
        } as unknown as UsExportCoreResult,
        {
          ...actual,
          workbook: null,
          workbookSha256: null,
          failure: undefined,
        } as unknown as UsExportCoreResult,
      ];
      const before = await persisted();
      for (const variant of variants) {
        adapter.mockResolvedValue(variant);
        await expectTechnicalFailure(
          renderUsRequestPayloads(run, c.tenant),
          "us_request_payload_evidence_mismatch",
        );
      }
      expect(await persisted()).toEqual(before);
    },
  );

  it.each(["CELL_LIMIT_EXCEEDED", "CELL_VALUE_UNREPRESENTABLE", "XLSX_RENDER_FAILED"] as const)(
    "keeps typed %s separate in incomplete mode and fails ready mode",
    async (code) => {
      for (const mode of modes) {
        c = await seedCompleteReceiving(f.db);
        const run = await prepare(mode);
        const actual = await rendered(run);
        const failure = { code, sourceRecord: "metadata", fieldKey: "scope_label" };
        stub({ ...actual, workbook: null, workbookSha256: null, failure });
        const before = await persisted();
        if (mode === "export_ready") {
          await expectTechnicalFailure(
            renderUsRequestPayloads(run, c.tenant),
            "us_request_payload_workbook_unavailable",
          );
        } else {
          const output = await renderUsRequestPayloads(run, c.tenant);
          expect(output.workbook).toBeNull();
          expect(output.missingWorkbook).toEqual({
            code:
              code === "XLSX_RENDER_FAILED" ? "workbook_writer_failed" : "workbook_unrepresentable",
          });
          expect(output.renderFindings).toEqual(actual.findings);
          expect(output.validation.bytes).toEqual(
            Buffer.from(stableStringify(run.inputSnapshot), "utf8"),
          );
          expect(JSON.stringify(output.missingWorkbook)).not.toContain("scope_label");
        }
        expect(await persisted()).toEqual(before);
        vi.restoreAllMocks();
      }
    },
  );

  it("allows a blocking render finding only in explicit incomplete mode", async () => {
    for (const mode of modes) {
      c = await seedCompleteReceiving(f.db);
      const run = await prepare(mode);
      const actual = await rendered(run);
      const finding = {
        code: "SOURCE_RECORD_NOT_CURRENT_FINALIZED",
        severity: "error" as const,
        sourceRecord: "receiving:synthetic:1",
        message: "Synthetic current-revision finding",
      };
      stub({ ...actual, findings: [finding] });
      if (mode === "export_ready")
        await expectTechnicalFailure(
          renderUsRequestPayloads(run, c.tenant),
          "us_request_payload_workbook_unavailable",
        );
      else {
        const result = await renderUsRequestPayloads(run, c.tenant);
        expect(result.renderFindings).toEqual([finding]);
        expect(result.workbook?.sha256).toBe(actual.workbookSha256);
        expect(result.validation.bytes).toEqual(
          Buffer.from(stableStringify(run.inputSnapshot), "utf8"),
        );
      }
      vi.restoreAllMocks();
    }
  });

  it.each(modes)(
    "sanitizes unexpected thrown private requester/source details without partial success in %s",
    async (mode) => {
      const run = await prepare(mode);
      const before = await persisted();
      const privateText = "private@example.test private source receiving:secret:1";
      const original = new Error(privateText, { cause: new Error(privateText) });
      vi.spyOn(exportAdapter, "renderUsExportCore").mockRejectedValue(original);
      const failure = await renderUsRequestPayloads(run, c.tenant).catch((error: unknown) => error);
      expect(failure).toMatchObject(rejected("us_request_payload_render_failed"));
      expect(failure).toHaveProperty("response", { code: "us_request_payload_render_failed" });
      expect(failure).not.toHaveProperty("cause");
      expect(String(failure)).not.toContain(privateText);
      expect(JSON.stringify(failure)).not.toContain("private@example.test");
      expect(JSON.stringify(failure)).not.toContain("receiving:secret:1");
      expect(await persisted()).toEqual(before);
    },
  );

  it.each(modes)(
    "keeps original real bytes after actual Receiving amendment, void and request close in %s",
    async (mode) => {
      const run = await prepare(mode);
      const first = await renderUsRequestPayloads(run, c.tenant);
      const input = evidence.verifyUsRequestRunEvidence(run, c.tenant).exportInput;
      const event = input?.events[0];
      if (!event) throw new Error("Missing frozen Receiving event");
      const receiving = new UsReceivingStore(f.db);
      const origin = await receiving.getLiveRecord(c.tenant, c.actor, event.eventId);
      const amendment = await receiving.amend(
        c.tenant,
        c.actor,
        event.eventId,
        {
          commandVersion: 2,
          operationKey: randomUUID(),
          expectedLifecycleVersion: origin.lifecycle.lifecycleVersion,
          reason: "Correct synthetic receipt",
        },
        "payload-drift-amend",
      );
      const checked = await receiving.checkRevisionReadiness(c.tenant, c.actor, amendment.eventId, {
        expectedDraftVersion: 1,
      });
      const finalized = await receiving.finalizeRevision(
        c.tenant,
        c.actor,
        amendment.eventId,
        {
          commandVersion: 2,
          operationKey: randomUUID(),
          expectedDraftVersion: 1,
          expectedLifecycleVersion: checked.expectedLifecycleVersion,
          previousRevisionId: checked.previousRevisionId,
          expectedInputDigest: checked.inputDigest,
          reviewedExemptLines: checked.exemptReviewRequiredLines,
        },
        "payload-drift-finalize",
      );
      expect(finalized.record).toMatchObject({ status: "finalized", revision: 2 });
      const afterAmendment = await persisted();
      expect(await renderUsRequestPayloads(run, c.tenant)).toEqual(first);
      expect(await persisted()).toEqual(afterAmendment);
      const voided = await receiving.void(
        c.tenant,
        c.actor,
        amendment.eventId,
        {
          commandVersion: 2,
          operationKey: randomUUID(),
          expectedLifecycleVersion: finalized.record.lifecycle.lifecycleVersion,
          expectedDraftVersion: null,
          reason: "Synthetic receipt entered in error",
        },
        "payload-drift-void",
      );
      expect(voided.record.status).toBe("void");
      await new UsRequestStore(f.db).close(c.tenant, c.actor, run.requestId, {
        expectedRevision: 1,
      });
      const before = await persisted();
      expect(await renderUsRequestPayloads(run, c.tenant)).toEqual(first);
      expect(await persisted()).toEqual(before);
      expect(before.runs).toEqual([run]);
      expect(before.artifacts).toEqual([]);
    },
  );
});
