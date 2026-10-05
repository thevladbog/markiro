import { createHash, randomUUID } from "node:crypto";
import { schema } from "@markiro/db";
import {
  buildUsPlanSnapshot,
  buildUsPlanDraftFactSources,
  buildUsPlanApprovedEvidence,
  canonicalExportDigest,
  type UsPlanSections,
} from "@markiro/domain";
import * as domain from "@markiro/domain";
import type { UsTraceRequestScopeV1 } from "@markiro/platform-contracts";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { UsRequestStore } from "../src/modules/traceability/requests/us-request-store";
import { UsRequestValidationStore } from "../src/modules/traceability/requests/us-request-validation";
import { captureUsRequestTenantOrigin } from "../src/modules/traceability/requests/us-request-tenant-origin";
import {
  captureUsRequestScope,
  stableStringify,
} from "../src/modules/traceability/requests/us-request-snapshot";
import { transformationTransaction } from "../src/modules/traceability/transformation/us-transformation-operations";
import { UsReceivingStore } from "../src/modules/traceability/receiving/us-receiving-store";
import { createUsProfileTestDatabase } from "./support/us-profile-database";
import { seedCompleteReceiving } from "./support/us-receiving-fixture";
import { readUsPlanConfiguration } from "../src/modules/traceability/plans/us-plan-configuration";
import { seedTwoByTwoGenealogy } from "./support/us-transformation-genealogy-fixture";

const url = process.env.US_TEST_DATABASE_URL;
const build = { apiVersion: "test-us09", gitSha: "a".repeat(40), dirty: false } as const;

describe.skipIf(!url)("US request validation in disposable PostgreSQL", () => {
  let f: Awaited<ReturnType<typeof createUsProfileTestDatabase>>;
  let c: Awaited<ReturnType<typeof seedCompleteReceiving>>;
  let requests: UsRequestStore;
  let validation: UsRequestValidationStore;
  beforeAll(async () => {
    if (!url) throw new Error("Missing isolated US database URL");
    f = await createUsProfileTestDatabase(url);
    requests = new UsRequestStore(f.db);
    validation = new UsRequestValidationStore(f.db);
  }, 60_000);
  afterAll(async () => {
    await f?.close();
  });
  beforeEach(async () => {
    c = await seedCompleteReceiving(f.db);
  });
  const create = (scope: UsTraceRequestScopeV1 = { lotId: c.lot }) =>
    requests.create(c.tenant, c.actor, {
      requestNumber: randomUUID(),
      requesterName: "Synthetic requester",
      requesterOrganization: "Synthetic QA",
      requesterContact: "private@example.test",
      receivedAt: "2026-10-04T00:00:00Z",
      scope,
    });
  const read = async (id: string) => {
    const [row] = await f.db
      .select()
      .from(schema.traceRequests)
      .where(eq(schema.traceRequests.id, id));
    if (!row) throw new Error("Missing request fixture");
    return row;
  };
  const capture = async (id: string, stamp = build) =>
    transformationTransaction(f.db, async (tx) =>
      captureUsRequestScope(
        tx,
        c.tenant,
        c.actor,
        await read(id),
        stamp,
        await captureUsRequestTenantOrigin(f.db, tx, c.tenant),
      ),
    );
  const auditRows = (tenantId = c.tenant) =>
    f.db
      .select()
      .from(schema.tenantAuditEvents)
      .where(eq(schema.tenantAuditEvents.organizationId, tenantId))
      .orderBy(schema.tenantAuditEvents.id);
  const audit = (
    action: string,
    targetId: string,
    outcome: string,
    before: unknown,
    after: unknown,
    tenantId = c.tenant,
    actorUserId = c.actor,
  ) => ({
    id: expect.any(String),
    createdAt: expect.any(Date),
    organizationId: tenantId,
    actorUserId,
    action,
    outcome,
    targetType: "trace_request",
    targetId,
    before,
    after,
    requestId: null,
  });
  const expectAuditDelta = async (
    previous: Awaited<ReturnType<typeof auditRows>>,
    expected: unknown[],
    tenantId = c.tenant,
  ) => {
    const current = await auditRows(tenantId);
    const previousIds = new Set(previous.map((entry) => entry.id));
    expect(current.filter((entry) => previousIds.has(entry.id))).toEqual(previous);
    const added = current.filter((entry) => !previousIds.has(entry.id));
    expect(added).toEqual(expected);
    return added;
  };

  it("persists exact zero-match and absent Plan findings with reproducible bytes and digest", async () => {
    const row = await create({ lotId: randomUUID() });
    const beforeFirst = await auditRows();
    const first = await validation.validate(c.tenant, c.actor, row.id, build);
    await expectAuditDelta(beforeFirst, [
      audit(
        "traceability.request.validated",
        row.id,
        "success",
        { revision: 1, digest: null, warningAckDigest: null },
        {
          revision: 1,
          digest: first.digest,
          warningAckDigest: null,
          matchedRevisionCount: 0,
          findingCodes: ["no_matches", "plan_absent"],
        },
      ),
    ]);
    const beforeSecond = await auditRows();
    const second = await validation.validate(c.tenant, c.actor, row.id, build);
    const accepted = await expectAuditDelta(beforeSecond, [
      audit(
        "traceability.request.validated",
        row.id,
        "success",
        { revision: 1, digest: first.digest, warningAckDigest: null },
        {
          revision: 1,
          digest: first.digest,
          warningAckDigest: null,
          matchedRevisionCount: 0,
          findingCodes: ["no_matches", "plan_absent"],
        },
      ),
    ]);
    expect(JSON.stringify(accepted)).not.toContain(row.requesterContact);
    expect(JSON.stringify(accepted)).not.toContain(row.requestNumber);
    expect(first.digest).toMatch(/^[a-f0-9]{64}$/);
    expect(second.digest).toBe(first.digest);
    expect(first.matchedRevisionCount).toBe(0);
    expect(first.findings.map((finding) => finding.code)).toEqual(
      expect.arrayContaining(["no_matches", "plan_absent"]),
    );
    const captured = await capture(row.id);
    const bytes = stableStringify(captured.snapshot);
    expect(captured.byteSize).toBe(Buffer.byteLength(bytes, "utf8"));
    expect(captured.digest).toBe(createHash("sha256").update(bytes).digest("hex"));
    expect(await read(row.id)).toMatchObject({ revision: 1, lastValidationDigest: first.digest });
  });

  it("changes the digest for live lot, product, coverage, source, requester, timezone and build facts", async () => {
    const row = await create();
    let prior = (await capture(row.id)).digest;
    for (const change of [
      () =>
        f.db
          .update(schema.traceabilityLots)
          .set({ tlc: "UPDATED" })
          .where(eq(schema.traceabilityLots.id, c.lot)),
      () =>
        f.db
          .update(schema.products)
          .set({ name: "Changed description" })
          .where(eq(schema.products.id, c.product)),
      () =>
        f.db
          .update(schema.productTraceabilityProfiles)
          .set({ coverageStatus: "covered" })
          .where(eq(schema.productTraceabilityProfiles.productId, c.product)),
      () =>
        f.db
          .update(schema.traceabilityLocations)
          .set({ businessName: "Changed source" })
          .where(eq(schema.traceabilityLocations.id, c.location)),
      () =>
        f.db
          .update(schema.traceRequests)
          .set({ requesterContact: "changed@example.test" })
          .where(eq(schema.traceRequests.id, row.id)),
      () =>
        f.db
          .update(schema.orgProfiles)
          .set({ timeZone: "America/New_York" })
          .where(eq(schema.orgProfiles.tenantId, c.tenant)),
    ]) {
      await change();
      const next = (await capture(row.id)).digest;
      expect(next).not.toBe(prior);
      prior = next;
    }
    const changed = await transformationTransaction(f.db, async (tx) =>
      captureUsRequestScope(
        tx,
        c.tenant,
        c.actor,
        await read(row.id),
        {
          ...build,
          gitSha: "b".repeat(40),
        },
        await captureUsRequestTenantOrigin(f.db, tx, c.tenant),
      ),
    );
    expect(changed.digest).not.toBe(prior);
  });

  it("includes saved source content and genealogy and preserves source array order", async () => {
    const store = new UsReceivingStore(f.db);
    const event = await store.createDraft(
      c.tenant,
      c.actor,
      { operationKey: randomUUID(), draft: c.draft },
      "validation-fixture",
    );
    const row = await create();
    const before = await capture(row.id);
    expect(before.snapshot.sources.map((source) => source.eventId)).toContain(event.id);
    expect(before.snapshot.selection.relations).toEqual(
      expect.arrayContaining([expect.objectContaining({ eventId: event.id, lotId: c.lot })]),
    );
    await store.saveDraft(
      c.tenant,
      c.actor,
      event.id,
      {
        operationKey: randomUUID(),
        expectedDraftVersion: 1,
        draft: { ...c.draft, notes: "Changed saved content" },
      },
      "validation-fixture-save",
    );
    expect((await capture(row.id)).digest).not.toBe(before.digest);
  });

  it("sorts set-valued scopes and physical row ordering without sorting saved source arrays", async () => {
    const row = await create({ tlcs: ["00001", "OTHER"] });
    const first = await capture(row.id);
    await f.db
      .update(schema.traceRequests)
      .set({ scope: { tlcs: ["OTHER", "00001"] } })
      .where(eq(schema.traceRequests.id, row.id));
    expect((await capture(row.id)).digest).toBe(first.digest);
    // Rewriting the same rows changes heap ordering, not captured facts.
    await f.pool.query("UPDATE traceability_lots SET tlc=tlc WHERE tenant_id=$1", [c.tenant]);
    expect((await capture(row.id)).digest).toBe(first.digest);
  });

  it("captures exact genealogy edges and fails closed when a retained edge disappears", async () => {
    const g = await seedTwoByTwoGenealogy(f);
    const row = await requests.create(g.tenant, g.actor, {
      requestNumber: randomUUID(),
      requesterName: "Synthetic QA",
      requesterOrganization: null,
      requesterContact: null,
      receivedAt: "2026-10-04T00:00:00Z",
      scope: { tlc: "NEW-OUTPUT" },
    });
    const captureGraph = () =>
      transformationTransaction(f.db, async (tx) =>
        captureUsRequestScope(
          tx,
          g.tenant,
          g.actor,
          row,
          build,
          await captureUsRequestTenantOrigin(f.db, tx, g.tenant),
        ),
      );
    const first = await captureGraph();
    expect(first.snapshot.genealogy).toHaveLength(8);
    const downstream = await g.store.createDraft(
      g.tenant,
      g.actor,
      {
        operationKey: randomUUID(),
        draft: {
          ...g.saved.draft,
          inputs: g.revision.snapshot.outputs.map((output) => ({
            kind: "ftl_lot",
            lotId: output.lotId,
            quantity: "1",
            unitOfMeasure: "case",
          })),
          outputs: [
            { productId: g.product, tlc: "DOWNSTREAM", quantity: "2", unitOfMeasure: "case" },
          ],
        },
      },
      "validation-downstream",
    );
    const ready = await g.store.checkReadiness(g.tenant, g.actor, downstream.id, {
      expectedDraftVersion: 1,
    });
    await g.store.finalize(
      g.tenant,
      g.actor,
      downstream.id,
      {
        operationKey: randomUUID(),
        expectedDraftVersion: 1,
        expectedInputDigest: ready.inputDigest,
      },
      "validation-downstream-finalize",
    );
    const expanded = await captureGraph();
    expect(expanded.snapshot.genealogy).toHaveLength(10);
    expect(expanded.digest).not.toBe(first.digest);
    const stored = await validation.validate(g.tenant, g.actor, row.id, build);
    await f.pool.query("ALTER TABLE lot_genealogy_edges DISABLE TRIGGER ALL");
    try {
      const edge = expanded.snapshot.genealogy.find((edge) => edge.eventId === g.original.id);
      if (!edge) throw new Error("Missing synthetic edge");
      await f.pool.query(
        "UPDATE lot_genealogy_edges SET input_lot_id=$4 WHERE tenant_id=$1 AND event_id=$2 AND input_lot_id=$3",
        [g.tenant, g.original.id, edge.inputLotId, c.lot],
      );
      await expect(validation.validate(g.tenant, g.actor, row.id, build)).rejects.toMatchObject({
        status: 503,
      });
      await f.pool.query(
        "UPDATE lot_genealogy_edges SET input_lot_id=$4 WHERE tenant_id=$1 AND event_id=$2 AND input_lot_id=$3",
        [g.tenant, g.original.id, c.lot, edge.inputLotId],
      );
      await f.pool.query(
        "DELETE FROM lot_genealogy_edges WHERE tenant_id=$1 AND event_id=$2 AND input_lot_id=(SELECT min(input_lot_id::text)::uuid FROM lot_genealogy_edges WHERE tenant_id=$1 AND event_id=$2)",
        [g.tenant, g.original.id],
      );
      await expect(validation.validate(g.tenant, g.actor, row.id, build)).rejects.toMatchObject({
        status: 503,
      });
      expect((await read(row.id)).lastValidationDigest).toBe(stored.digest);
    } finally {
      await f.pool.query("ALTER TABLE lot_genealogy_edges ENABLE TRIGGER ALL");
    }
  });

  it("includes registry and persisted baseline stamps while excluding caller and validation times", async () => {
    const row = await create();
    const first = await capture(row.id);
    const hash = vi.spyOn(domain, "traceExportRegistryHash").mockReturnValue("b".repeat(64));
    try {
      expect((await capture(row.id)).digest).not.toBe(first.digest);
    } finally {
      hash.mockRestore();
    }
    await f.pool.query("ALTER TABLE traceability_profiles DISABLE TRIGGER USER");
    try {
      await f.db
        .update(schema.traceabilityProfiles)
        .set({ baselineVersion: "US-REG-FUTURE-TEST" })
        .where(eq(schema.traceabilityProfiles.tenantId, c.tenant));
      expect((await capture(row.id)).digest).not.toBe(first.digest);
    } finally {
      await f.pool.query("ALTER TABLE traceability_profiles ENABLE TRIGGER USER");
    }
    const serialized = stableStringify(first.snapshot);
    expect(serialized).not.toContain("generatedAt");
    expect(serialized).not.toContain("warningAck");
    expect(serialized).not.toContain("idempotencyKey");
  });

  it("binds warning acknowledgement to the exact digest, preserves semantic revision and detects later drift", async () => {
    const row = await create();
    const first = await validation.validate(c.tenant, c.actor, row.id, build);
    // US-07 currently emits error/info findings. Seed a valid stored warning to
    // exercise the persistence seam without inventing a new product warning rule.
    await f.db
      .update(schema.traceRequests)
      .set({
        lastValidation: {
          matchedRevisionCount: 0,
          findings: [
            ...first.findings,
            {
              code: "synthetic_warning",
              severity: "warning",
              sourceRecord: `request:${row.id}`,
              message: "Synthetic reviewed warning",
            },
          ],
        },
      })
      .where(eq(schema.traceRequests.id, row.id));
    const beforeStale = await auditRows();
    await expect(
      validation.acknowledgeWarnings(c.tenant, c.actor, row.id, "f".repeat(64), "Reviewed warning"),
    ).rejects.toMatchObject({ status: 409, response: { code: "us_request_validation_stale" } });
    const staleAudit = await expectAuditDelta(beforeStale, [
      audit("traceability.request.warnings_acknowledged", row.id, "conflict", null, {
        code: "us_request_validation_stale",
        revision: 1,
        digest: first.digest,
        warningAckDigest: null,
      }),
    ]);
    expect(JSON.stringify(staleAudit)).not.toContain("Reviewed warning");
    expect(JSON.stringify(staleAudit)).not.toContain(row.requesterContact);
    expect(JSON.stringify(staleAudit)).not.toContain(row.requestNumber);
    const ack = await validation.acknowledgeWarnings(
      c.tenant,
      c.actor,
      row.id,
      first.digest,
      "Reviewed warning",
    );
    expect(ack).toMatchObject({ revision: 1, digest: first.digest, acknowledgedBy: c.actor });
    expect((await capture(row.id)).digest).toBe(first.digest);
    await f.db
      .update(schema.products)
      .set({ name: "Changed after acknowledgement" })
      .where(eq(schema.products.id, c.product));
    expect((await capture(row.id)).digest).not.toBe((await read(row.id)).warningAckDigest);
    await validation.validate(c.tenant, c.actor, row.id, build);
    expect(await read(row.id)).toMatchObject({
      revision: 1,
      warningAckDigest: null,
      warningAckReason: null,
      warningAckAt: null,
      warningAckBy: null,
    });
    const audits = await f.db
      .select()
      .from(schema.tenantAuditEvents)
      .where(eq(schema.tenantAuditEvents.organizationId, c.tenant));
    expect(audits).toContainEqual({
      id: expect.any(String),
      createdAt: expect.any(Date),
      organizationId: c.tenant,
      actorUserId: c.actor,
      action: "traceability.request.warnings_acknowledged",
      outcome: "success",
      targetType: "trace_request",
      targetId: row.id,
      before: { revision: 1, digest: first.digest, warningAckDigest: null },
      after: { revision: 1, digest: first.digest, warningAckDigest: first.digest },
      requestId: null,
    });
    expect(JSON.stringify(audits)).not.toContain("private@example.test");
    expect(JSON.stringify(audits)).not.toContain("Reviewed warning");
  });

  it("rejects acknowledgement when persisted scope is corrupt and leaves its previous validation intact", async () => {
    const row = await create();
    const first = await validation.validate(c.tenant, c.actor, row.id, build);
    await f.db
      .update(schema.traceRequests)
      .set({
        scope: {},
        lastValidation: {
          matchedRevisionCount: 0,
          findings: [
            {
              code: "synthetic_warning",
              severity: "warning",
              sourceRecord: `request:${row.id}`,
              message: "Synthetic warning",
            },
          ],
        },
      })
      .where(eq(schema.traceRequests.id, row.id));
    const prior = await read(row.id);
    await expect(
      validation.acknowledgeWarnings(c.tenant, c.actor, row.id, first.digest, "Reviewed warning"),
    ).rejects.toMatchObject({ status: 503 });
    expect(await read(row.id)).toEqual(prior);
  });

  it("keeps the digest stable across authorized callers and repeated validation times", async () => {
    const row = await create();
    const first = await validation.validate(c.tenant, c.actor, row.id, build);
    const actor = randomUUID();
    await f.db
      .insert(schema.user)
      .values({ id: actor, name: "Second synthetic QA", email: `${actor}@example.test` });
    await f.db.insert(schema.member).values({
      id: randomUUID(),
      organizationId: c.tenant,
      userId: actor,
      role: "traceability_qa",
      createdAt: new Date(),
    });
    const second = await validation.validate(c.tenant, actor, row.id, build);
    expect(second.digest).toBe(first.digest);
    expect(second.validatedAt).not.toBe(first.validatedAt);
  });

  it("canonicalizes historical timestamp facts independently of the connection timezone", async () => {
    const row = await create();
    const captureInZone = (zone: string) =>
      transformationTransaction(f.db, async (tx) => {
        await tx.execute(sql`SELECT set_config('TimeZone',${zone},true)`);
        return captureUsRequestScope(
          tx,
          c.tenant,
          c.actor,
          row,
          build,
          await captureUsRequestTenantOrigin(f.db, tx, c.tenant),
        );
      });
    expect((await captureInZone("UTC")).digest).toBe(
      (await captureInZone("America/Los_Angeles")).digest,
    );
  });

  it("pins the parsed effective Plan identity/hash and rejects corrupt evidence preserving validation", async () => {
    const row = await create();
    const missing = await capture(row.id);
    const sections: UsPlanSections = {
      recordMaintenance: {
        systemOfRecord: "Synthetic register",
        formats: ["PDF"],
        recordLocations: ["QA"],
        responsibleRoles: ["QA"],
        backupAndRecovery: "Synthetic procedure",
        narrative: [],
      },
      ftlIdentification: { procedure: "Review FTL", reviewCadence: "On change" },
      tlcAssignment: { procedure: "Assign" },
      pointOfContact: { name: "Synthetic QA", title: "QA", phone: "+1 555 0100", email: null },
      farmActivity: { status: "no", explanation: "No farming" },
      reviewAndUpdate: { procedure: "Review changes" },
    };
    const facts = await transformationTransaction(f.db, (tx) =>
      readUsPlanConfiguration(tx, c.tenant),
    );
    const snapshot = buildUsPlanSnapshot(facts.facts, sections, "operational");
    const approvedAt = new Date("2026-10-04T00:00:00.000Z");
    const evidence = buildUsPlanApprovedEvidence(
      snapshot,
      buildUsPlanDraftFactSources(facts.facts, sections),
      {
        kind: "operational",
        actorId: c.actor,
        confirmedAt: approvedAt.toISOString(),
        confirmations: {
          procedures: true,
          backupAndRecovery: true,
          contact: true,
          nonFarmScope: true,
        },
      },
    );
    const id = randomUUID();
    await f.db.insert(schema.traceabilityPlanVersions).values({
      id,
      tenantId: c.tenant,
      versionNumber: 1,
      status: "effective",
      sections,
      createdBy: c.actor,
      approvedBy: c.actor,
      approvedAt,
      configSnapshot: snapshot,
      configDigest: canonicalExportDigest(snapshot),
      approvedEvidence: evidence,
      idempotencyKeyHash: "b".repeat(64),
      approvalRequestDigest: "c".repeat(64),
      pdfObjectKey: `us/plans/${c.tenant}/${id}/${randomUUID()}.pdf`,
      pdfSha256: "d".repeat(64),
      pdfByteSize: 100,
      rendererVersion: "us-plan-pdf-v2",
    });
    const effective = await capture(row.id);
    expect(effective.snapshot.plan).toEqual({ id, pdfSha256: "d".repeat(64) });
    expect(effective.digest).not.toBe(missing.digest);
    await validation.validate(c.tenant, c.actor, row.id, build);
    const prior = await read(row.id);
    await f.pool.query("ALTER TABLE traceability_plan_versions DISABLE TRIGGER USER");
    try {
      await f.db
        .update(schema.traceabilityPlanVersions)
        .set({ pdfSha256: "e".repeat(64) })
        .where(eq(schema.traceabilityPlanVersions.id, id));
      expect((await capture(row.id)).digest).not.toBe(effective.digest);
      const newId = randomUUID();
      await f.db
        .update(schema.traceabilityPlanVersions)
        .set({ id: newId, pdfObjectKey: `us/plans/${c.tenant}/${newId}/${randomUUID()}.pdf` })
        .where(eq(schema.traceabilityPlanVersions.id, id));
      const moved = await capture(row.id);
      expect(moved.snapshot.plan?.id).toBe(newId);
      await f.db
        .update(schema.traceabilityPlanVersions)
        .set({ configSnapshot: { corrupt: true } })
        .where(eq(schema.traceabilityPlanVersions.id, newId));
      await expect(validation.validate(c.tenant, c.actor, row.id, build)).rejects.toMatchObject({
        status: 503,
        response: { code: "us_plan_stored_published_invalid" },
      });
      expect(await read(row.id)).toEqual(prior);
    } finally {
      await f.pool.query("ALTER TABLE traceability_plan_versions ENABLE TRIGGER USER");
    }
  });

  it("measures the entire UTF-8 snapshot and reports the exact 16 MiB boundary", async () => {
    const row = await create();
    await f.db.update(schema.products).set({ name: "" }).where(eq(schema.products.id, c.product));
    const base = await capture(row.id);
    const size = 16 * 1024 * 1024;
    await f.db
      .update(schema.products)
      .set({ name: "x".repeat(size - base.byteSize) })
      .where(eq(schema.products.id, c.product));
    const exact = await capture(row.id);
    expect(exact.byteSize).toBe(size);
    expect(exact.snapshot.findings.some((finding) => finding.code === "snapshot_limit")).toBe(
      false,
    );
    await f.db
      .update(schema.products)
      .set({ name: "x".repeat(size - base.byteSize) + "ä" })
      .where(eq(schema.products.id, c.product));
    const overflow = await capture(row.id);
    expect(overflow.byteSize).toBeGreaterThan(size + 2);
    expect(overflow.snapshot.findings).toContainEqual(
      expect.objectContaining({ code: "snapshot_limit", severity: "error" }),
    );
    expect(overflow.digest).toBe(
      createHash("sha256").update(stableStringify(overflow.snapshot)).digest("hex"),
    );
  }, 30_000);

  it("rejects error-only acknowledgements and wrong tenant IDs, reloads mutation permission", async () => {
    const row = await create({ lotId: randomUUID() });
    const result = await validation.validate(c.tenant, c.actor, row.id, build);
    const beforeErrorOnly = await auditRows();
    await expect(
      validation.acknowledgeWarnings(
        c.tenant,
        c.actor,
        row.id,
        result.digest,
        "Reviewed missing evidence",
      ),
    ).rejects.toMatchObject({ status: 409, response: { code: "us_request_warnings_required" } });
    const errorOnlyAudit = await expectAuditDelta(beforeErrorOnly, [
      audit("traceability.request.warnings_acknowledged", row.id, "conflict", null, {
        code: "us_request_warnings_required",
        revision: 1,
        digest: result.digest,
        warningAckDigest: null,
      }),
    ]);
    const other = await seedCompleteReceiving(f.db);
    const beforeForeign = await auditRows(other.tenant);
    await expect(
      validation.validate(other.tenant, other.actor, row.id, build),
    ).rejects.toMatchObject({ status: 404, response: { code: "us_request_not_found" } });
    const foreignAudit = await expectAuditDelta(
      beforeForeign,
      [
        audit(
          "traceability.request.validated",
          row.id,
          "rejected",
          null,
          { code: "us_request_not_found" },
          other.tenant,
          other.actor,
        ),
      ],
      other.tenant,
    );
    await f.db
      .update(schema.member)
      .set({ role: "traceability_auditor" })
      .where(eq(schema.member.id, c.member));
    const beforeRevoked = await auditRows();
    await expect(validation.validate(c.tenant, c.actor, row.id, build)).rejects.toMatchObject({
      status: 403,
      response: { code: "insufficient_permission" },
    });
    const revokedAudit = await expectAuditDelta(beforeRevoked, [
      audit("traceability.request.validated", row.id, "rejected", null, {
        code: "insufficient_permission",
      }),
    ]);
    for (const entries of [errorOnlyAudit, foreignAudit, revokedAudit]) {
      const serialized = JSON.stringify(entries);
      for (const privateValue of [
        row.requestNumber,
        row.requesterName,
        row.requesterOrganization,
        row.requesterContact,
        row.receivedAt.toISOString(),
        row.dueAt.toISOString(),
        "Reviewed missing evidence",
      ]) {
        if (privateValue !== null) expect(serialized).not.toContain(privateValue);
      }
      expect(serialized).not.toContain('"scope"');
    }
    // A denied actor has no authority to discover the request's validation state.
    for (const entries of [foreignAudit, revokedAudit]) {
      expect(JSON.stringify(entries)).not.toContain(result.digest);
      expect(JSON.stringify(entries)).not.toContain('"revision"');
      expect(JSON.stringify(entries)).not.toContain('"findingCodes"');
    }
    expect((await read(row.id)).lastValidationDigest).toBe(result.digest);
  });

  it("rolls back failed validation and audit together without replacing prior evidence", async () => {
    const row = await create();
    await validation.validate(c.tenant, c.actor, row.id, build);
    const prior = await read(row.id);
    const priorAudits = await auditRows();
    await f.pool.query(
      "CREATE FUNCTION reject_validation_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='traceability.request.validated' THEN RAISE EXCEPTION 'synthetic serialization failure' USING ERRCODE='40001'; END IF; RETURN NEW; END $$",
    );
    await f.pool.query(
      "CREATE TRIGGER reject_validation_audit BEFORE INSERT ON tenant_audit_events FOR EACH ROW EXECUTE FUNCTION reject_validation_audit()",
    );
    try {
      await expect(validation.validate(c.tenant, c.actor, row.id, build)).rejects.toMatchObject({
        status: 503,
      });
      expect(await read(row.id)).toEqual(prior);
      await expectAuditDelta(priorAudits, []);
    } finally {
      await f.pool.query("DROP TRIGGER reject_validation_audit ON tenant_audit_events");
      await f.pool.query("DROP FUNCTION reject_validation_audit()");
    }
  });
});

describe("canonical request serialization", () => {
  it("sorts keys losslessly but preserves saved array order and rejects non-JSON values", () => {
    expect(stableStringify({ z: ["02", "1"], a: { b: "ä", a: null } })).toBe(
      '{"a":{"a":null,"b":"ä"},"z":["02","1"]}',
    );
    for (const invalid of [undefined, NaN, new Date(), { a: undefined }, Array(1)])
      expect(() => stableStringify(invalid)).toThrow();
  });
});
