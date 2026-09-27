import { createHash, randomUUID } from "node:crypto";
import { schema } from "@markiro/db";
import { decodeReceivingCsvExport } from "@markiro/platform-contracts";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { UsReceivingStore } from "../src/modules/traceability/receiving/us-receiving-store";
import { createUsProfileTestDatabase } from "./support/us-profile-database";
import { seedCompleteReceiving, seedReceivingTenant } from "./support/us-receiving-fixture";
import {
  createStoredAmendment,
  finalizeStoredAmendment,
} from "./support/us-receiving-lifecycle-storage";

const url = process.env.US_TEST_DATABASE_URL;
describe.skipIf(!url)("US saved Receiving CSV export", () => {
  let f: Awaited<ReturnType<typeof createUsProfileTestDatabase>>;
  let c: Awaited<ReturnType<typeof seedReceivingTenant>>;
  let store: UsReceivingStore;
  beforeAll(async () => {
    if (!url) throw new Error("Missing isolated US database");
    f = await createUsProfileTestDatabase(url);
    store = new UsReceivingStore(f.db);
  }, 60_000);
  afterAll(async () => {
    await f?.close();
  });
  beforeEach(async () => {
    c = await seedReceivingTenant(f.db);
  });
  const audits = () =>
    f.db
      .select()
      .from(schema.tenantAuditEvents)
      .where(
        and(
          eq(schema.tenantAuditEvents.organizationId, c.tenant),
          eq(schema.tenantAuditEvents.action, "traceability.receiving.csv_generated"),
        ),
      );
  const setRole = (role: string) =>
    f.db.update(schema.member).set({ role }).where(eq(schema.member.id, c.member));

  it("audits the exact selected bytes and permits the read-only auditor role", async () => {
    const saved = await store.createDraft(
      c.tenant,
      c.actor,
      {
        operationKey: randomUUID(),
        draft: {
          dateReceived: null,
          locationId: null,
          previousSourceLocationId: null,
          receivedAtNote: null,
          notes: "  Saved  ",
          items: [],
          documentIds: [],
        },
      },
      "create-request",
    );
    await setRole("traceability_auditor");
    const before = await store.getLiveRecord(c.tenant, c.actor, saved.id);
    const result = await store.exportCsv(
      c.tenant,
      c.actor,
      saved.id,
      { expectedDraftVersion: "1", expectedLifecycleVersion: "1" },
      "export-request",
    );
    const decoded = decodeReceivingCsvExport(result.bytes);
    expect(decoded.record).toEqual(before);
    expect(result.sha256).toBe(createHash("sha256").update(result.bytes).digest("hex"));
    expect(result.fileName).toMatch(/^markiro-receiving-[a-f0-9-]+-r1-d1-l1\.csv$/i);
    expect(await audits()).toMatchObject([
      {
        organizationId: c.tenant,
        actorUserId: c.actor,
        action: "traceability.receiving.csv_generated",
        outcome: "success",
        targetType: "traceability_event",
        targetId: saved.id,
        requestId: "export-request",
        after: {
          eventId: saved.id,
          revision: 1,
          draftVersion: 1,
          lifecycleVersion: 1,
          sha256: result.sha256,
          byteCount: result.bytes.byteLength,
          itemCount: 0,
          documentCount: 0,
        },
      },
    ]);
    expect(await store.getLiveRecord(c.tenant, c.actor, saved.id)).toEqual(before);
  });

  it("does not generate or audit bytes for a receiving-only user", async () => {
    const saved = await store.createDraft(
      c.tenant,
      c.actor,
      {
        operationKey: randomUUID(),
        draft: {
          dateReceived: null,
          locationId: null,
          previousSourceLocationId: null,
          receivedAtNote: null,
          notes: null,
          items: [],
          documentIds: [],
        },
      },
      "create-request",
    );
    await setRole("traceability_receiving");
    await expect(
      store.exportCsv(
        c.tenant,
        c.actor,
        saved.id,
        { expectedDraftVersion: "1", expectedLifecycleVersion: "1" },
        "denied-request",
      ),
    ).rejects.toMatchObject({ status: 403 });
    expect(await audits()).toHaveLength(0);
  });

  it("rejects stale versions and a foreign tenant without a generation audit", async () => {
    const saved = await store.createDraft(
      c.tenant,
      c.actor,
      {
        operationKey: randomUUID(),
        draft: {
          dateReceived: null,
          locationId: null,
          previousSourceLocationId: null,
          receivedAtNote: null,
          notes: null,
          items: [],
          documentIds: [],
        },
      },
      "create-request",
    );
    await expect(
      store.exportCsv(
        c.tenant,
        c.actor,
        saved.id,
        { expectedDraftVersion: "1", expectedLifecycleVersion: "2" },
        "stale-request",
      ),
    ).rejects.toMatchObject({ status: 409, response: { code: "receiving_export_stale" } });
    const foreign = await seedReceivingTenant(f.db);
    await expect(
      store.exportCsv(
        foreign.tenant,
        foreign.actor,
        saved.id,
        { expectedDraftVersion: "1", expectedLifecycleVersion: "1" },
        "foreign-request",
      ),
    ).rejects.toMatchObject({ status: 404 });
    expect(await audits()).toHaveLength(0);
  });

  it("returns no artifact when the generation audit cannot commit", async () => {
    const saved = await store.createDraft(
      c.tenant,
      c.actor,
      {
        operationKey: randomUUID(),
        draft: {
          dateReceived: null,
          locationId: null,
          previousSourceLocationId: null,
          receivedAtNote: null,
          notes: null,
          items: [],
          documentIds: [],
        },
      },
      "create-request",
    );
    await f.pool.query(`
      CREATE FUNCTION us_fail_csv_export_audit() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.action = 'traceability.receiving.csv_generated' THEN
          RAISE EXCEPTION 'synthetic audit failure';
        END IF;
        RETURN NEW;
      END $$
    `);
    await f.pool.query(`
      CREATE TRIGGER us_fail_csv_export_audit_trigger
      BEFORE INSERT ON tenant_audit_events
      FOR EACH ROW EXECUTE FUNCTION us_fail_csv_export_audit()
    `);
    try {
      await expect(
        store.exportCsv(
          c.tenant,
          c.actor,
          saved.id,
          { expectedDraftVersion: "1", expectedLifecycleVersion: "1" },
          "failed-audit-request",
        ),
      ).rejects.toBeDefined();
      expect(await audits()).toHaveLength(0);
    } finally {
      await f.pool.query("DROP TRIGGER us_fail_csv_export_audit_trigger ON tenant_audit_events");
      await f.pool.query("DROP FUNCTION us_fail_csv_export_audit()");
    }
  });

  it("exports the explicitly selected superseded revision, not its current successor", async () => {
    const complete = await seedCompleteReceiving(f.db, c);
    const saved = await store.createDraft(
      c.tenant,
      c.actor,
      { operationKey: randomUUID(), draft: complete.draft },
      "create-request",
    );
    const ready = await store.checkReadiness(c.tenant, c.actor, saved.id, {
      expectedDraftVersion: 1,
    });
    const original = await store.finalize(
      c.tenant,
      c.actor,
      saved.id,
      {
        operationKey: randomUUID(),
        expectedDraftVersion: 1,
        expectedInputDigest: ready.inputDigest,
      },
      "finalize-request",
    );
    const amendmentId = await createStoredAmendment(f, c.tenant, original.id);
    await finalizeStoredAmendment(f, c.tenant, amendmentId);
    const previous = await store.getLiveRecord(c.tenant, c.actor, original.id);
    const result = await store.exportCsv(
      c.tenant,
      c.actor,
      original.id,
      {
        expectedDraftVersion: String(previous.draftVersion),
        expectedLifecycleVersion: String(previous.lifecycle.lifecycleVersion),
      },
      "previous-request",
    );
    expect(decodeReceivingCsvExport(result.bytes).record).toEqual(previous);
    expect(previous.status).toBe("amended");
    expect(previous.lifecycle.currentEventId).toBe(amendmentId);
  });
});
