import { createHash, randomUUID } from "node:crypto";
import { inspect } from "node:util";
import { schema } from "@markiro/db";
import { and, eq } from "drizzle-orm";
import { DocumentBuilder, SwaggerModule } from "@nestjs/swagger";
import { decodeReceivingCsvExport, usCurrentTraceResultSchema } from "@markiro/platform-contracts";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  disposeUsViewerHttpFixtureResources,
  startUsDemoViewerHttpFixture,
  usViewerHttpFixtureFailure,
  type UsDemoViewerHttpFixture,
} from "./support/us-demo-viewer-http-fixture";
import { emptyReceivingDraft } from "./support/us-receiving-fixture";
import { csvRequest, csvRow } from "./support/us-receiving-csv-fixture";

const url = process.env.US_TEST_DATABASE_URL;
type ProviderSnapshot = ReturnType<UsDemoViewerHttpFixture["providerSnapshot"]>;
function assertCompleteViewerProviderInterval(before: ProviderSnapshot, after: ProviderSnapshot) {
  expect(after.package.slice(0, before.package.length)).toEqual(before.package);
  expect(after.plan.slice(0, before.plan.length)).toEqual(before.plan);
  expect(after.package.slice(before.package.length)).toEqual([
    "get",
    "get",
    "get",
    "get",
    "get",
    "get",
  ]);
  expect(after.plan.slice(before.plan.length)).toEqual(["GetObjectCommand"]);
  expect(after.active).toBe(0);
  expect(after.failures).toBe(0);
  expect(after.openStreams).toBe(0);
}
describe("viewer HTTP closed failure diagnostics and global provider accounting", () => {
  it("accepts exactly the permitted whole-view reads after preparation writes", () => {
    const before: ProviderSnapshot = {
      active: 0,
      failures: 0,
      openStreams: 0,
      package: ["put"],
      plan: ["PutObjectCommand"],
    };
    expect(() =>
      assertCompleteViewerProviderInterval(before, {
        ...before,
        package: [...before.package, "get", "get", "get", "get", "get", "get"],
        plan: [...before.plan, "GetObjectCommand"],
      }),
    ).not.toThrow();
  });
  it("projects arbitrary acquisition details into a finite secret-free error", () => {
    const sentinel = "fixture-redaction-projection-sentinel-734aa";
    const unsafe = Object.assign(new Error(sentinel), {
      query: sentinel,
      params: [sentinel],
      cause: new Error(sentinel),
    });
    const projected = usViewerHttpFixtureFailure(unsafe, true);
    expect(inspect(projected, { showHidden: true, depth: 8 }).includes(sentinel)).toBe(false);
    expect(projected.message).toBe(
      "Viewer HTTP fixture acquisition failed: unknown; cleanup failed",
    );
    expect(Object.hasOwn(projected, "cause")).toBe(false);
    expect(usViewerHttpFixtureFailure("viewer-provision").message).toBe(
      "Viewer HTTP fixture acquisition failed: viewer-provision",
    );
  });
  it("redacts cleanup errors and attempts every later cleanup stage", async () => {
    const sentinel = "fixture-redaction-cleanup-sentinel-4feb9";
    const stages: string[] = [];
    let failure: unknown;
    try {
      await disposeUsViewerHttpFixtureResources([
        {
          phase: "application",
          dispose() {
            stages.push("application");
            throw Object.assign(new Error(sentinel), {
              params: [sentinel],
              cause: new Error(sentinel),
            });
          },
        },
        {
          phase: "private-stores",
          dispose() {
            stages.push("private-stores");
            throw new AggregateError([new Error(sentinel)], sentinel);
          },
        },
        {
          phase: "child-database",
          dispose() {
            stages.push("child-database");
          },
        },
        {
          phase: "child-absence",
          dispose() {
            stages.push("child-absence");
          },
        },
        {
          phase: "catalog",
          dispose() {
            stages.push("catalog");
          },
        },
        {
          phase: "listener",
          dispose() {
            stages.push("listener");
          },
        },
        {
          phase: "inventory-pool",
          dispose() {
            stages.push("inventory-pool");
          },
        },
      ]);
    } catch (error) {
      failure = error;
    }
    expect(stages).toEqual([
      "application",
      "private-stores",
      "child-database",
      "child-absence",
      "catalog",
      "listener",
      "inventory-pool",
    ]);
    expect(failure instanceof AggregateError).toBe(true);
    expect(inspect(failure, { showHidden: true, depth: 8 }).includes(sentinel)).toBe(false);
    if (!(failure instanceof AggregateError)) throw new Error("Expected finite cleanup failure");
    expect(
      failure.errors.map((error: unknown) => (error instanceof Error ? error.message : "unknown")),
    ).toEqual([
      "Viewer HTTP fixture cleanup failed: application",
      "Viewer HTTP fixture cleanup failed: private-stores",
    ]);
  });
  it.each(["put", "delete", "delete-restore"] as const)(
    "rejects a global provider %s despite restored identical private bytes",
    (mutation) => {
      const baseline: ProviderSnapshot = {
        active: 0,
        failures: 0,
        openStreams: 0,
        package: ["put"],
        plan: ["PutObjectCommand"],
      };
      const beforeBytes = Buffer.from("unchanged-owned-private-fixture-bytes");
      const restoredBytes = Buffer.from(beforeBytes);
      const extra: ProviderSnapshot["package"] =
        mutation === "delete-restore" ? ["delete", "put"] : [mutation];
      const current: ProviderSnapshot = {
        ...baseline,
        package: [...baseline.package, ...extra, "get", "get", "get", "get", "get", "get"],
        plan: [...baseline.plan, "GetObjectCommand"],
      };
      expect(restoredBytes.equals(beforeBytes)).toBe(true);
      expect(() => assertCompleteViewerProviderInterval(baseline, current)).toThrow();
    },
  );
});
describe("viewer HTTP fixture rejects non-isolated database targets before acquisition", () => {
  it("redacts malformed URL input before an acquisition error reaches the test runner", async () => {
    const sentinel = "fixture-redaction-url-sentinel-591ab";
    let failure: unknown;
    try {
      await startUsDemoViewerHttpFixture(`${sentinel} is not a URL`);
    } catch (error) {
      failure = error;
    }
    expect(failure instanceof Error).toBe(true);
    // Boolean comparison prevents a RED from printing the sentinel-bearing error.
    expect(inspect(failure, { showHidden: true, depth: 8 }).includes(sentinel)).toBe(false);
  });
  it.each([
    ["wrong port", "postgres://markiro_us:synthetic@127.0.0.1:5432/markiro_us_dev"],
    ["wrong database", "postgres://markiro_us:synthetic@127.0.0.1:55432/unknown"],
    ["wrong user", "postgres://unknown:synthetic@127.0.0.1:55432/markiro_us_dev"],
    ["remote host", "postgres://markiro_us:synthetic@example.test:55432/markiro_us_dev"],
    ["URL parameters", "postgres://markiro_us:synthetic@127.0.0.1:55432/markiro_us_dev?ssl=true"],
  ])("refuses %s before any connection", async (_label, target) => {
    if (!target) throw new Error("Missing negative target");
    await expect(startUsDemoViewerHttpFixture(target)).rejects.toThrow(
      "Viewer HTTP tests require the isolated loopback database",
    );
  });
});
describe.skipIf(!url)("reserved viewer actual HTTP permissions and private release", () => {
  let fixture: Awaited<ReturnType<typeof startUsDemoViewerHttpFixture>>;
  let business: Awaited<ReturnType<typeof fixture.businessSnapshot>>;
  let privateBytes: ReturnType<typeof fixture.privateSnapshot>;
  let auth: Awaited<ReturnType<typeof fixture.authSnapshot>>;
  let audits: Awaited<ReturnType<typeof fixture.auditSnapshot>>;
  let identities: Awaited<ReturnType<typeof fixture.identitySnapshot>>;
  let providerBaseline: ProviderSnapshot;
  const covered = new Set<string>();
  const limiterWaits: { advertisedMs: number; elapsedMs: number }[] = [];
  let bodyStartedAt = 0;
  const withinBodyBudget = () =>
    expect(performance.now() - bodyStartedAt).toBeLessThanOrEqual(60000);
  const digestBytes = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
  function cover(method: string, path: string) {
    covered.add(
      `${method} ${
        path
          .replace(/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/g, "{id}")
          .replace(
            /\/artifacts\/(?:xlsx|plan_pdf|validation_report|request_report|manifest|package_zip)$/,
            "/artifacts/{id}",
          )
          .split("?")[0]
      }`,
    );
  }
  async function request(path: string, method = "GET", body?: unknown) {
    withinBodyBudget();
    cover(method, path);
    return fixture.request(path, method, body);
  }
  async function unchanged() {
    expect(await fixture.businessSnapshot()).toEqual(business);
    expect(fixture.privateSnapshot()).toEqual(privateBytes);
    expect(fixture.providerSnapshot().openStreams).toBe(0);
    expect(fixture.providerSnapshot().active).toBe(0);
    expect(fixture.providerSnapshot().failures).toBe(0);
    expect(await fixture.identitySnapshot()).toEqual(identities);
  }
  async function authCounts(sessions: number, verifications: number, assurances: number) {
    const snapshot = await fixture.authSnapshot();
    expect(
      Object.fromEntries(Object.entries(snapshot).map(([name, row]) => [name, row?.count])),
    ).toEqual({
      user: 3,
      account: 2,
      session: sessions,
      verification: verifications,
      us_two_factors: 1,
      us_session_assurances: assurances,
    });
  }
  async function auditDelta(expected: unknown[]) {
    const current = await fixture.auditSnapshot();
    const previous = new Set(audits.map((row) => row.id));
    expect(current.filter((row) => previous.has(row.id))).toEqual(audits);
    const added = current.filter((row) => !previous.has(row.id));
    expect(added).toHaveLength(expected.length);
    expect(added).toEqual(expect.arrayContaining(expected));
    audits = current;
  }
  function audit(
    response: Response,
    action: string,
    targetType: string,
    targetId: string | null,
    outcome: string,
    after: unknown,
  ) {
    const requestId = response.headers.get("x-request-id");
    expect(requestId).toMatch(/^[a-f0-9-]{36}$/);
    return {
      id: expect.any(String),
      createdAt: expect.any(Date),
      organizationId: fixture.tenantId,
      actorUserId: fixture.viewerUserId,
      requestId,
      action,
      targetType,
      targetId,
      outcome,
      before: null,
      after,
    };
  }
  async function verifyRespectingLimiter() {
    let response = await fixture.viewer.verify();
    if (response.status === 429) {
      const seconds = Number(response.headers.get("x-retry-after"));
      expect(response.status).toBe(429);
      expect(Number.isInteger(seconds)).toBe(true);
      expect(seconds).toBeGreaterThan(0);
      expect(seconds).toBeLessThanOrEqual(10);
      expect(limiterWaits.length).toBeLessThan(3);
      expect(performance.now() - bodyStartedAt + seconds * 1000 + 50).toBeLessThanOrEqual(60000);
      const started = performance.now();
      await new Promise((resolve) => setTimeout(resolve, seconds * 1000 + 50));
      limiterWaits.push({
        advertisedMs: seconds * 1000,
        elapsedMs: Math.ceil(performance.now() - started),
      });
      console.info(
        `[viewer-http-mfa-pacing] bounded wait ${seconds * 1000 + 50}ms; measured ${limiterWaits.at(-1)?.elapsedMs}ms; one retry`,
      );
      response = await fixture.viewer.verify();
    }
    expect(response.status).toBe(200);
  }
  beforeAll(async () => {
    if (!url) throw new Error("Explicit isolated US test URL required");
    fixture = await startUsDemoViewerHttpFixture(url);
    business = await fixture.businessSnapshot();
    privateBytes = fixture.privateSnapshot();
    audits = await fixture.auditSnapshot();
    identities = await fixture.identitySnapshot();
    providerBaseline = fixture.providerSnapshot();
    console.info(
      `[viewer-http-preparation] business tables ${Object.keys(business).length}; nonempty ${JSON.stringify(
        Object.fromEntries(
          Object.entries(business)
            .filter(([, row]) => row.count > 0)
            .map(([name, row]) => [name, row.count]),
        ),
      )}`,
    );
    bodyStartedAt = performance.now();
  }, 60000);
  afterEach(() => {
    if (fixture) withinBodyBudget();
  });
  afterAll(async () => {
    if (fixture)
      console.info(
        `[viewer-http-budget] body elapsed ${Math.ceil(performance.now() - bodyStartedAt)}ms; MFA waits ${limiterWaits.length}; advertised ${limiterWaits.reduce((sum, wait) => sum + wait.advertisedMs, 0)}ms; measured ${limiterWaits.reduce((sum, wait) => sum + wait.elapsedMs, 0)}ms`,
      );
    await fixture?.close();
  }, 60000);
  it("authenticates a separately provisioned reserved viewer through normal HTTP", async () => {
    expect((await fixture.viewer.signIn()).status).toBe(200);
    expect(fixture.viewerUserId).not.toBe(fixture.ownerUserId);
    expect(fixture.source.run.createdBy).toBe(fixture.ownerUserId);
    expect(fixture.source.request.createdBy).toBe(fixture.ownerUserId);
    expect((await request("/traceability/access")).status).toBe(403);
    expect((await fixture.viewer.select()).status).toBe(403);
    expect((await fixture.viewer.client.request("/organization/list")).status).toBe(403);
    await fixture.viewer.enroll();
    expect((await fixture.viewer.trustDevice()).status).toBe(400);
    expect((await fixture.viewer.verify()).status).toBe(200);
    expect((await fixture.viewer.select()).status).toBe(200);
    expect((await fixture.viewer.replaceFactor()).status).toBe(403);
    const access = await request("/traceability/access");
    expect(access.status).toBe(200);
    expect(await access.json()).toEqual({
      capabilities: ["traceability.read", "traceability.export.read"],
    });
    auth = await fixture.authSnapshot();
    expect(
      Object.fromEntries(Object.entries(auth).map(([name, row]) => [name, row?.count])),
    ).toEqual({
      user: 3,
      account: 2,
      session: 1,
      verification: 0,
      us_two_factors: 1,
      us_session_assurances: 1,
    });
    await auditDelta([]);
    await unchanged();
  });

  it("reads every registered viewer read surface with exact tenant/profile/event/run identity", async () => {
    const c = fixture.context,
      r = fixture.receiving.id;
    const reads = [
      "/traceability/profile",
      "/traceability/parties",
      `/traceability/parties/${c.party}`,
      "/traceability/locations",
      `/traceability/locations/${c.location}`,
      "/traceability/catalog/products",
      `/traceability/catalog/products/${c.product}`,
      `/traceability/products/${c.product}`,
      "/traceability/reference-documents",
      `/traceability/reference-documents/${c.document}`,
      "/traceability/lots",
      `/traceability/lots/${c.lot}`,
      `/traceability/lots/${c.lot}/receiving-basis`,
      `/traceability/lots/${c.lot}/shipping-balance`,
      `/traceability/lots/${c.lot}/cases`,
      `/traceability/lots/${c.lot}/card`,
      `/traceability/lots/${c.lot}/card/evidence`,
      "/traceability/search?tlc=00001",
      `/traceability/readiness?lotId=${c.lot}`,
      "/traceability/events",
      "/traceability/receiving",
      "/traceability/receiving?history=all",
      `/traceability/receiving/${r}`,
      `/traceability/receiving/${r}/revisions`,
      `/traceability/receiving/${fixture.receivingDraft.id}/readiness?expectedDraftVersion=1`,
      `/traceability/lots/${c.lot}/trace?direction=backward`,
      `/traceability/lots/${c.lot}/trace?direction=forward`,
      `/traceability/lots/${c.lot}/trace/history`,
      `/traceability/transformation/${fixture.transformation.id}`,
      `/traceability/transformation/${fixture.transformation.id}/readiness?expectedDraftVersion=1`,
      `/traceability/transformation/${fixture.transformation.id}/revisions`,
      `/traceability/shipments/${fixture.shipping.id}`,
      `/traceability/shipments/${fixture.shipping.id}/readiness?expectedDraftVersion=1`,
      `/traceability/shipments/${fixture.shipping.id}/revisions?limit=20&offset=0`,
      `/traceability/cases/lookup?sscc=${fixture.sscc}`,
      `/traceability/lots/${fixture.outputLotId}/cases`,
      "/traceability/plans",
      `/traceability/plans/${fixture.plan.id}`,
      `/traceability/plans/${fixture.draftPlan.id}`,
      "/traceability/requests",
      `/traceability/requests/${fixture.source.request.id}`,
      `/traceability/requests/${fixture.source.request.id}/runs`,
      `/traceability/export-runs/${fixture.source.run.id}`,
      `/traceability/export-runs/${fixture.source.run.id}/attempts`,
    ];
    for (const path of reads) {
      const response = await request(path);
      expect(response.status, path).toBe(200);
      expect(response.headers.get("cache-control"), path).toBe("no-store");
      const value: unknown = await response.json();
      expect(JSON.stringify(value)).not.toContain(fixture.foreign.tenant);
    }
    const profile = await (await request("/traceability/profile")).json();
    expect(profile).toMatchObject({
      code: "US_FSMA204_PROCESSOR",
      baselineVersion: "US-REG-2026-09-03",
      retentionYears: 2,
      timeZone: "America/Los_Angeles",
    });
    const lot = await (await request(`/traceability/lots/${c.lot}`)).json();
    expect(lot).toMatchObject({ id: c.lot, productId: c.product, tlc: "00001" });
    const detail = await (
      await request(`/traceability/requests/${fixture.source.request.id}`)
    ).json();
    expect(detail).toMatchObject({ id: fixture.source.request.id, revision: 1 });
    const lookup = await (await request(`/traceability/cases/lookup?sscc=${fixture.sscc}`)).json();
    expect(lookup).toMatchObject({
      boxId: fixture.boxId,
      sscc: "012345670000000015",
      provenance: "existing_record",
      activeLink: {
        lotId: fixture.outputLotId,
        linkedBy: fixture.ownerUserId,
        ssccAtLink: "012345670000000015",
      },
    });
    for (const direction of ["upstream", "downstream"]) {
      const genealogy = await request("/traceability/transformation/genealogy/query", "POST", {
        startLotId: fixture.outputLotId,
        direction,
        mode: "current",
        maxDepth: 3,
        maxNodes: 50,
      });
      expect(genealogy.status).toBe(200);
    }
    expect((await request(`/traceability/receiving/imports/${randomUUID()}`)).status).toBe(403);
    const previous = await (
      await request(`/traceability/receiving/${fixture.receiving.id}`)
    ).json();
    const current = await (
      await request(`/traceability/receiving/${fixture.corrected.record.id}`)
    ).json();
    expect(previous).toMatchObject({
      id: fixture.receiving.id,
      revision: 1,
      status: "amended",
      content: {
        kind: "finalized",
        snapshot: {
          notes: null,
          items: [
            { quantity: "500.000", unitOfMeasure: "lb" },
            { quantity: "0.250", unitOfMeasure: "kg" },
          ],
        },
      },
    });
    expect(current).toMatchObject({
      revision: 2,
      status: "finalized",
      content: { kind: "finalized", snapshot: { notes: "Corrected compact HTTP fixture note" } },
    });
    for (const [rootLotId, direction] of [
      [fixture.outputLotId, "backward"],
      [c.lot, "forward"],
    ]) {
      const trace = usCurrentTraceResultSchema.parse(
        await (
          await request(`/traceability/lots/${rootLotId}/trace?direction=${direction}`)
        ).json(),
      );
      expect(trace.rootLotId).toBe(rootLotId);
      expect(trace.direction).toBe(direction);
      expect(trace.nodes).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ kind: "lot", lotId: c.lot, tlc: "00001" }),
          expect.objectContaining({
            kind: "lot",
            lotId: fixture.outputLotId,
            tlc: "HTTP-OUTPUT-001",
          }),
        ]),
      );
      expect(trace.edges).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            kind: "transformation_input",
            eventId: fixture.finalizedTransformation.id,
            eventDate: "2026-09-08",
            quantity: "0.250",
            unitOfMeasure: "kg",
          }),
          expect.objectContaining({
            kind: "transformation_output",
            eventId: fixture.finalizedTransformation.id,
            quantity: "0.100",
            unitOfMeasure: "kg",
          }),
        ]),
      );
      expect(trace.currentEvents).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: fixture.finalizedTransformation.id,
            revision: 1,
            timeZone: "America/Los_Angeles",
          }),
        ]),
      );
      if (direction === "backward")
        expect(trace.currentEvents).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ id: fixture.corrected.record.id, revision: 2 }),
          ]),
        );
    }
    await auditDelta([]);
    expect(await fixture.authSnapshot()).toEqual(auth);
    await unchanged();
  });

  it("preserves the existing ephemeral draft-preview and audited Receiving CSV read semantics", async () => {
    const provider = fixture.providerSnapshot();
    const preview = await request(`/traceability/plans/${fixture.draftPlan.id}/preview`, "POST", {
      expectedRevision: 1,
    });
    expect(preview.status).toBe(200);
    expect(preview.headers.get("content-type")).toBe("application/pdf");
    expect(preview.headers.get("x-plan-draft-revision")).toBe("1");
    expect(
      Buffer.from(await preview.arrayBuffer())
        .subarray(0, 5)
        .toString(),
    ).toBe("%PDF-");
    const record = fixture.corrected.record;
    const csv = await request(
      `/traceability/receiving/${record.id}/export.csv?expectedDraftVersion=${record.draftVersion}&expectedLifecycleVersion=${record.lifecycle.lifecycleVersion}`,
    );
    expect(csv.status).toBe(200);
    const bytes = Buffer.from(await csv.arrayBuffer());
    const decoded = decodeReceivingCsvExport(bytes);
    expect(decoded.record).toEqual(record);
    expect(csv.headers.get("content-type")).toBe("text/csv; charset=utf-8");
    expect(csv.headers.get("content-disposition")).toBe(
      `attachment; filename="markiro-receiving-${record.id}-r2-d${record.draftVersion}-l${record.lifecycle.lifecycleVersion}.csv"`,
    );
    expect(csv.headers.get("x-markiro-export-sha256")).toBe(digestBytes(bytes));
    await auditDelta([
      audit(
        csv,
        "traceability.receiving.csv_generated",
        "traceability_event",
        record.id,
        "success",
        {
          eventId: record.id,
          revision: 2,
          draftVersion: record.draftVersion,
          lifecycleVersion: record.lifecycle.lifecycleVersion,
          status: "finalized",
          contentKind: "finalized",
          formatVersion: "markiro-receiving-export-v1",
          capturedAt: decoded.capturedAt,
          itemCount: 2,
          documentCount: 1,
          byteCount: bytes.length,
          sha256: digestBytes(bytes),
        },
      ),
    ]);
    expect(fixture.providerSnapshot()).toEqual(provider);
    expect(await fixture.authSnapshot()).toEqual(auth);
    await unchanged();
  });

  it("releases the approved pinned Plan PDF and exactly six immutable artifacts with exact audit fields", async () => {
    const before = fixture.providerSnapshot();
    const expectedAudits: unknown[] = [];
    const pdf = await request(`/traceability/plans/${fixture.plan.id}/pdf`);
    expect(pdf.status).toBe(200);
    const pdfBytes = Buffer.from(await pdf.arrayBuffer());
    expect(pdfBytes.equals(fixture.planBytes())).toBe(true);
    expect(digestBytes(pdfBytes)).toBe(fixture.plan.pdf_sha256);
    expect(pdf.headers.get("content-type")).toBe("application/pdf");
    expect(pdf.headers.get("content-length")).toBe(String(pdfBytes.length));
    expect(pdf.headers.get("content-disposition")).toBe(
      'attachment; filename="traceability-plan.pdf"',
    );
    expect(pdf.headers.get("cache-control")).toBe("no-store");
    expect(pdf.headers.get("x-content-type-options")).toBe("nosniff");
    expectedAudits.push(
      audit(
        pdf,
        "traceability.plan.downloaded",
        "traceability_plan_version",
        fixture.plan.id,
        "success",
        { versionNumber: 1, sha256: fixture.plan.pdf_sha256 },
      ),
    );
    expect(fixture.artifacts.map((item) => item.kind).sort()).toEqual([
      "manifest",
      "package_zip",
      "plan_pdf",
      "request_report",
      "validation_report",
      "xlsx",
    ]);
    expect(Object.fromEntries(fixture.artifacts.map((item) => [item.kind, item.filename]))).toEqual(
      {
        xlsx: "records.xlsx",
        plan_pdf: "plan.pdf",
        validation_report: "validation.json",
        request_report: "request-report.pdf",
        manifest: "manifest.json",
        package_zip: "package.zip",
      },
    );
    for (const artifact of fixture.artifacts) {
      const response = await request(
        `/traceability/export-runs/${fixture.source.run.id}/artifacts/${artifact.kind}`,
      );
      expect(response.status, artifact.kind).toBe(200);
      const bytes = Buffer.from(await response.arrayBuffer());
      expect(bytes.equals(fixture.artifactBytes(artifact.kind))).toBe(true);
      expect(digestBytes(bytes)).toBe(artifact.sha256);
      if (artifact.kind === "plan_pdf") expect(artifact.sha256).toBe(fixture.plan.pdf_sha256);
      expect(response.headers.get("content-type")).toBe(
        artifact.mediaType === "application/json"
          ? "application/json; charset=utf-8"
          : artifact.mediaType,
      );
      expect(response.headers.get("content-length")).toBe(String(artifact.byteSize));
      expect(response.headers.get("content-disposition")).toBe(
        `attachment; filename="${artifact.filename}"`,
      );
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
      expect(response.headers.get("etag")).toBeNull();
      expectedAudits.push(
        audit(
          response,
          "traceability.request.artifact_downloaded",
          "trace_export_run",
          fixture.source.run.id,
          "success",
          {
            requestId: fixture.source.request.id,
            requestRevision: 1,
            runRevision: fixture.source.run.revision,
            mode: "available_records_incomplete",
            kind: artifact.kind,
            byteSize: Number(artifact.byteSize),
            sha256: artifact.sha256,
          },
        ),
      );
    }
    await auditDelta(expectedAudits);
    const after = fixture.providerSnapshot();
    expect(after.package.slice(before.package.length)).toEqual(Array(6).fill("get"));
    expect(after.plan.slice(before.plan.length)).toEqual(["GetObjectCommand"]);
    expect(await fixture.authSnapshot()).toEqual(auth);
    await unchanged();
  });

  it("denies direct registered business, QA, settings, Plan and Request mutations without business/private effects", async () => {
    const c = fixture.context,
      p = fixture.plan.id,
      r = fixture.source.request.id,
      run = fixture.source.run.id;
    const id = randomUUID(),
      confirmations = {
        procedures: true,
        backupAndRecovery: true,
        contact: true,
        nonFarmScope: true,
      };
    const expectedAudits: unknown[] = [];
    const rows: [string, string, unknown, string?][] = [
      [
        "PUT",
        "/traceability/profile",
        { code: "US_FSMA204_PROCESSOR", retentionYears: 2, timeZone: "America/Los_Angeles" },
      ],
      ["POST", "/traceability/parties", { name: "Forbidden" }],
      ["PATCH", `/traceability/parties/${c.party}`, { name: "Forbidden", expectedRevision: 1 }],
      ["POST", "/traceability/locations", { name: "Forbidden", partyId: c.party }],
      [
        "PATCH",
        `/traceability/locations/${c.location}`,
        { name: "Forbidden", expectedRevision: 1 },
      ],
      ["POST", "/traceability/catalog/products", { name: "Forbidden" }],
      [
        "PATCH",
        `/traceability/catalog/products/${c.product}`,
        { name: "Forbidden", expectedRevision: 1 },
      ],
      [
        "PUT",
        `/traceability/products/${c.product}`,
        {
          expectedRevision: 1,
          productName: "Synthetic apples",
          brandName: null,
          commodity: null,
          variety: null,
          packagingSizeValue: "10",
          packagingSizeUom: "lb",
          packagingStyle: "Case",
          defaultQuantityUom: null,
          coverageStatus: "not_covered",
          coverageRationale: "Forbidden review",
          ftlCategory: null,
          ftlSourceUrl: null,
          ftlSourceVersion: null,
        },
      ],
      [
        "POST",
        "/traceability/reference-documents",
        { type: "bol", number: "Forbidden", partyId: c.party },
      ],
      [
        "POST",
        "/traceability/lots",
        {
          productId: c.product,
          tlc: "Forbidden",
          assignmentBasis: "imported",
          source: { kind: "location", locationId: c.location },
        },
      ],
      [
        "PATCH",
        `/traceability/lots/${c.lot}/source`,
        {
          reason: "Forbidden source",
          expectedRevision: 1,
          source: { kind: "location", locationId: c.location },
        },
      ],
      [
        "POST",
        `/traceability/lots/${c.lot}/status`,
        { reason: "Forbidden QA", status: "hold", expectedRevision: 1 },
      ],
      ["POST", "/traceability/receiving", { operationKey: id, draft: emptyReceivingDraft }],
      [
        "PUT",
        `/traceability/receiving/${fixture.receiving.id}`,
        { operationKey: id, expectedDraftVersion: 1, draft: emptyReceivingDraft },
      ],
      ...["finalize", "amend", "void"].map((action): [string, string, unknown] => [
        "POST",
        `/traceability/receiving/${fixture.receiving.id}/${action}`,
        {
          commandVersion: 2,
          operationKey: id,
          expectedLifecycleVersion: 1,
          expectedDraftVersion: 1,
          reason: "Forbidden",
        },
      ]),
      ["POST", "/traceability/receiving/imports/preview", csvRequest([csvRow(c.product)])],
      [
        "POST",
        `/traceability/receiving/imports/${id}/apply`,
        { operationKey: id, previewDigest: "a".repeat(64) },
      ],
      [
        "POST",
        "/traceability/transformation",
        { operationKey: id, draft: fixture.transformationDraft },
      ],
      [
        "PUT",
        `/traceability/transformation/${fixture.transformation.id}`,
        { operationKey: id, expectedDraftVersion: 1, draft: fixture.transformationDraft },
      ],
      ...["finalize", "amend", "void"].map((action): [string, string, unknown] => [
        "POST",
        `/traceability/transformation/${fixture.transformation.id}/${action}`,
        {},
      ]),
      ["POST", "/traceability/shipments", { operationKey: id, draft: fixture.shippingDraft }],
      [
        "PUT",
        `/traceability/shipments/${fixture.shipping.id}`,
        { operationKey: id, expectedDraftVersion: 1, draft: fixture.shippingDraft },
      ],
      ...["finalize", "amend", "void"].map((action): [string, string, unknown] => [
        "POST",
        `/traceability/shipments/${fixture.shipping.id}/${action}`,
        {},
      ]),
      [
        "POST",
        `/traceability/lots/${c.lot}/cases`,
        { operationKey: id, ssccs: ["012345670000000015"] },
      ],
      [
        "POST",
        `/traceability/lots/${c.lot}/cases/${id}/unlink`,
        { operationKey: id, reason: "Forbidden" },
      ],
      ["POST", "/traceability/plans", {}, "traceability.plan.draft_created"],
      ["PUT", `/traceability/plans/${p}`, {}, "traceability.plan.draft_updated"],
      ["POST", `/traceability/plans/${p}/validate`, { expectedRevision: 1, confirmations }],
      [
        "POST",
        `/traceability/plans/${p}/approve`,
        { expectedRevision: 1, confirmations, idempotencyKey: id },
        "traceability.plan.approved",
      ],
      ["POST", `/traceability/plans/${p}/discard`, {}, "traceability.plan.draft_discarded"],
      ["POST", "/traceability/requests", {}, "traceability.request.created"],
      ["PATCH", `/traceability/requests/${r}`, {}, "traceability.request.updated"],
      ...[
        ["close", "closed"],
        ["validate", "validated"],
        ["acknowledge-warnings", "warnings_acknowledged"],
        ["prepare", "prepared"],
      ].map(([action, suffix]): [string, string, unknown, string] => [
        "POST",
        `/traceability/requests/${r}/${action}`,
        {},
        `traceability.request.${suffix}`,
      ]),
      ["POST", `/traceability/export-runs/${run}/retry`, {}, "traceability.request.worker.retried"],
    ];
    const provider = fixture.providerSnapshot();
    for (const [method, path, body, action] of rows) {
      const response = await request(path, method, body);
      const result: unknown = await response.json();
      expect(response.status, `${method} ${path} ${JSON.stringify(result)}`).toBe(403);
      if (action)
        expectedAudits.push(
          audit(
            response,
            action,
            path.includes("export-runs")
              ? "trace_export_run"
              : path.includes("plans")
                ? "traceability_plan_version"
                : "trace_request",
            path === "/traceability/plans" || path === "/traceability/requests"
              ? null
              : path.includes("export-runs")
                ? run
                : path.includes("plans")
                  ? p
                  : r,
            "rejected",
            { code: "insufficient_permission" },
          ),
        );
    }
    console.info(
      `[viewer-http-denials] ${rows.length} registered business mutation attempts403; expected audit inserts ${expectedAudits.length}`,
    );
    await auditDelta(expectedAudits);
    expect(fixture.providerSnapshot()).toEqual(provider);
    expect(await fixture.authSnapshot()).toEqual(auth);
    await unchanged();
  }, 30000);

  it("keeps unsupported DELETE/member/settings namespaces closed", async () => {
    for (const [method, path] of [
      ["DELETE", `/traceability/lots/${fixture.context.lot}`],
      ["DELETE", `/traceability/requests/${fixture.source.request.id}`],
      ["PATCH", "/traceability/settings"],
      ["POST", "/traceability/members"],
      ["POST", "/api/us-auth/organization/update-member-role"],
      ["POST", "/api/us-auth/organization/update"],
      ["POST", "/api/us-auth/organization/invite-member"],
      ["POST", "/api/us-auth/organization/remove-member"],
    ]) {
      if (!method || !path) throw new Error("Invalid route matrix");
      expect((await request(path, method, {})).status, `${method} ${path}`).toBe(404);
    }
    await auditDelta([]);
    await unchanged();
  });

  it("denies anonymous, device and API-key-only access at both read and release boundaries", async () => {
    const provider = fixture.providerSnapshot();
    for (const headers of [
      {},
      {
        "x-api-key": "synthetic-device-key",
        authorization: "Bearer synthetic-device-token",
        "x-device-id": randomUUID(),
      },
    ]) {
      for (const path of [
        "/traceability/access",
        "/traceability/events",
        "/traceability/requests",
        `/traceability/plans/${fixture.plan.id}/pdf`,
        `/traceability/export-runs/${fixture.source.run.id}/artifacts/package_zip`,
      ])
        expect((await fixture.request(path, "GET", undefined, null, headers)).status).toBe(401);
      expect(
        (await fixture.request("/traceability/requests", "POST", {}, null, headers)).status,
      ).toBe(401);
    }
    expect(fixture.providerSnapshot()).toEqual(provider);
    await auditDelta([]);
    await unchanged();
  });

  it("rejects foreign tenant selection and existing foreign IDs without leaking private identities", async () => {
    expect((await fixture.viewer.select(fixture.foreign.tenant)).status).toBe(403);
    expect((await fixture.viewer.select()).status).toBe(200);
    auth = await fixture.authSnapshot();
    const ids = [
      `/traceability/lots/${fixture.foreign.lot}`,
      `/traceability/lots/${fixture.foreign.lot}/card`,
      `/traceability/lots/${fixture.foreign.lot}/trace`,
      `/traceability/lots/${fixture.foreign.lot}/cases`,
      `/traceability/readiness?lotId=${fixture.foreign.lot}`,
      `/traceability/parties/${fixture.foreign.party}`,
      `/traceability/locations/${fixture.foreign.location}`,
      `/traceability/catalog/products/${fixture.foreign.product}`,
      `/traceability/products/${fixture.foreign.product}`,
      `/traceability/reference-documents/${fixture.foreign.document}`,
      `/traceability/plans/${fixture.foreignPlan.id}`,
      `/traceability/requests/${fixture.foreignRequest.id}`,
      `/traceability/export-runs/${fixture.foreignRunId}`,
      `/traceability/export-runs/${fixture.foreignRunId}/artifacts/package_zip`,
    ];
    for (const path of ids) {
      const response = await request(path);
      expect(response.status, path).toBe(404);
      const body = await response.text();
      expect(body).not.toContain(fixture.foreign.tenant);
      expect(body).not.toContain(fixture.foreign.actor);
    }
    expect((await request(`/traceability/export-runs/${randomUUID()}`)).status).toBe(404);
    expect(
      (await request(`/traceability/export-runs/${randomUUID()}/artifacts/package_zip`)).status,
    ).toBe(404);
    await auditDelta([]);
    await unchanged();
  });

  it("requires fresh MFA after real logout and rejects trusted-device shortcuts", async () => {
    const oldCookie = fixture.viewer.client.headers().get("cookie") ?? "";
    expect((await fixture.viewer.signOut()).status).toBe(200);
    await authCounts(0, 0, 0);
    expect(
      (await fixture.request("/traceability/access", "GET", undefined, null, { cookie: oldCookie }))
        .status,
    ).toBe(401);
    expect((await fixture.viewer.signIn()).status).toBe(200);
    // Pinned plugin persists the pending challenge plus its bounded attempt counter.
    await authCounts(0, 2, 0);
    expect((await request("/traceability/access")).status).toBe(401);
    expect((await fixture.viewer.select()).status).toBe(403);
    await verifyRespectingLimiter();
    expect((await fixture.viewer.select()).status).toBe(200);
    expect((await request("/traceability/access")).status).toBe(200);
    await authCounts(1, 0, 1);
    auth = await fixture.authSnapshot();
    await auditDelta([]);
    await unchanged();
  }, 20000);

  it("reloads current membership and refuses revoked read/export authority", async () => {
    const members = schema.member;
    await fixture.database.db
      .update(members)
      .set({ role: "" })
      .where(
        and(eq(members.userId, fixture.viewerUserId), eq(members.organizationId, fixture.tenantId)),
      );
    const afterRevocation = await fixture.businessSnapshot();
    const provider = fixture.providerSnapshot();
    try {
      expect((await request("/traceability/events")).status).toBe(403);
      expect(
        (await request(`/traceability/export-runs/${fixture.source.run.id}/artifacts/package_zip`))
          .status,
      ).toBe(403);
      expect(await fixture.businessSnapshot()).toEqual(afterRevocation);
      expect(fixture.privateSnapshot()).toEqual(privateBytes);
      expect(fixture.providerSnapshot()).toEqual(provider);
      await auditDelta([]);
    } finally {
      await fixture.database.db
        .update(members)
        .set({ role: "traceability_auditor" })
        .where(
          and(
            eq(members.userId, fixture.viewerUserId),
            eq(members.organizationId, fixture.tenantId),
          ),
        );
    }
    await unchanged();
  });

  it("refuses removed assurance, expired session and revoked factor without successful-session injection", async () => {
    const provider = fixture.providerSnapshot();
    await fixture.database.db.delete(schema.usSessionAssurances);
    await authCounts(1, 0, 0);
    expect((await request("/traceability/events")).status).toBe(403);
    expect((await fixture.viewer.select()).status).toBe(403);
    await fixture.viewer.signOut();
    expect((await fixture.viewer.signIn()).status).toBe(200);
    await verifyRespectingLimiter();
    expect((await fixture.viewer.select()).status).toBe(200);
    await fixture.database.db
      .update(schema.session)
      .set({ expiresAt: new Date(0) })
      .where(eq(schema.session.userId, fixture.viewerUserId));
    expect((await request("/traceability/events")).status).toBe(401);
    expect((await fixture.viewer.signIn()).status).toBe(200);
    await verifyRespectingLimiter();
    expect((await fixture.viewer.select()).status).toBe(200);
    await fixture.database.db
      .update(schema.usTwoFactors)
      .set({ verified: false })
      .where(eq(schema.usTwoFactors.userId, fixture.viewerUserId));
    expect((await request("/traceability/events")).status).toBe(403);
    expect(
      (await request(`/traceability/export-runs/${fixture.source.run.id}/artifacts/package_zip`))
        .status,
    ).toBe(403);
    expect((await fixture.viewer.select()).status).toBe(403);
    expect(fixture.providerSnapshot()).toEqual(provider);
    await authCounts(1, 0, 1);
    await auditDelta([]);
    await unchanged();
  }, 30000);

  it("accounts for every actual registered business route rather than a handpicked subset", () => {
    const document = SwaggerModule.createDocument(fixture.app, new DocumentBuilder().build());
    const operations = Object.entries(document.paths)
      .filter(([path]) => path.startsWith("/traceability/"))
      .flatMap(([path, methods]) =>
        Object.keys(methods).map(
          (method) => `${method.toUpperCase()} ${path.replace(/\{[^}]+\}/g, "{id}")}`,
        ),
      );
    expect(operations.filter((operation) => !covered.has(operation))).toEqual([]);
    console.info(
      `[viewer-http-route-coverage] ${operations.length} actual registered business operations exercised`,
    );
  });
  it("pins the entire viewing interval to six package GETs and one Plan GET", () => {
    assertCompleteViewerProviderInterval(providerBaseline, fixture.providerSnapshot());
  });
});
