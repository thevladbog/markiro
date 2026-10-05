import { randomUUID } from "node:crypto";
import { schema } from "@markiro/db";
import type {
  UsTraceRequestCreateBody,
  UsTraceRequestUpdateBody,
} from "@markiro/platform-contracts";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { UsRequestStore } from "../src/modules/traceability/requests/us-request-store";
import { createUsProfileTestDatabase } from "./support/us-profile-database";
import { seedReceivingTenant } from "./support/us-receiving-fixture";

const url = process.env.US_TEST_DATABASE_URL;
const body: UsTraceRequestCreateBody = {
  requestNumber: "REQ-001",
  requesterName: "Synthetic requester",
  requesterOrganization: null,
  requesterContact: "private-contact@example.test",
  receivedAt: "2026-03-08T01:30:00-06:00",
  scope: null,
};
const cleared = {
  lastValidation: null,
  lastValidationDigest: null,
  lastValidatedAt: null,
  warningAckDigest: null,
  warningAckReason: null,
  warningAckAt: null,
  warningAckBy: null,
};

describe.skipIf(!url)("US request lifecycle in disposable PostgreSQL", () => {
  let fixture: Awaited<ReturnType<typeof createUsProfileTestDatabase>>;
  let store: UsRequestStore;
  let c: Awaited<ReturnType<typeof seedReceivingTenant>>;
  beforeAll(async () => {
    if (!url) throw new Error("Missing isolated US database URL");
    fixture = await createUsProfileTestDatabase(url);
    store = new UsRequestStore(fixture.db);
  }, 60_000);
  afterAll(async () => {
    await fixture?.close();
  });
  beforeEach(async () => {
    c = await seedReceivingTenant(fixture.db);
  });
  const create = (input = body) => store.create(c.tenant, c.actor, input);
  const read = async (id: string) => {
    const [row] = await fixture.db
      .select()
      .from(schema.traceRequests)
      .where(eq(schema.traceRequests.id, id));
    return row;
  };
  const audits = (tenant = c.tenant) =>
    fixture.db
      .select()
      .from(schema.tenantAuditEvents)
      .where(eq(schema.tenantAuditEvents.organizationId, tenant));
  const audit = (
    action: string,
    targetId: string | null,
    outcome: string,
    before: unknown,
    after: unknown,
    tenant = c.tenant,
    actor = c.actor,
  ) => ({
    id: expect.any(String),
    createdAt: expect.any(Date),
    organizationId: tenant,
    actorUserId: actor,
    action: `traceability.request.${action}`,
    outcome,
    targetType: "trace_request",
    targetId,
    before,
    after,
    requestId: null,
  });
  const validate = async (id: string) => {
    await fixture.db
      .update(schema.traceRequests)
      .set({
        lastValidation: { findings: [] },
        lastValidationDigest: "a".repeat(64),
        lastValidatedAt: new Date(),
        warningAckDigest: "a".repeat(64),
        warningAckReason: "Reviewed warnings",
        warningAckAt: new Date(),
        warningAckBy: c.actor,
      })
      .where(eq(schema.traceRequests.id, id));
  };

  it("creates a nullable shell with an elapsed 24h DST deadline and exact private-data-free audit", async () => {
    const row = await create();
    expect(row).toMatchObject({
      tenantId: c.tenant,
      createdBy: c.actor,
      revision: 1,
      status: "open",
      scope: null,
      closedAt: null,
      ...cleared,
    });
    expect(row.dueAt.getTime() - row.receivedAt.getTime()).toBe(86_400_000);
    expect(row.dueAt.toISOString()).toBe("2026-03-09T07:30:00.000Z");
    expect(await audits()).toEqual([
      audit("created", row.id, "success", null, {
        revision: 1,
        status: "open",
        lastValidationDigest: null,
      }),
    ]);
    expect(JSON.stringify(await audits())).not.toContain(body.requesterContact);
  });

  it("requires an alternative reason and audits its sanitized rejection", async () => {
    await expect(create({ ...body, dueAt: "2026-03-10T07:30:00Z" })).rejects.toMatchObject({
      status: 400,
      response: { code: "us_request_alternate_reason_required" },
    });
    expect(await audits()).toEqual([
      audit("created", null, "rejected", null, { code: "us_request_alternate_reason_required" }),
    ]);
    const row = await create({
      ...body,
      dueAt: "2026-03-10T07:30:00Z",
      alternateDeadlineReason: "Agreed extension",
    });
    expect(row.dueAt.toISOString()).toBe("2026-03-10T07:30:00.000Z");
    expect(row.alternateDeadlineReason).toBe("Agreed extension");
  });

  it("rejects forged identity fields, invalid IDs and sub-millisecond instants without leaking contact", async () => {
    const forged = { ...body, tenantId: c.tenant, actorUserId: c.actor };
    await expect(create(forged)).rejects.toMatchObject({ status: 400 });
    await expect(
      create({ ...body, receivedAt: "2026-03-08T07:30:00.0001Z" }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      store.close(c.tenant, c.actor, "invalid", { expectedRevision: 1 }),
    ).rejects.toMatchObject({ status: 400 });
    expect(JSON.stringify(await audits())).not.toContain(body.requesterContact);
    expect(
      await fixture.db
        .select()
        .from(schema.traceRequests)
        .where(eq(schema.traceRequests.tenantId, c.tenant)),
    ).toEqual([]);
  });

  it("serializes duplicate tenant numbers while permitting the same number in another tenant", async () => {
    const results = await Promise.allSettled([create(), create()]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.find((r) => r.status === "rejected")).toMatchObject({
      reason: { status: 409, response: { code: "us_request_number_conflict" } },
    });
    expect(await audits()).toContainEqual(
      audit("created", null, "conflict", null, { code: "us_request_number_conflict" }),
    );
    const other = await seedReceivingTenant(fixture.db);
    expect((await store.create(other.tenant, other.actor, body)).tenantId).toBe(other.tenant);
  });

  it("returns 404 for foreign IDs to an authorized tenant actor without discovering revisions", async () => {
    const row = await create();
    const other = await seedReceivingTenant(fixture.db);
    await expect(
      store.close(other.tenant, other.actor, row.id, { expectedRevision: 1 }),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      store.update(other.tenant, other.actor, row.id, {
        expectedRevision: 1,
        requesterName: "Changed",
      }),
    ).rejects.toMatchObject({ status: 404 });
    expect(await audits(other.tenant)).toEqual(
      expect.arrayContaining([
        audit(
          "closed",
          row.id,
          "rejected",
          null,
          { code: "us_request_not_found" },
          other.tenant,
          other.actor,
        ),
        audit(
          "updated",
          row.id,
          "rejected",
          null,
          { code: "us_request_not_found" },
          other.tenant,
          other.actor,
        ),
      ]),
    );
    expect(await read(row.id)).toEqual(row);
  });

  it("serializes concurrent revision edits and audits the stale conflict after rollback", async () => {
    const row = await create();
    const results = await Promise.allSettled(
      ["One", "Two"].map((requesterName) =>
        store.update(c.tenant, c.actor, row.id, { expectedRevision: 1, requesterName }),
      ),
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.find((r) => r.status === "rejected")).toMatchObject({
      reason: { status: 409, response: { code: "us_request_revision_conflict" } },
    });
    expect((await read(row.id))?.revision).toBe(2);
    expect(await audits()).toContainEqual(
      audit("updated", row.id, "conflict", null, {
        code: "us_request_revision_conflict",
        expectedRevision: 1,
        revision: 2,
        status: "open",
        lastValidationDigest: null,
      }),
    );
    expect(await audits()).toContainEqual(
      audit(
        "updated",
        row.id,
        "success",
        { revision: 1, status: "open", lastValidationDigest: null },
        { revision: 2, status: "open", lastValidationDigest: null },
      ),
    );
  });

  it.each<UsTraceRequestUpdateBody>([
    { expectedRevision: 1, scope: { tlc: "NEW" } },
    { expectedRevision: 1, requestNumber: "REQ-002" },
    { expectedRevision: 1, requesterName: "Updated" },
    { expectedRevision: 1, requesterOrganization: "Updated org" },
    { expectedRevision: 1, requesterContact: "changed@example.test" },
    {
      expectedRevision: 1,
      dueAt: "2026-03-10T07:30:00Z",
      alternateDeadlineReason: "Agreed extension",
    },
  ])(
    "invalidates validation and the whole acknowledgement atomically on edit %j",
    async (patch) => {
      const row = await create();
      await validate(row.id);
      const updated = await store.update(c.tenant, c.actor, row.id, patch);
      expect(updated).toMatchObject({ revision: 2, ...cleared });
      expect(await read(row.id)).toEqual(updated);
      expect(await audits()).toContainEqual(
        audit(
          "updated",
          row.id,
          "success",
          { revision: 1, status: "open", lastValidationDigest: "a".repeat(64) },
          { revision: 2, status: "open", lastValidationDigest: null },
        ),
      );
    },
  );

  it("preserves default deadline policy on receipt edits across DST and keeps explicit alternative instants", async () => {
    const row = await create();
    await validate(row.id);
    const updated = await store.update(c.tenant, c.actor, row.id, {
      expectedRevision: 1,
      receivedAt: "2026-03-08T03:30:00-05:00",
    });
    expect(updated).toMatchObject({ revision: 2, alternateDeadlineReason: null, ...cleared });
    expect(updated.dueAt.toISOString()).toBe("2026-03-09T08:30:00.000Z");
    const alternative = await store.update(c.tenant, c.actor, row.id, {
      expectedRevision: 2,
      dueAt: "2026-03-10T07:30:00Z",
      alternateDeadlineReason: "Agreed extension",
    });
    const moved = await store.update(c.tenant, c.actor, row.id, {
      expectedRevision: 3,
      receivedAt: "2026-03-08T09:30:00Z",
    });
    expect(moved.dueAt).toEqual(alternative.dueAt);
    expect(moved.alternateDeadlineReason).toBe("Agreed extension");
    await expect(
      store.update(c.tenant, c.actor, row.id, {
        expectedRevision: 4,
        receivedAt: "2026-03-11T09:30:00Z",
      }),
    ).rejects.toMatchObject({ response: { code: "us_request_deadline_order" } });
    expect(await read(row.id)).toEqual(moved);
  });

  it("preserves no-op validation, revision and audit but rejects a stale no-op", async () => {
    const row = await create();
    await validate(row.id);
    const prior = await read(row.id);
    const priorAudit = await audits();
    expect(
      await store.update(c.tenant, c.actor, row.id, {
        expectedRevision: 1,
        receivedAt: "2026-03-08T07:30:00.000000Z",
        scope: null,
      }),
    ).toEqual(prior);
    expect(await audits()).toEqual(priorAudit);
    await expect(
      store.update(c.tenant, c.actor, row.id, { expectedRevision: 2, scope: null }),
    ).rejects.toMatchObject({ status: 409 });
    expect(await read(row.id)).toEqual(prior);
  });

  it("closes and invalidates the request while preserving existing immutable runs", async () => {
    const row = await create();
    await validate(row.id);
    const [run] = await fixture.db
      .insert(schema.traceExportRuns)
      .values({
        tenantId: c.tenant,
        requestId: row.id,
        revision: 1,
        mode: "available_records_incomplete",
        status: "queued",
        createdBy: c.actor,
        idempotencyKey: randomUUID(),
        commandDigest: "b".repeat(64),
        scopedContentDigest: "a".repeat(64),
        inputSnapshot: { selectionKind: "empty" },
        startedAt: new Date(),
      })
      .returning();
    await expect(
      store.close(c.tenant, c.actor, row.id, { expectedRevision: 2 }),
    ).rejects.toMatchObject({ status: 409 });
    const closed = await store.close(c.tenant, c.actor, row.id, { expectedRevision: 1 });
    expect(closed).toMatchObject({
      revision: 2,
      status: "closed",
      closedAt: expect.any(Date),
      ...cleared,
    });
    expect(
      await fixture.db
        .select()
        .from(schema.traceExportRuns)
        .where(eq(schema.traceExportRuns.requestId, row.id)),
    ).toEqual([run]);
    expect(await audits()).toContainEqual(
      audit(
        "closed",
        row.id,
        "success",
        { revision: 1, status: "open", lastValidationDigest: "a".repeat(64) },
        { revision: 2, status: "closed", lastValidationDigest: null },
      ),
    );
    await expect(
      store.update(c.tenant, c.actor, row.id, { expectedRevision: 2, requesterName: "Changed" }),
    ).rejects.toMatchObject({ response: { code: "us_request_closed" } });
    await expect(
      store.close(c.tenant, c.actor, row.id, { expectedRevision: 2 }),
    ).rejects.toMatchObject({ response: { code: "us_request_closed" } });
    expect(await read(row.id)).toEqual(closed);
  });

  it("reloads membership for every mutation and denies non-processor profiles", async () => {
    const row = await create();
    await fixture.db
      .update(schema.member)
      .set({ role: "traceability_auditor" })
      .where(eq(schema.member.id, c.member));
    for (const command of [
      () => create(),
      () => store.update(c.tenant, c.actor, row.id, { expectedRevision: 1, scope: null }),
      () => store.close(c.tenant, c.actor, row.id, { expectedRevision: 1 }),
    ]) {
      await expect(command()).rejects.toMatchObject({
        status: 403,
        response: { code: "insufficient_permission" },
      });
    }
    expect(await audits()).toContainEqual(
      audit("closed", row.id, "rejected", null, { code: "insufficient_permission" }),
    );
    await fixture.db
      .update(schema.member)
      .set({ role: "owner" })
      .where(eq(schema.member.id, c.member));
    await fixture.pool.query("ALTER TABLE traceability_profiles DISABLE TRIGGER USER");
    try {
      await fixture.db
        .update(schema.traceabilityProfiles)
        .set({ code: "US_GENERIC_LOT_TRACEABILITY" })
        .where(eq(schema.traceabilityProfiles.tenantId, c.tenant));
    } finally {
      await fixture.pool.query("ALTER TABLE traceability_profiles ENABLE TRIGGER USER");
    }
    await expect(create()).rejects.toMatchObject({
      status: 403,
      response: { code: "us_request_profile_unsupported" },
    });
    expect(await read(row.id)).toEqual(row);
  });

  it("fails closed on corrupt stored scope without reclassifying it as input error", async () => {
    const row = await create();
    await fixture.db
      .update(schema.traceRequests)
      .set({ scope: {} })
      .where(eq(schema.traceRequests.id, row.id));
    await expect(
      store.close(c.tenant, c.actor, row.id, { expectedRevision: 1 }),
    ).rejects.toMatchObject({ status: 503, response: { code: "us_request_stored_invalid" } });
    expect((await read(row.id))?.revision).toBe(1);
  });

  it("rolls back all mutations when success audit storage fails, preserving validation and runs", async () => {
    const row = await create();
    await validate(row.id);
    const prior = await read(row.id);
    const priorAudit = await audits();
    await fixture.pool.query(
      "CREATE FUNCTION reject_request_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action LIKE 'traceability.request.%' THEN RAISE EXCEPTION 'synthetic infrastructure failure'; END IF; RETURN NEW; END $$",
    );
    await fixture.pool.query(
      "CREATE TRIGGER reject_request_audit BEFORE INSERT ON tenant_audit_events FOR EACH ROW EXECUTE FUNCTION reject_request_audit()",
    );
    try {
      await expect(create({ ...body, requestNumber: "REQ-NEW" })).rejects.toThrow();
      await expect(
        store.update(c.tenant, c.actor, row.id, { expectedRevision: 1, requesterName: "Changed" }),
      ).rejects.toThrow();
      await expect(
        store.close(c.tenant, c.actor, row.id, { expectedRevision: 1 }),
      ).rejects.toThrow();
      expect(await read(row.id)).toEqual(prior);
      expect(await audits()).toEqual(priorAudit);
      expect(
        await fixture.db
          .select()
          .from(schema.traceRequests)
          .where(eq(schema.traceRequests.tenantId, c.tenant)),
      ).toEqual([prior]);
    } finally {
      await fixture.pool.query("DROP TRIGGER reject_request_audit ON tenant_audit_events");
      await fixture.pool.query("DROP FUNCTION reject_request_audit()");
    }
  });
});
