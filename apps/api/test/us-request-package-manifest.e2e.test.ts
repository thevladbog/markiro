import { createHash, randomUUID } from "node:crypto";
import { canonicalExportDigest } from "@markiro/domain";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bindUsRequestPackageInputs } from "../src/modules/traceability/requests/us-request-package-inputs";
import { US_REQUEST_PACKAGE_LIMITS as limits } from "../src/modules/traceability/requests/us-request-package-types";
import { renderUsRequestReportPdf } from "../src/modules/traceability/requests/us-request-report-pdf";
import { requireUsRequestPackageEvidence } from "../src/modules/traceability/requests/us-request-run-evidence";
import { stableStringify } from "../src/modules/traceability/requests/us-request-snapshot";
import { createUsProfileTestDatabase } from "./support/us-profile-database";
import { createUsRequestPackageFixture } from "./support/us-request-package-fixture";

const url = process.env.US_TEST_DATABASE_URL;
const api = () => import("../src/modules/traceability/requests/us-request-package-manifest");
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const failure = (operation: () => unknown, code = "us_request_package_manifest_invalid") => {
  let caught: unknown;
  try {
    operation();
  } catch (error) {
    caught = error;
  }
  expect(caught).toHaveProperty("response", { code });
  expect(caught).toHaveProperty("status", 503);
  expect(caught).not.toHaveProperty("cause");
  expect(JSON.stringify(caught)).not.toContain("private@example.test");
};

// Each case catches changed coverage, lost provenance, accepted tampering or an off-by-one bound.
describe.skipIf(!url)("US strict manifest with real frozen inputs and real PDF", () => {
  let db: Awaited<ReturnType<typeof createUsProfileTestDatabase>>;
  const fixtures: Awaited<ReturnType<typeof createUsRequestPackageFixture>>[] = [];
  let ready: ReturnType<typeof bindUsRequestPackageInputs>;
  let report: Awaited<ReturnType<typeof renderUsRequestReportPdf>>;
  beforeAll(async () => {
    if (!url) throw new Error("Missing isolated US database URL");
    db = await createUsProfileTestDatabase(url);
    const c = await createUsRequestPackageFixture(db.db, { mode: "export_ready" });
    fixtures.push(c);
    ready = bindUsRequestPackageInputs(c.run, c.tenantId, c.payloads, c.plan, c.context);
    report = await renderUsRequestReportPdf(ready.model);
  }, 60_000);
  afterAll(async () => {
    for (const c of fixtures) c.destroy();
    await db?.close();
  });

  it("covers exact available payload bytes followed by manifest without cyclic hashes", async () => {
    const { buildUsRequestManifest, parseUsRequestManifest } = await api();
    const bundle = buildUsRequestManifest(ready, report);
    expect(bundle.model.files.map((file) => file.name)).toEqual([
      "records.xlsx",
      "plan.pdf",
      "validation.json",
      "request-report.pdf",
    ]);
    expect(bundle.payloadFiles.map((file) => file.name)).toEqual([
      "records.xlsx",
      "plan.pdf",
      "validation.json",
      "request-report.pdf",
    ]);
    expect(bundle.model.identity).toEqual(ready.model.identity);
    expect(bundle.model.timing).toEqual(ready.model.timing);
    expect(bundle.model.tenantOrigin).toEqual(ready.model.tenantOrigin);
    expect(bundle.model.stamps).toEqual(ready.model.stamps);
    expect(bundle.model.selectionSummary).toEqual(ready.model.selectionSummary);
    expect(bundle.model.findingsSummary).toEqual(ready.model.findingsSummary);
    expect(bundle.model.plan).toEqual(ready.model.plan);
    expect(bundle.model.digests).toEqual(ready.model.digests);
    expect(bundle.model.warningAcknowledgement).toEqual(ready.model.warningAcknowledgement);
    expect(bundle.model.schemaVersion).toBe(1);
    expect(bundle.model.packageVersion).toBe("us-request-package-v1");
    expect(bundle.model.reportRendererVersion).toBe("us-request-report-pdf-v1");
    expect(bundle.model.missingFiles).toEqual([]);
    expect(bundle.model).not.toHaveProperty("request");
    expect(bundle.model).not.toHaveProperty("scope");
    expect(bundle.model).not.toHaveProperty("preReportFiles");
    expect(bundle.manifest.bytes.toString("utf8")).not.toContain("private@example.test");
    expect(bundle.manifest.bytes.toString("utf8")).toBe(stableStringify(bundle.model));
    expect(parseUsRequestManifest(JSON.parse(bundle.manifest.bytes.toString()))).toEqual(
      bundle.model,
    );
    expect(bundle.manifest.mediaType).toBe("application/json");
    expect(bundle.sums.mediaType).toBe("text/plain");
    const ordered = [...bundle.payloadFiles, bundle.manifest];
    for (const file of [...ordered, bundle.sums]) {
      expect(file.sha256).toBe(hash(file.bytes));
      expect(file.byteSize).toBe(file.bytes.length);
    }
    const sums = bundle.sums.bytes.toString("ascii");
    expect(sums).toBe(ordered.map((file) => `${hash(file.bytes)}  ${file.name}\n`).join(""));
    expect(
      sums
        .split("\n")
        .slice(0, -1)
        .map((line) => line.slice(66)),
    ).toEqual([
      "records.xlsx",
      "plan.pdf",
      "validation.json",
      "request-report.pdf",
      "manifest.json",
    ]);
    expect(sums).not.toContain("SHA256SUMS");
    expect(sums).not.toContain("package.zip");
    expect(buildUsRequestManifest(ready, report).manifest.bytes).toEqual(bundle.manifest.bytes);
    expect(buildUsRequestManifest(ready, report).sums.bytes).toEqual(bundle.sums.bytes);
  });

  it.each([false, true])(
    "retains incomplete mode with optional presence (empty %s)",
    async (empty) => {
      const c = await createUsRequestPackageFixture(db.db, {
        mode: "available_records_incomplete",
        empty,
        withPlan: !empty,
      });
      fixtures.push(c);
      const bound = bindUsRequestPackageInputs(c.run, c.tenantId, c.payloads, c.plan, c.context);
      const { buildUsRequestManifest } = await api();
      const result = buildUsRequestManifest(bound, await renderUsRequestReportPdf(bound.model));
      expect(result.model.identity.mode).toBe("available_records_incomplete");
      expect(result.model.files.map((file) => file.name)).toEqual(
        empty
          ? ["validation.json", "request-report.pdf"]
          : ["records.xlsx", "plan.pdf", "validation.json", "request-report.pdf"],
      );
      expect(result.model.missingFiles).toEqual(
        empty
          ? [
              { name: "records.xlsx", code: "empty_selection" },
              { name: "plan.pdf", code: "plan_absent" },
            ]
          : [],
      );
    },
  );

  it("retains all render finding identities separately from historical frozen errors", async () => {
    const c = fixtures[0];
    if (!c) throw new Error("Missing real fixture");
    const frozen = structuredClone(requireUsRequestPackageEvidence(c.run, c.tenantId));
    const source = frozen.validationSnapshot.sources[0];
    const selection = frozen.validationSnapshot.selection.records[0];
    if (!source || !selection) throw new Error("Missing captured source");
    const eventId = randomUUID();
    frozen.validationSnapshot.sources.push({
      ...source,
      eventId,
      lifecycle: "historical_finalized",
    });
    frozen.validationSnapshot.selection.records.push({ ...selection, eventId });
    frozen.validationSnapshot.findings.push({
      code: "HISTORICAL_ONLY",
      severity: "error",
      sourceRecord: `receiving:${eventId}:1`,
      eventId,
      revision: 1,
      message: "Historical validation issue",
    });
    frozen.validationSnapshot.tenantOrigin = {
      schemaVersion: 1,
      verificationPolicy: "us-request-tenant-origin-v1",
      result: "trusted_synthetic",
      trustedSeed: { seedId: c.tenantId, verifiedBy: "us-development-owner-v1" },
    };
    const scopedContentDigest = canonicalExportDigest(frozen.validationSnapshot);
    const bytes = Buffer.from(stableStringify(frozen));
    const renderFindings = [
      {
        code: "RENDER_WARN",
        severity: "warning" as const,
        sourceRecord: `receiving:${source.eventId}:1`,
        eventId: source.eventId,
        revision: 1,
        message: "Lossless render warning",
      },
    ];
    const bound = bindUsRequestPackageInputs(
      { ...c.run, inputSnapshot: frozen, scopedContentDigest },
      c.tenantId,
      {
        ...c.payloads,
        scopedContentDigest,
        renderFindings,
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
    const { buildUsRequestManifest, parseUsRequestManifest } = await api();
    const bundle = buildUsRequestManifest(bound, await renderUsRequestReportPdf(bound.model));
    expect(bundle.model.findingsSummary).toEqual({
      validation: { error: 1, warning: 0, info: 4 },
      render: { error: 0, warning: 1, info: 0 },
    });
    expect(bundle.model.renderFindings).toEqual(renderFindings);
    expect(bundle.model.selectionSummary.capturedRevisionCount).toBe(2);
    expect(bundle.model.selectionSummary.workbookEventCount).toBe(1);
    expect(bundle.model.tenantOrigin.result).toBe("trusted_synthetic");
    expect(parseUsRequestManifest(bundle.model)).toEqual(bundle.model);
  });

  it("rejects cyclic, duplicate, path, omission and strict metadata contradictions", async () => {
    const { buildUsRequestManifest, parseUsRequestManifest } = await api();
    const base = buildUsRequestManifest(ready, report).model;
    const first = base.files[0];
    if (!first) throw new Error("Missing workbook descriptor");
    const variants: unknown[] = [
      { ...base, extra: true },
      { ...base, schemaVersion: 2 },
      { ...base, packageVersion: "future" },
      { ...base, reportRendererVersion: "future" },
      { ...base, identity: { ...base.identity, requesterContact: "private@example.test" } },
      { ...base, files: [...base.files, first] },
      { ...base, files: base.files.slice(1) },
      { ...base, files: [...base.files].reverse() },
      ...["../records.xlsx", "manifest.json", "SHA256SUMS", "package.zip"].map((name) => ({
        ...base,
        files: [{ ...first, name }, ...base.files.slice(1)],
      })),
      {
        ...base,
        files: [{ ...first, sha256: first.sha256.toUpperCase() }, ...base.files.slice(1)],
      },
      { ...base, files: [{ ...first, byteSize: 0 }, ...base.files.slice(1)] },
      { ...base, files: [{ ...first, byteSize: 1.5 }, ...base.files.slice(1)] },
      { ...base, files: [{ ...first, mediaType: "text/plain" }, ...base.files.slice(1)] },
      { ...base, missingFiles: [{ name: "records.xlsx", code: "unknown" }] },
      {
        ...base,
        missingFiles: [
          { name: "records.xlsx", code: "empty_selection", sha256: "0".repeat(64), byteSize: 1 },
        ],
      },
      { ...base, plan: { ...base.plan, pdfSha256: "0".repeat(64) } },
      {
        ...base,
        findingsSummary: { ...base.findingsSummary, render: { error: 0, warning: 1, info: 0 } },
      },
      { ...base, timing: { ...base.timing, elapsedToReportDataPreparationMs: 0 } },
      { ...base, digests: { ...base.digests, inputDigest: null } },
    ];
    for (const variant of variants) failure(() => parseUsRequestManifest(variant));
  });

  it("rehashes actual bytes and rejects metadata-only substitutions and stale pre-report descriptors", async () => {
    const { buildUsRequestManifest } = await api();
    for (const bad of [
      { ...report, name: "plan.pdf" },
      { ...report, mediaType: "application/json" },
      { ...report, byteSize: report.byteSize + 1 },
      { ...report, sha256: "0".repeat(64) },
      { ...report, bytes: Buffer.from("substituted") },
      { ...report, extra: true },
    ])
      failure(() => Reflect.apply(buildUsRequestManifest, undefined, [ready, bad]));
    const original = ready.preReportFiles[0];
    if (!original) throw new Error("Missing workbook");
    for (const altered of [
      { ...original, bytes: Buffer.from("tampered") },
      { ...original, sha256: "0".repeat(64) },
      {
        ...original,
        bytes: Buffer.from("tampered"),
        byteSize: 8,
        sha256: hash(Buffer.from("tampered")),
      },
    ])
      failure(() =>
        buildUsRequestManifest(
          { ...ready, preReportFiles: [altered, ...ready.preReportFiles.slice(1)] },
          report,
        ),
      );
  });

  it("rejects changed identity or frozen metadata even after validation bytes are rehashed", async () => {
    const { buildUsRequestManifest } = await api();
    for (const key of ["tenantId", "requestId"] as const) {
      const model = structuredClone(ready.model);
      model.identity[key] = randomUUID();
      if (key === "requestId") model.request.id = model.identity.requestId;
      failure(() => buildUsRequestManifest({ ...ready, model }, report));
    }
    const preReportFiles = ready.preReportFiles.map((file) => {
      if (file.name !== "validation.json") return file;
      const frozen = JSON.parse(file.bytes.toString());
      frozen.validationSnapshot.request.id = randomUUID();
      const bytes = Buffer.from(stableStringify(frozen));
      return { ...file, bytes, byteSize: bytes.length, sha256: hash(bytes) };
    });
    const model = structuredClone(ready.model);
    model.preReportFiles = preReportFiles.map(({ bytes, ...descriptor }) => {
      void bytes;
      return descriptor;
    });
    failure(() => buildUsRequestManifest({ model, preReportFiles }, report));
  });

  it("rejects a model substituted through an unstable input getter", async () => {
    const { buildUsRequestManifest } = await api();
    const altered = { ...ready.model, schemaVersion: 2 };
    let reads = 0;
    const inputs = {
      get model() {
        reads += 1;
        return reads === 1 ? altered : ready.model;
      },
      preReportFiles: ready.preReportFiles,
    };
    failure(() => Reflect.apply(buildUsRequestManifest, undefined, [inputs, report]));
  });

  it.each(["workbook_unrepresentable", "workbook_writer_failed"] as const)(
    "retains only the accepted trusted %s omission",
    async (code) => {
      const c = await createUsRequestPackageFixture(db.db, {
        mode: "available_records_incomplete",
        withPlan: false,
      });
      fixtures.push(c);
      const bound = bindUsRequestPackageInputs(
        c.run,
        c.tenantId,
        {
          ...c.payloads,
          workbook: null,
          missingWorkbook: { code },
        },
        c.plan,
        c.context,
      );
      const { buildUsRequestManifest, parseUsRequestManifest } = await api();
      const bundle = buildUsRequestManifest(bound, await renderUsRequestReportPdf(bound.model));
      expect(bundle.model.missingFiles).toEqual([
        { name: "records.xlsx", code },
        { name: "plan.pdf", code: "plan_absent" },
      ]);
      expect(bundle.model.files.map((file) => file.name)).toEqual([
        "validation.json",
        "request-report.pdf",
      ]);
      for (const missingFiles of [
        [
          { name: "records.xlsx", code: "unknown" },
          { name: "plan.pdf", code: "plan_absent" },
        ],
        [
          { name: "records.xlsx", code: "empty_selection" },
          { name: "plan.pdf", code: "plan_absent" },
        ],
        [...bundle.model.missingFiles, ...bundle.model.missingFiles],
        [
          { name: "records.xlsx", code, byteSize: 1 },
          { name: "plan.pdf", code: "plan_absent" },
        ],
      ])
        failure(() => parseUsRequestManifest({ ...bundle.model, missingFiles }));
      failure(() =>
        parseUsRequestManifest({
          ...bundle.model,
          identity: { ...bundle.model.identity, mode: "export_ready" },
        }),
      );
    },
  );

  it("checks frozen model facts independently of self-consistent payload descriptors", async () => {
    const { buildUsRequestManifest } = await api();
    const models = [
      { ...ready.model, identity: { ...ready.model.identity, preparedBy: "substituted" } },
      { ...ready.model, stamps: { ...ready.model.stamps, baselineId: "substituted" } },
      {
        ...ready.model,
        findingsSummary: {
          ...ready.model.findingsSummary,
          validation: { error: 1, warning: 0, info: 4 },
        },
      },
      { ...ready.model, scope: { tlcs: ["OTHER"] } },
      {
        ...ready.model,
        tenantOrigin: {
          schemaVersion: 1 as const,
          verificationPolicy: "us-request-tenant-origin-v1" as const,
          result: "trusted_synthetic" as const,
          trustedSeed: {
            seedId: ready.model.identity.tenantId,
            verifiedBy: "us-development-owner-v1" as const,
          },
        },
      },
      { ...ready.model, digests: { ...ready.model.digests, scopedContentDigest: "0".repeat(64) } },
    ];
    for (const model of models) failure(() => buildUsRequestManifest({ ...ready, model }, report));
    const bytes = Buffer.from("rehash changed pinned Plan");
    const sha256 = hash(bytes);
    const preReportFiles = ready.preReportFiles.map((file) =>
      file.name === "plan.pdf" ? { ...file, bytes, byteSize: bytes.length, sha256 } : file,
    );
    const model = structuredClone(ready.model);
    model.plan = { id: randomUUID(), pdfSha256: sha256 };
    model.preReportFiles = preReportFiles.map(({ bytes: fileBytes, ...descriptor }) => {
      void fileBytes;
      return descriptor;
    });
    failure(() => buildUsRequestManifest({ model, preReportFiles }, report));
  });

  it("checks actual report length at 4 MiB before accepting or copying", async () => {
    const { buildUsRequestManifest } = await api();
    // A byte-bound seam, not evidence that padding is a rendered PDF.
    const bytes = Buffer.alloc(4 * 1024 * 1024, 42);
    expect(
      buildUsRequestManifest(ready, {
        ...report,
        bytes,
        byteSize: bytes.length,
        sha256: hash(bytes),
      }).payloadFiles[3]?.byteSize,
    ).toBe(4 * 1024 * 1024);
    const over = Buffer.alloc(4 * 1024 * 1024 + 1, 42);
    failure(
      () =>
        buildUsRequestManifest(ready, {
          ...report,
          bytes: over,
          byteSize: over.length,
          sha256: hash(over),
        }),
      "us_request_package_size_limit",
    );
  });

  it("returns independent file and metadata ownership", async () => {
    const { buildUsRequestManifest } = await api();
    const inputs = {
      model: structuredClone(ready.model),
      preReportFiles: ready.preReportFiles.map((file) => ({
        ...file,
        bytes: Buffer.from(file.bytes),
      })),
    };
    const pdf = { ...report, bytes: Buffer.from(report.bytes) };
    const bundle = buildUsRequestManifest(inputs, pdf);
    const saved = bundle.payloadFiles.map((file) => Buffer.from(file.bytes));
    const manifest = Buffer.from(bundle.manifest.bytes);
    const sums = Buffer.from(bundle.sums.bytes);
    for (const file of inputs.preReportFiles) file.bytes.fill(0);
    inputs.model.identity.preparedBy = "mutated";
    pdf.bytes.fill(0);
    expect(bundle.payloadFiles.map((file) => file.bytes)).toEqual(saved);
    expect(bundle.model.identity.preparedBy).toBe(ready.model.identity.preparedBy);
    for (const file of bundle.payloadFiles) file.bytes.fill(1);
    bundle.model.identity.preparedBy = "returned mutation";
    expect(bundle.manifest.bytes).toEqual(manifest);
    expect(bundle.sums.bytes).toEqual(sums);
    bundle.manifest.bytes.fill(2);
    expect(bundle.sums.bytes).toEqual(sums);
  });

  it("accepts an exact 1 MiB manifest and rejects one extra byte", async () => {
    const { buildUsRequestManifest, parseUsRequestManifest } = await api();
    const model = structuredClone(buildUsRequestManifest(ready, report).model);
    model.stamps.baselineId = "";
    model.stamps.baselineId = "x".repeat(1024 * 1024 - Buffer.byteLength(stableStringify(model)));
    expect(Buffer.byteLength(stableStringify(model))).toBe(1024 * 1024);
    expect(parseUsRequestManifest(model).stamps.baselineId).toBe(model.stamps.baselineId);
    model.stamps.baselineId += "x";
    failure(() => parseUsRequestManifest(model), "us_request_package_size_limit");
  });

  it("enforces sums inclusive bound at its actual canonical length", async () => {
    const { buildUsRequestManifest } = await api();
    const actual = buildUsRequestManifest(ready, report).sums.byteSize;
    expect(actual).toBe(401);
    expect(limits.sums).toBe(16 * 1024);
    const original = limits.sums;
    try {
      Reflect.set(limits, "sums", actual);
      expect(buildUsRequestManifest(ready, report).sums.byteSize).toBe(actual);
      Reflect.set(limits, "sums", actual - 1);
      failure(() => buildUsRequestManifest(ready, report), "us_request_package_size_limit");
    } finally {
      Reflect.set(limits, "sums", original);
    }
  });
});
