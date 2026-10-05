import { createHash, randomUUID } from "node:crypto";
import { canonicalExportDigest } from "@markiro/domain";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createUsProfileTestDatabase } from "./support/us-profile-database";
import { createUsRequestPackageFixture } from "./support/us-request-package-fixture";
import { requireUsRequestPackageEvidence } from "../src/modules/traceability/requests/us-request-run-evidence";
import { stableStringify } from "../src/modules/traceability/requests/us-request-snapshot";
import type { UsRequestReportModel } from "../src/modules/traceability/requests/us-request-package-types";

const url = process.env.US_TEST_DATABASE_URL;
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const api = () => import("../src/modules/traceability/requests/us-request-package-inputs");
const failure = (operation: () => unknown, code: string, status = 503) => {
  let caught: unknown;
  try {
    operation();
  } catch (error) {
    caught = error;
  }
  expect(caught).toMatchObject({ status });
  expect(caught).toHaveProperty("response", { code });
  expect(caught).not.toHaveProperty("cause");
  expect(JSON.stringify(caught)).not.toContain("private@example.test");
};

// Each scenario catches acceptance of corrupted metadata/bytes or misleading report facts.
describe.skipIf(!url)("US package input binding in owned disposable PostgreSQL", () => {
  let f: Awaited<ReturnType<typeof createUsProfileTestDatabase>>;
  const fixtures: Awaited<ReturnType<typeof createUsRequestPackageFixture>>[] = [];
  beforeAll(async () => {
    if (!url) throw new Error("Missing isolated US database URL");
    f = await createUsProfileTestDatabase(url);
  }, 60_000);
  afterAll(async () => {
    for (const c of fixtures) c.destroy();
    await f?.close();
  });
  const fixture = async (
    options: Parameters<typeof createUsRequestPackageFixture>[1] = { mode: "export_ready" },
  ) => {
    const c = await createUsRequestPackageFixture(f.db, options);
    fixtures.push(c);
    return c;
  };
  it("binds real Receiving workbook and approved historical Plan with independent bytes and report fields", async () => {
    const c = await fixture();
    const { bindUsRequestPackageInputs } = await api();
    const inputRun = structuredClone(c.run);
    const bound = bindUsRequestPackageInputs(inputRun, c.tenantId, c.payloads, c.plan, c.context);
    expect(bound.model.identity).toEqual({
      tenantId: c.tenantId,
      requestId: c.request.id,
      requestRevision: 1,
      runId: c.run.id,
      runRevision: 1,
      mode: "export_ready",
      preparedBy: c.actorId,
    });
    expect(bound.model.selectionSummary).toEqual({
      capturedRevisionCount: 1,
      workbookEventCount: 1,
      byType: { receiving: 1, transformation: 0, shipping: 0 },
      byLifecycle: { current_finalized: 1, historical_finalized: 0, draft: 0, void: 0 },
    });
    expect(bound.model.timing.elapsedToReportDataPreparationMs).toBe(2000);
    expect(bound.model.tenantOrigin.result).toBe("not_attested");
    expect(bound.preReportFiles.map((file) => file.name)).toEqual([
      "records.xlsx",
      "plan.pdf",
      "validation.json",
    ]);
    const first = bound.preReportFiles[0];
    const planFile = bound.preReportFiles[1],
      validationFile = bound.preReportFiles[2];
    if (!first || !planFile || !validationFile || !c.payloads.workbook || c.plan.kind !== "pdf")
      throw new Error("Missing real inputs");
    const workbook = Buffer.from(first.bytes);
    const planBytes = Buffer.from(planFile.bytes),
      validationBytes = Buffer.from(validationFile.bytes);
    const savedModel = structuredClone(bound.model);
    c.payloads.workbook.bytes.fill(0);
    c.plan.bytes.fill(0);
    c.payloads.validation.bytes.fill(0);
    c.context.reportDataPreparedAt = c.run.startedAt.toISOString();
    inputRun.inputSnapshot = null;
    expect(first.bytes).toEqual(workbook);
    expect(planFile.bytes).toEqual(planBytes);
    expect(validationFile.bytes).toEqual(validationBytes);
    expect(bound.model).toEqual(savedModel);
    expect(bound.model.preReportFiles[0]).not.toHaveProperty("bytes");
  });

  it.each([false, true])(
    "keeps incomplete mode with real optional presence (empty %s)",
    async (empty) => {
      const c = await fixture({ mode: "available_records_incomplete", empty, withPlan: !empty });
      const { bindUsRequestPackageInputs } = await api();
      const bound = bindUsRequestPackageInputs(c.run, c.tenantId, c.payloads, c.plan, {
        ...c.context,
        workerStartedAt: null,
      });
      expect(bound.model.identity.mode).toBe("available_records_incomplete");
      expect(bound.model.timing.workerStartedAt).toBeNull();
      expect(bound.model.selectionSummary.capturedRevisionCount).toBe(empty ? 0 : 1);
      expect(bound.model.missingFiles).toEqual(
        empty
          ? [
              { name: "records.xlsx", code: "empty_selection" },
              { name: "plan.pdf", code: "plan_absent" },
            ]
          : [],
      );
    },
  );

  it("rejects mixed payload bindings and byte corruption with sanitized codes", async () => {
    const c = await fixture();
    const { bindUsRequestPackageInputs } = await api();
    const variants = [
      { ...c.payloads, runId: randomUUID() },
      { ...c.payloads, revision: 2 },
      { ...c.payloads, mode: "available_records_incomplete" as const },
      { ...c.payloads, scopedContentDigest: "0".repeat(64) },
      { ...c.payloads, inputDigest: "0".repeat(64) },
      {
        ...c.payloads,
        validation: { ...c.payloads.validation, byteSize: c.payloads.validation.byteSize + 1 },
      },
      { ...c.payloads, validation: { ...c.payloads.validation, sha256: "0".repeat(64) } },
      { ...c.payloads, workbook: null, missingWorkbook: { code: "empty_selection" as const } },
      { ...c.payloads, missingWorkbook: { code: "workbook_writer_failed" as const } },
      {
        ...c.payloads,
        renderFindings: [
          {
            code: "private",
            severity: "error" as const,
            sourceRecord: "private",
            message: "private@example.test",
            extra: true,
          },
        ],
      },
    ];
    for (const payload of variants)
      failure(
        () => bindUsRequestPackageInputs(c.run, c.tenantId, payload, c.plan, c.context),
        "us_request_package_inputs_invalid",
      );
    const bytes = Buffer.from(`${Buffer.from(c.payloads.validation.bytes).toString()}\n`);
    failure(
      () =>
        bindUsRequestPackageInputs(
          c.run,
          c.tenantId,
          {
            ...c.payloads,
            validation: {
              ...c.payloads.validation,
              bytes,
              byteSize: bytes.length,
              sha256: hash(bytes),
            },
          },
          c.plan,
          c.context,
        ),
      "us_request_package_inputs_invalid",
    );
    failure(
      () => bindUsRequestPackageInputs(c.run, randomUUID(), c.payloads, c.plan, c.context),
      "us_request_run_stored_invalid",
    );
    if (!c.payloads.workbook) throw new Error("Missing workbook");
    for (const workbook of [
      { ...c.payloads.workbook, bytes: Buffer.from("swapped") },
      { ...c.payloads.workbook, name: "validation.json" as const },
      { ...c.payloads.workbook, byteSize: Number.MAX_SAFE_INTEGER + 1 },
    ])
      failure(
        () =>
          bindUsRequestPackageInputs(
            c.run,
            c.tenantId,
            { ...c.payloads, workbook },
            c.plan,
            c.context,
          ),
        "us_request_package_inputs_invalid",
      );
  });

  it("rejects wrong Plan pins, hashes, sizes and fabricated absence", async () => {
    const c = await fixture();
    const { bindUsRequestPackageInputs } = await api();
    if (c.plan.kind !== "pdf") throw new Error("Missing Plan");
    for (const plan of [
      { ...c.plan, planVersionId: randomUUID() },
      { ...c.plan, sha256: "0".repeat(64) },
      { ...c.plan, byteSize: c.plan.byteSize + 1 },
      { ...c.plan, bytes: Buffer.from("wrong") },
      { kind: "absent" as const, code: "plan_absent" as const },
    ])
      failure(
        () => bindUsRequestPackageInputs(c.run, c.tenantId, c.payloads, plan, c.context),
        "us_request_package_inputs_invalid",
      );
  });

  it("rejects unsupported context versions, controls, precision and chronology", async () => {
    const c = await fixture();
    const { bindUsRequestPackageInputs } = await api();
    const variants = [
      { ...c.context, schemaVersion: 2 },
      { ...c.context, extra: true },
      { ...c.context, workerStartedAt: "2026-10-04T00:00:00+00:00" },
      { ...c.context, reportDataPreparedAt: c.context.reportDataPreparedAt.replace("Z", "1Z") },
      { ...c.context, reportDataPreparedAt: new Date(c.run.startedAt.getTime() - 1).toISOString() },
      { ...c.context, workerStartedAt: new Date(c.run.startedAt.getTime() - 1).toISOString() },
      {
        ...c.context,
        workerStartedAt: new Date(Date.parse(c.context.reportDataPreparedAt) + 1).toISOString(),
      },
    ];
    for (const context of variants)
      failure(
        () =>
          Reflect.apply(bindUsRequestPackageInputs, undefined, [
            c.run,
            c.tenantId,
            c.payloads,
            c.plan,
            context,
          ]),
        "us_request_package_context_invalid",
      );
  });

  it("rejects verified legacy v1 before touching downstream payload/context fields", async () => {
    const c = await fixture();
    const { bindUsRequestPackageInputs } = await api();
    const frozen = requireUsRequestPackageEvidence(c.run, c.tenantId);
    const { tenantOrigin, ...oldSnapshot } = frozen.validationSnapshot;
    void tenantOrigin;
    const validationSnapshot = { ...oldSnapshot, schemaVersion: 1 as const };
    const run = {
      ...c.run,
      scopedContentDigest: canonicalExportDigest(validationSnapshot),
      inputSnapshot: { ...frozen, schemaVersion: 1, validationSnapshot },
    };
    failure(
      () =>
        bindUsRequestPackageInputs(
          run,
          c.tenantId,
          {
            ...c.payloads,
            get runId(): string {
              throw new Error("Downstream accessed");
            },
          },
          c.plan,
          c.context,
        ),
      "us_request_package_refreeze_required",
      409,
    );
  });

  it("validates standalone model consistency, supported text and exact model byte bound", async () => {
    const c = await fixture();
    const { bindUsRequestPackageInputs, assertUsRequestReportModel } = await api();
    const base = bindUsRequestPackageInputs(c.run, c.tenantId, c.payloads, c.plan, c.context).model;
    assertUsRequestReportModel(base);
    const variants = [
      { ...base, schemaVersion: 2 },
      { ...base, extra: "private@example.test" },
      { ...base, selectionSummary: { ...base.selectionSummary, capturedRevisionCount: 2 } },
      {
        ...base,
        selectionSummary: {
          ...base.selectionSummary,
          workbookEventCount: Number.MAX_SAFE_INTEGER + 1,
        },
      },
      {
        ...base,
        findingsSummary: { ...base.findingsSummary, render: { error: 1, warning: 0, info: 0 } },
      },
      {
        ...base,
        findingsSummary: {
          ...base.findingsSummary,
          validation: { error: 0, warning: 1, info: Number.MAX_SAFE_INTEGER },
        },
      },
      { ...base, stamps: { ...base.stamps, baselineId: "unsafe\u0000text" } },
      {
        ...base,
        timing: { ...base.timing, elapsedToReportDataPreparationMs: Number.MAX_SAFE_INTEGER + 1 },
      },
      { ...base, preReportFiles: [...base.preReportFiles, ...base.preReportFiles] },
      {
        ...base,
        preReportFiles: base.preReportFiles.filter((file) => file.name !== "validation.json"),
      },
      {
        ...base,
        preReportFiles: base.preReportFiles.map((file) => ({ ...file, name: "../plan.pdf" })),
      },
      { ...base, plan: null },
      { ...base, missingFiles: [{ name: "records.xlsx", code: "empty_selection" }] },
    ];
    for (const model of variants)
      failure(
        () => Reflect.apply(assertUsRequestReportModel, undefined, [model]),
        "us_request_package_model_invalid",
      );
    const padded: UsRequestReportModel = structuredClone(base);
    padded.stamps.baselineId = "";
    padded.stamps.baselineId = "x".repeat(1024 * 1024 - Buffer.byteLength(stableStringify(padded)));
    expect(Buffer.byteLength(stableStringify(padded))).toBe(1024 * 1024);
    assertUsRequestReportModel(padded);
    padded.stamps.baselineId += "x";
    failure(() => assertUsRequestReportModel(padded), "us_request_package_size_limit");
  });

  it("keeps captured historical revisions separate from ready workbook events and copies trusted origin", async () => {
    const c = await fixture();
    const { bindUsRequestPackageInputs } = await api();
    const frozen = structuredClone(requireUsRequestPackageEvidence(c.run, c.tenantId));
    const first = frozen.validationSnapshot.sources[0];
    const record = frozen.validationSnapshot.selection.records[0];
    if (!first || !record) throw new Error("Missing captured source");
    const historicalId = randomUUID();
    frozen.validationSnapshot.sources.push({
      ...first,
      eventId: historicalId,
      lifecycle: "historical_finalized",
    });
    frozen.validationSnapshot.selection.records.push({ ...record, eventId: historicalId });
    frozen.validationSnapshot.findings.push({
      code: "HISTORICAL_ONLY",
      severity: "error",
      sourceRecord: `receiving:${historicalId}:1`,
      eventId: historicalId,
      revision: 1,
      message: "Historical revision issue retained in validation evidence",
    });
    frozen.validationSnapshot.tenantOrigin = {
      schemaVersion: 1,
      verificationPolicy: "us-request-tenant-origin-v1",
      result: "trusted_synthetic",
      trustedSeed: { seedId: c.tenantId, verifiedBy: "us-development-owner-v1" },
    };
    const scopedContentDigest = canonicalExportDigest(frozen.validationSnapshot);
    const run = { ...c.run, inputSnapshot: frozen, scopedContentDigest };
    const bytes = Buffer.from(stableStringify(frozen));
    const payloads = {
      ...c.payloads,
      scopedContentDigest,
      validation: { ...c.payloads.validation, bytes, sha256: hash(bytes), byteSize: bytes.length },
    };
    const bound = bindUsRequestPackageInputs(run, c.tenantId, payloads, c.plan, c.context);
    expect(bound.model.selectionSummary).toEqual({
      capturedRevisionCount: 2,
      workbookEventCount: 1,
      byType: { receiving: 2, transformation: 0, shipping: 0 },
      byLifecycle: { current_finalized: 1, historical_finalized: 1, draft: 0, void: 0 },
    });
    expect(bound.model.tenantOrigin.result).toBe("trusted_synthetic");
    expect(bound.model.findingsSummary.validation.error).toBe(1);
    expect(bound.model.findingsSummary.render.error).toBe(0);
    frozen.validationSnapshot.tenantOrigin.trustedSeed.seedId = randomUUID();
    expect(bound.model.tenantOrigin).toEqual({
      schemaVersion: 1,
      verificationPolicy: "us-request-tenant-origin-v1",
      result: "trusted_synthetic",
      trustedSeed: { seedId: c.tenantId, verifiedBy: "us-development-owner-v1" },
    });
    const selectedFrozen = structuredClone(requireUsRequestPackageEvidence(c.run, c.tenantId));
    if (!selectedFrozen.exportInput) throw new Error("Missing selected input");
    selectedFrozen.exportInput.findings.push({
      code: "SELECTED_ERROR",
      severity: "error",
      sourceRecord: "receiving:selected:1",
      message: "Selected record blocks ready binding",
    });
    const inputDigest = canonicalExportDigest(selectedFrozen.exportInput);
    const selectedBytes = Buffer.from(stableStringify(selectedFrozen));
    failure(
      () =>
        bindUsRequestPackageInputs(
          { ...c.run, inputSnapshot: selectedFrozen, inputDigest },
          c.tenantId,
          {
            ...c.payloads,
            inputDigest,
            validation: {
              ...c.payloads.validation,
              bytes: selectedBytes,
              byteSize: selectedBytes.length,
              sha256: hash(selectedBytes),
            },
          },
          c.plan,
          c.context,
        ),
      "us_request_package_inputs_invalid",
    );
  });

  it.each(["workbook_unrepresentable", "workbook_writer_failed"] as const)(
    "preserves trusted %s omission independently of finding text",
    async (code) => {
      const c = await fixture({ mode: "available_records_incomplete", withPlan: false });
      const { bindUsRequestPackageInputs } = await api();
      const payloads = { ...c.payloads, workbook: null, missingWorkbook: { code } };
      const bound = bindUsRequestPackageInputs(c.run, c.tenantId, payloads, c.plan, c.context);
      expect(bound.model.missingFiles).toEqual([
        { name: "records.xlsx", code },
        { name: "plan.pdf", code: "plan_absent" },
      ]);
      expect(bound.model.selectionSummary.workbookEventCount).toBe(1);
      failure(
        () =>
          bindUsRequestPackageInputs(
            c.run,
            c.tenantId,
            { ...payloads, missingWorkbook: { code: "empty_selection" } },
            c.plan,
            c.context,
          ),
        "us_request_package_inputs_invalid",
      );
      failure(
        () =>
          Reflect.apply(bindUsRequestPackageInputs, undefined, [
            c.run,
            c.tenantId,
            { ...payloads, missingWorkbook: { code: "unknown", detail: "private@example.test" } },
            c.plan,
            c.context,
          ]),
        "us_request_package_inputs_invalid",
      );
    },
  );

  it("checks exact workbook and Plan byte limits before accepting independent owned files", async () => {
    const c = await fixture();
    const { bindUsRequestPackageInputs } = await api();
    if (!c.payloads.workbook || c.plan.kind !== "pdf") throw new Error("Missing real files");
    const workbookBytes = Buffer.alloc(16 * 1024 * 1024, 42);
    const payloads = {
      ...c.payloads,
      workbook: {
        ...c.payloads.workbook,
        bytes: workbookBytes,
        byteSize: workbookBytes.length,
        sha256: hash(workbookBytes),
      },
    };
    expect(
      bindUsRequestPackageInputs(c.run, c.tenantId, payloads, c.plan, c.context).preReportFiles[0]
        ?.byteSize,
    ).toBe(16 * 1024 * 1024);
    const over = Buffer.alloc(16 * 1024 * 1024 + 1, 42);
    failure(
      () =>
        bindUsRequestPackageInputs(
          c.run,
          c.tenantId,
          {
            ...payloads,
            workbook: {
              ...payloads.workbook,
              bytes: over,
              byteSize: over.length,
              sha256: hash(over),
            },
          },
          c.plan,
          c.context,
        ),
      "us_request_package_size_limit",
    );
    const frozen = structuredClone(requireUsRequestPackageEvidence(c.run, c.tenantId));
    const pin = frozen.validationSnapshot.plan;
    if (!pin) throw new Error("Missing Plan pin");
    const testPlan = (bytes: Buffer) => {
      const pdfSha256 = hash(bytes);
      frozen.validationSnapshot.plan = { ...pin, pdfSha256 };
      const scopedContentDigest = canonicalExportDigest(frozen.validationSnapshot);
      const run = {
        ...c.run,
        inputSnapshot: structuredClone(frozen),
        planPdfSha256: pdfSha256,
        scopedContentDigest,
      };
      const validation = Buffer.from(stableStringify(frozen));
      const boundPayloads = {
        ...c.payloads,
        scopedContentDigest,
        validation: {
          ...c.payloads.validation,
          bytes: validation,
          byteSize: validation.length,
          sha256: hash(validation),
        },
      };
      return () =>
        bindUsRequestPackageInputs(
          run,
          c.tenantId,
          boundPayloads,
          { kind: "pdf", planVersionId: pin.id, bytes, byteSize: bytes.length, sha256: pdfSha256 },
          c.context,
        );
    };
    expect(testPlan(Buffer.alloc(8_000_000, 42))().preReportFiles[1]?.byteSize).toBe(8_000_000);
    failure(testPlan(Buffer.alloc(8_000_001, 42)), "us_request_package_size_limit");
  });

  it("rejects unsafe elapsed arithmetic and contradictory standalone omissions", async () => {
    const c = await fixture();
    const { bindUsRequestPackageInputs, assertUsRequestReportModel } = await api();
    const model = bindUsRequestPackageInputs(
      c.run,
      c.tenantId,
      c.payloads,
      c.plan,
      c.context,
    ).model;
    failure(
      () =>
        assertUsRequestReportModel({
          ...model,
          timing: {
            ...model.timing,
            workerStartedAt: null,
            preparationStartedAt: "-271821-04-20T00:00:00.000Z",
            reportDataPreparedAt: "+275760-09-13T00:00:00.000Z",
            elapsedToReportDataPreparationMs: 17_280_000_000_000_000,
          },
        }),
      "us_request_package_model_invalid",
    );
    failure(
      () =>
        assertUsRequestReportModel({
          ...model,
          identity: { ...model.identity, mode: "available_records_incomplete" },
          preReportFiles: model.preReportFiles.filter((file) => file.name !== "records.xlsx"),
          missingFiles: [{ name: "records.xlsx", code: "empty_selection" }],
        }),
      "us_request_package_model_invalid",
    );
  });

  it("sanitizes exceptions while reading malformed upstream objects", async () => {
    const c = await fixture();
    const { bindUsRequestPackageInputs } = await api();
    const payloads = {
      ...c.payloads,
      get runId(): string {
        throw new Error("private@example.test");
      },
    };
    failure(
      () => bindUsRequestPackageInputs(c.run, c.tenantId, payloads, c.plan, c.context),
      "us_request_package_inputs_invalid",
    );
  });

  it("accepts canonical validation at 16 MiB and preserves upstream failure one byte beyond", async () => {
    const c = await fixture({ mode: "available_records_incomplete", empty: true, withPlan: false });
    const { bindUsRequestPackageInputs } = await api();
    const frozen = structuredClone(requireUsRequestPackageEvidence(c.run, c.tenantId));
    const padding = { syntheticPadding: "" };
    frozen.validationSnapshot.lots.push(padding);
    padding.syntheticPadding = "x".repeat(
      16 * 1024 * 1024 - Buffer.byteLength(stableStringify(frozen)),
    );
    const bind = () => {
      const scopedContentDigest = canonicalExportDigest(frozen.validationSnapshot);
      const run = { ...c.run, inputSnapshot: structuredClone(frozen), scopedContentDigest };
      const bytes = Buffer.from(stableStringify(frozen));
      return bindUsRequestPackageInputs(
        run,
        c.tenantId,
        {
          ...c.payloads,
          scopedContentDigest,
          validation: {
            ...c.payloads.validation,
            bytes,
            byteSize: bytes.length,
            sha256: hash(bytes),
          },
        },
        c.plan,
        c.context,
      );
    };
    expect(bind().preReportFiles[0]?.byteSize).toBe(16 * 1024 * 1024);
    padding.syntheticPadding += "x";
    failure(bind, "us_request_run_stored_invalid");
  });
});
