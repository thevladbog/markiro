import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { schema, type Db } from "@markiro/db";
import { asc, eq } from "drizzle-orm";
import { unzipSync } from "fflate";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { UsDevelopmentOwnerStore } from "../src/deployment/us-development-owner";
import { UsReceivingStore } from "../src/modules/traceability/receiving/us-receiving-store";
import { bindUsRequestPackageInputs } from "../src/modules/traceability/requests/us-request-package-inputs";
import * as packages from "../src/modules/traceability/requests/us-request-package";
import { verifyUsRequestPackageArchive } from "../src/modules/traceability/requests/us-request-package-zip";
import { renderUsRequestPayloads } from "../src/modules/traceability/requests/us-request-payloads";
import { UsRequestPlanReader } from "../src/modules/traceability/requests/us-request-plan-reader";
import { UsRequestPrepareStore } from "../src/modules/traceability/requests/us-request-prepare";
import * as reports from "../src/modules/traceability/requests/us-request-report-pdf";
import { requireUsRequestPackageEvidence } from "../src/modules/traceability/requests/us-request-run-evidence";
import { UsRequestStore } from "../src/modules/traceability/requests/us-request-store";
import { UsRequestValidationStore } from "../src/modules/traceability/requests/us-request-validation";
import { createUsProfileTestDatabase } from "./support/us-profile-database";
import { seedCompleteReceiving } from "./support/us-receiving-fixture";
import { createUsRequestPackageFixture } from "./support/us-request-package-fixture";
import { createUsRequestPlanFixture } from "./support/us-request-plan-fixture";
import { seedLegacyUsRequestRun } from "./support/us-request-v1-fixture";

const url = process.env.US_TEST_DATABASE_URL;
const modes = ["export_ready", "available_records_incomplete"] as const;
const build = { apiVersion: "test-us09-package", gitSha: "a".repeat(40), dirty: false };
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const syntheticMark = "Synthetic demo — not an operational record";

function retainWitness(path: string, witness: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(witness, null, 2) + "\n");
}

describe("US package test evidence persistence", () => {
  it("writes a real witness when its test-owned nested parent initially does not exist", () => {
    const root = mkdtempSync(join(tmpdir(), "markiro-us-package-witness-"));
    try {
      const path = join(root, "initially-absent", "nested", "witness.json");
      expect(existsSync(dirname(path))).toBe(false);
      retainWitness(path, { mode: "export_ready", repeatZipEqual: true });
      expect(readFileSync(path, "utf8")).toBe(
        '{\n  "mode": "export_ready",\n  "repeatZipEqual": true\n}\n',
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

async function persistedTenantRows(db: Db, tenantId: string) {
  return {
    runs: await db
      .select()
      .from(schema.traceExportRuns)
      .where(eq(schema.traceExportRuns.tenantId, tenantId))
      .orderBy(asc(schema.traceExportRuns.id)),
    artifacts: await db
      .select()
      .from(schema.traceExportArtifacts)
      .where(eq(schema.traceExportArtifacts.tenantId, tenantId))
      .orderBy(asc(schema.traceExportArtifacts.id)),
    plans: await db
      .select()
      .from(schema.traceabilityPlanVersions)
      .where(eq(schema.traceabilityPlanVersions.tenantId, tenantId))
      .orderBy(asc(schema.traceabilityPlanVersions.id)),
    audits: await db
      .select()
      .from(schema.tenantAuditEvents)
      .where(eq(schema.tenantAuditEvents.organizationId, tenantId))
      .orderBy(asc(schema.tenantAuditEvents.id)),
  };
}
function textOf(bytes: Buffer): string {
  const dir = mkdtempSync(join(tmpdir(), "markiro-us-package-integration-"));
  try {
    const path = join(dir, "fixture.pdf");
    writeFileSync(path, bytes);
    return execFileSync("pdftotext", ["-layout", path, "-"], { encoding: "utf8" }).replace(
      /\s+/gu,
      " ",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
function file(result: packages.UsRequestPackageResult, name: string) {
  const found = result.files.find((entry) => entry.name === name);
  if (!found) throw new Error("Missing expected package fixture file");
  return found;
}
function verifyFiles(result: packages.UsRequestPackageResult) {
  verifyUsRequestPackageArchive(result.zip.bytes, {
    files: result.files,
    manifest: result.manifest,
  });
  const archive = unzipSync(result.zip.bytes);
  expect(Object.keys(archive)).toEqual(result.files.map((entry) => entry.name));
  for (const entry of result.files) {
    expect(Buffer.from(archive[entry.name] ?? [])).toEqual(entry.bytes);
    expect(entry.sha256).toBe(hash(entry.bytes));
    expect(entry.byteSize).toBe(entry.bytes.length);
  }
  expect(result.zip.sha256).toBe(hash(result.zip.bytes));
  expect(result.zip.byteSize).toBe(result.zip.bytes.length);
  expect(file(result, "SHA256SUMS").bytes.toString()).toBe(
    result.files
      .filter((entry) => entry.name !== "SHA256SUMS")
      .map((entry) => `${entry.sha256}  ${entry.name}\n`)
      .join(""),
  );
}

// Catches selecting live sources/current Plan, altering upstream bytes, upgrading
// incomplete mode, losing provenance, writing during composition or bypassing fail-closed reads.
describe.skipIf(!url)("US real frozen package integration in owned disposable PostgreSQL", () => {
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
  afterEach(() => vi.restoreAllMocks());
  async function fixture(options: Parameters<typeof createUsRequestPackageFixture>[1]) {
    const c = await createUsRequestPackageFixture(f.db, options);
    fixtures.push(c);
    return c;
  }
  const bind = (c: Awaited<ReturnType<typeof createUsRequestPackageFixture>>) =>
    bindUsRequestPackageInputs(c.run, c.tenantId, c.payloads, c.plan, c.context);

  it.each(modes)(
    "preserves actual upstream bytes and exact rows in repeat packages: %s",
    async (mode) => {
      const c = await fixture({ mode });
      const bound = bind(c);
      const before = await persistedTenantRows(f.db, c.tenantId);
      const calls = structuredClone(c.planFixture.transport.calls);
      const first = await packages.assembleUsRequestPackage(bound);
      const second = await packages.assembleUsRequestPackage(bound);
      verifyFiles(first);
      expect(first.zip.bytes).toEqual(second.zip.bytes);
      expect(first.files).toEqual(second.files);
      expect(isDeepStrictEqual(await persistedTenantRows(f.db, c.tenantId), before)).toBe(true);
      expect(isDeepStrictEqual(c.planFixture.transport.calls, calls)).toBe(true);
      expect(before.runs.length).toBe(1);
      expect(before.artifacts.length).toBe(0);
      expect(before.plans.length).toBe(1);
      expect(before.audits.length).toBeGreaterThan(0);
      expect(first.mode).toBe(mode);
      expect(first.manifest.identity.mode).toBe(mode);
      expect(first.manifest.tenantOrigin.result).toBe("not_attested");
      expect(first.files.map((entry) => entry.name)).toEqual([
        "records.xlsx",
        "plan.pdf",
        "validation.json",
        "request-report.pdf",
        "manifest.json",
        "SHA256SUMS",
      ]);
      if (!c.payloads.workbook || c.plan.kind !== "pdf")
        throw new Error("Missing real upstream files");
      expect(file(first, "records.xlsx").bytes).toEqual(c.payloads.workbook.bytes);
      expect(file(first, "plan.pdf").bytes).toEqual(c.plan.bytes);
      expect(file(first, "validation.json").bytes).toEqual(c.payloads.validation.bytes);
      const approved = before.plans[0];
      if (!approved?.pdfObjectKey) throw new Error("Missing approved Plan fixture");
      expect(file(first, "plan.pdf").bytes).toEqual(
        c.planFixture.objects.get(approved.pdfObjectKey),
      );
      expect(textOf(file(first, "plan.pdf").bytes)).toBe(textOf(c.plan.bytes));
      expect(textOf(c.plan.bytes)).not.toContain(syntheticMark);
      expect(first.manifest.selectionSummary.capturedRevisionCount).toBe(1);
      expect(first.manifest.selectionSummary.workbookEventCount).toBe(1);
      // One Receiving event contains two business items, hence two worksheet data rows.
      const workbook = unzipSync(c.payloads.workbook.bytes);
      const shared = new TextDecoder().decode(workbook["xl/sharedStrings.xml"]);
      const event = requireUsRequestPackageEvidence(c.run, c.tenantId).exportInput?.events[0];
      if (!event) throw new Error("Missing frozen Receiving event");
      for (const line of [1, 2])
        expect(shared).toContain(`receiving:${event.eventId}:1:item:${line}`);
      const tabs = new TextDecoder().decode(workbook["xl/workbook.xml"]);
      expect(tabs).toMatch(/<sheet\b(?=[^>]*\bname="Receiving")(?=[^>]*\bsheetId="3")[^>]*>/u);
      const worksheet = new TextDecoder().decode(workbook["xl/worksheets/sheet3.xml"]);
      expect((worksheet.match(/<row\b/gu) ?? []).length).toBe(3);
      const text = textOf(file(first, "request-report.pdf").bytes);
      expect(text).toContain(
        mode === "export_ready" ? "Export-ready" : "Available records — incomplete",
      );
      expect(text).toContain("Tenant origin not attested");
      expect(text).toContain("Captured revisions: 1");
      expect(text).toContain("Workbook events: 1");
      if (mode === "available_records_incomplete") expect(text).not.toContain("Export-ready");
      // Retain hashes and counts only; never persist requester contact or private object keys.
      retainWitness(
        resolve(
          process.cwd(),
          `../../.superpowers/sdd/2026-10-04-us-09-package-core/task-5-${mode}-witness.json`,
        ),
        {
          mode,
          files: first.files.map(({ bytes, ...descriptor }) => {
            void bytes;
            return descriptor;
          }),
          zip: { sha256: first.zip.sha256, byteSize: first.zip.byteSize },
          capturedRevisionCount: 1,
          workbookEventCount: 1,
          receivingRows: 2,
          repeatZipEqual: true,
          persistedExactEqual: true,
          transportCallsUnchanged: true,
        },
      );
    },
  );

  it.each(modes)(
    "replays the original ZIP after real source/request edits and Plan supersession: %s",
    async (mode) => {
      const c = await fixture({ mode });
      const original = await packages.assembleUsRequestPackage(bind(c));
      const source = requireUsRequestPackageEvidence(c.run, c.tenantId).exportInput?.events[0];
      if (!source || c.plan.kind !== "pdf") throw new Error("Missing original source/Plan");
      const pinnedPlanId = c.plan.planVersionId;
      const receiving = new UsReceivingStore(f.db);
      const live = await receiving.getLiveRecord(c.tenantId, c.actorId, source.eventId);
      const amendment = await receiving.amend(
        c.tenantId,
        c.actorId,
        source.eventId,
        {
          commandVersion: 2,
          operationKey: randomUUID(),
          expectedLifecycleVersion: live.lifecycle.lifecycleVersion,
          reason: "Correct synthetic package receipt",
        },
        "package-drift-amend",
      );
      const checked = await receiving.checkRevisionReadiness(
        c.tenantId,
        c.actorId,
        amendment.eventId,
        { expectedDraftVersion: 1 },
      );
      const finalized = await receiving.finalizeRevision(
        c.tenantId,
        c.actorId,
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
        "package-drift-finalize",
      );
      expect(finalized.record.revision).toBe(2);
      await new UsRequestStore(f.db).update(c.tenantId, c.actorId, c.request.id, {
        expectedRevision: 1,
        requesterName: "Changed later requester",
        scope: { tlcs: ["NO-LATER-MATCH"] },
      });
      const later = await c.planFixture.approve("Synthetic replacement Plan");
      const before = await persistedTenantRows(f.db, c.tenantId);
      expect(before.plans.find((row) => row.id === pinnedPlanId)?.status).toBe("superseded");
      expect(before.plans.find((row) => row.id === later.id)?.status).toBe("effective");
      expect(isDeepStrictEqual(before.runs, [c.run])).toBe(true);
      const payloads = await renderUsRequestPayloads(c.run, c.tenantId);
      const plan = await new UsRequestPlanReader(f.db, c.planFixture.artifacts).read(
        c.run,
        c.tenantId,
      );
      const calls = structuredClone(c.planFixture.transport.calls);
      const replay = await packages.assembleUsRequestPackage(
        bindUsRequestPackageInputs(c.run, c.tenantId, payloads, plan, c.context),
      );
      expect(replay.zip.bytes).toEqual(original.zip.bytes);
      expect(replay.files).toEqual(original.files);
      expect(isDeepStrictEqual(await persistedTenantRows(f.db, c.tenantId), before)).toBe(true);
      expect(isDeepStrictEqual(c.planFixture.transport.calls, calls)).toBe(true);
      expect(plan.kind === "pdf" ? plan.bytes : null).toEqual(c.plan.bytes);
      const text = textOf(file(replay, "request-report.pdf").bytes);
      expect(text).toContain("Synthetic package requester");
      expect(text).not.toContain("Changed later requester");
      expect(text).not.toContain("NO-LATER-MATCH");
      verifyFiles(replay);
    },
  );

  it.each([
    {
      empty: true,
      withPlan: false,
      names: ["validation.json", "request-report.pdf", "manifest.json", "SHA256SUMS"],
      missing: [
        { name: "records.xlsx", code: "empty_selection" },
        { name: "plan.pdf", code: "plan_absent" },
      ],
    },
    {
      empty: false,
      withPlan: false,
      names: [
        "records.xlsx",
        "validation.json",
        "request-report.pdf",
        "manifest.json",
        "SHA256SUMS",
      ],
      missing: [{ name: "plan.pdf", code: "plan_absent" }],
    },
    {
      empty: true,
      withPlan: true,
      names: ["plan.pdf", "validation.json", "request-report.pdf", "manifest.json", "SHA256SUMS"],
      missing: [{ name: "records.xlsx", code: "empty_selection" }],
    },
    {
      empty: false,
      withPlan: true,
      names: [
        "records.xlsx",
        "plan.pdf",
        "validation.json",
        "request-report.pdf",
        "manifest.json",
        "SHA256SUMS",
      ],
      missing: [],
    },
  ])(
    "keeps explicit incomplete inclusion (empty $empty, Plan $withPlan)",
    async ({ empty, withPlan, names, missing }) => {
      const c = await fixture({ mode: "available_records_incomplete", empty, withPlan });
      const before = await persistedTenantRows(f.db, c.tenantId);
      const calls = structuredClone(c.planFixture.transport.calls);
      const result = await packages.assembleUsRequestPackage(bind(c));
      expect(result.files.map((entry) => entry.name)).toEqual(names);
      expect(result.manifest.missingFiles).toEqual(missing);
      expect(result.mode).toBe("available_records_incomplete");
      expect(result.manifest.identity.mode).toBe("available_records_incomplete");
      const text = textOf(file(result, "request-report.pdf").bytes);
      expect(text).toContain("Available records — incomplete");
      expect(text).not.toContain("Export-ready");
      for (const absent of missing) expect(text).toContain(absent.code);
      expect(before.plans.length).toBe(withPlan ? 1 : 0);
      expect(isDeepStrictEqual(await persistedTenantRows(f.db, c.tenantId), before)).toBe(true);
      expect(isDeepStrictEqual(c.planFixture.transport.calls, calls)).toBe(true);
      verifyFiles(result);
    },
  );

  it.each(modes)(
    "fails missing/corrupt/unavailable pinned objects before composition in %s",
    async (mode) => {
      const c = await fixture({ mode });
      const before = await persistedTenantRows(f.db, c.tenantId);
      const approved = before.plans[0];
      if (!approved?.pdfObjectKey) throw new Error("Missing private fixture object");
      const key = approved.pdfObjectKey;
      const original = c.planFixture.objects.get(key);
      if (!original) throw new Error("Missing original private fixture bytes");
      const compose = vi.spyOn(packages, "assembleUsRequestPackage");
      const render = vi.spyOn(reports, "renderUsRequestReportPdf");
      const readThenCompose = async () => {
        const plan = await new UsRequestPlanReader(f.db, c.planFixture.artifacts).read(
          c.run,
          c.tenantId,
        );
        return packages.assembleUsRequestPackage(
          bindUsRequestPackageInputs(c.run, c.tenantId, c.payloads, plan, c.context),
        );
      };
      for (const fault of ["missing", "corrupt", "unavailable"] as const) {
        if (fault === "missing") c.planFixture.objects.delete(key);
        if (fault === "corrupt") c.planFixture.objects.set(key, Buffer.alloc(original.length));
        if (fault === "unavailable") c.planFixture.transport.fault = "unavailable";
        await expect(readThenCompose()).rejects.toMatchObject({
          status: 503,
          response: { code: "us_request_plan_read_failed" },
        });
        c.planFixture.objects.set(key, original);
        c.planFixture.transport.fault = null;
      }
      expect(compose).not.toHaveBeenCalled();
      expect(render).not.toHaveBeenCalled();
      expect(isDeepStrictEqual(await persistedTenantRows(f.db, c.tenantId), before)).toBe(true);
    },
  );

  it.each(modes)(
    "retains real legacy payload bytes while the full v1 package gate precedes reads/render in %s",
    async (mode) => {
      const c = await seedCompleteReceiving(f.db);
      const legacy = await seedLegacyUsRequestRun(f.db, c, mode);
      const original = await renderUsRequestPayloads(legacy, c.tenant);
      const before = await persistedTenantRows(f.db, c.tenant);
      const read = vi.spyOn(UsRequestPlanReader.prototype, "read");
      const render = vi.spyOn(reports, "renderUsRequestReportPdf");
      const compose = vi.spyOn(packages, "assembleUsRequestPackage");
      const fullPipeline = async () => {
        requireUsRequestPackageEvidence(legacy, c.tenant);
        const payloads = await renderUsRequestPayloads(legacy, c.tenant);
        const plan = await new UsRequestPlanReader(f.db, null).read(legacy, c.tenant);
        return packages.assembleUsRequestPackage(
          bindUsRequestPackageInputs(legacy, c.tenant, payloads, plan, {
            schemaVersion: 1,
            workerStartedAt: null,
            reportDataPreparedAt: legacy.startedAt.toISOString(),
          }),
        );
      };
      await expect(fullPipeline()).rejects.toMatchObject({
        status: 409,
        response: { code: "us_request_package_refreeze_required" },
      });
      expect(() =>
        bindUsRequestPackageInputs(
          legacy,
          c.tenant,
          original,
          { kind: "absent", code: "plan_absent" },
          {
            schemaVersion: 1,
            workerStartedAt: null,
            reportDataPreparedAt: legacy.startedAt.toISOString(),
          },
        ),
      ).toThrow(
        expect.objectContaining({
          status: 409,
          response: { code: "us_request_package_refreeze_required" },
        }),
      );
      expect(read).not.toHaveBeenCalled();
      expect(render).not.toHaveBeenCalled();
      expect(compose).not.toHaveBeenCalled();
      const replay = await renderUsRequestPayloads(legacy, c.tenant);
      expect(replay).toEqual(original);
      expect(replay.validation.sha256).toBe(hash(original.validation.bytes));
      expect(JSON.parse(replay.validation.bytes.toString())).toMatchObject({ schemaVersion: 1 });
      if (mode === "export_ready") {
        if (!replay.workbook || !original.workbook) throw new Error("Missing real v1 workbook");
        expect(replay.workbook.sha256).toBe(hash(original.workbook.bytes));
        expect(Object.keys(unzipSync(replay.workbook.bytes))).toContain("xl/workbook.xml");
      }
      expect(isDeepStrictEqual(await persistedTenantRows(f.db, c.tenant), before)).toBe(true);
    },
  );

  it("uses actual reserved owner provisioning and preserves original synthetic Plan marks", async () => {
    if (!url) throw new Error("Missing isolated US database URL");
    const child = await createUsProfileTestDatabase(url);
    let planFixture: ReturnType<typeof createUsRequestPlanFixture> | undefined;
    try {
      const owner = await new UsDevelopmentOwnerStore(child.db).provision(
        "Synthetic-local-owner-password-42!",
        randomUUID(),
      );
      await child.db.insert(schema.traceabilityProfiles).values({
        tenantId: owner.tenantId,
        code: "US_FSMA204_PROCESSOR",
        baselineVersion: "US-REG-2026-09-03",
        retentionYears: 5,
        effectiveAt: new Date(),
        updatedByUserId: owner.userId,
      });
      await child.db
        .insert(schema.orgProfiles)
        .values({ tenantId: owner.tenantId, timeZone: "America/Chicago" });
      const partyId = randomUUID();
      await child.db
        .insert(schema.traceabilityParties)
        .values({ id: partyId, tenantId: owner.tenantId, name: "Synthetic source" });
      await child.db.insert(schema.traceabilityLocations).values({
        tenantId: owner.tenantId,
        partyId,
        name: "Synthetic source",
        businessName: "Synthetic source",
        phoneNumber: "+1 555 0100",
        streetAddress: "10 Main",
        city: "Chicago",
        stateOrRegion: "IL",
        zipOrPostalCode: "60601",
        countryCode: "US",
        roles: ["tlc_source"],
      });
      planFixture = createUsRequestPlanFixture(child.db, {
        tenant: owner.tenantId,
        actor: owner.userId,
      });
      const approved = await planFixture.approve("Synthetic reserved package Plan");
      const originalPlan = Buffer.from(planFixture.objects.get(approved.artifact.objectKey) ?? []);
      const originalPlanText = textOf(originalPlan);
      expect(originalPlanText).toContain(syntheticMark);
      const request = await new UsRequestStore(child.db).create(owner.tenantId, owner.userId, {
        requestNumber: randomUUID(),
        requesterName: "Synthetic reserved requester",
        requesterOrganization: null,
        requesterContact: null,
        receivedAt: "2026-10-04T00:00:00Z",
        scope: { tlcs: ["NO-MATCH-RESERVED-PACKAGE"] },
      });
      await new UsRequestValidationStore(child.db).validate(
        owner.tenantId,
        owner.userId,
        request.id,
        build,
      );
      const run = await new UsRequestPrepareStore(child.db).prepare(
        owner.tenantId,
        owner.userId,
        request.id,
        {
          mode: "available_records_incomplete",
          idempotencyKey: randomUUID(),
        },
        build,
      );
      const payloads = await renderUsRequestPayloads(run, owner.tenantId);
      const plan = await new UsRequestPlanReader(child.db, planFixture.artifacts).read(
        run,
        owner.tenantId,
      );
      const before = await persistedTenantRows(child.db, owner.tenantId);
      const calls = structuredClone(planFixture.transport.calls);
      const result = await packages.assembleUsRequestPackage(
        bindUsRequestPackageInputs(run, owner.tenantId, payloads, plan, {
          schemaVersion: 1,
          workerStartedAt: null,
          reportDataPreparedAt: new Date(run.startedAt.getTime() + 2000).toISOString(),
        }),
      );
      expect(result.manifest.tenantOrigin).toEqual({
        schemaVersion: 1,
        verificationPolicy: "us-request-tenant-origin-v1",
        result: "trusted_synthetic",
        trustedSeed: { seedId: owner.tenantId, verifiedBy: "us-development-owner-v1" },
      });
      expect(result.manifest.selectionSummary.capturedRevisionCount).toBe(0);
      expect(result.manifest.missingFiles).toEqual([
        { name: "records.xlsx", code: "empty_selection" },
      ]);
      expect(file(result, "plan.pdf").bytes).toEqual(originalPlan);
      expect(textOf(file(result, "plan.pdf").bytes)).toBe(originalPlanText);
      const text = textOf(file(result, "request-report.pdf").bytes);
      expect(text).toContain(syntheticMark);
      expect(text).toContain("Available records — incomplete");
      expect(text).not.toContain("Verified operational");
      expect(
        before.audits.filter((row) => row.action === "us.development.owner.provisioned"),
      ).toHaveLength(1);
      expect(isDeepStrictEqual(await persistedTenantRows(child.db, owner.tenantId), before)).toBe(
        true,
      );
      expect(isDeepStrictEqual(planFixture.transport.calls, calls)).toBe(true);
      verifyFiles(result);
    } finally {
      planFixture?.destroy();
      await child.close();
    }
  }, 60_000);
});
