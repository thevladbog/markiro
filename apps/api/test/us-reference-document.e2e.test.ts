import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { schema } from "@markiro/db";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { UsReferenceDocumentStore } from "../src/modules/traceability/documents/us-reference-document-store";
import { createUsProfileTestDatabase } from "./support/us-profile-database";

const url = process.env.US_TEST_DATABASE_URL;
describe.skipIf(!url)("US reference document store", () => {
  let fixture: Awaited<ReturnType<typeof createUsProfileTestDatabase>>;
  let store: UsReferenceDocumentStore;
  let tenant: string, actor: string, member: string, party: string;
  beforeAll(async () => {
    if (!url) throw new Error("Missing isolated US database");
    fixture = await createUsProfileTestDatabase(url);
    store = new UsReferenceDocumentStore(fixture.db);
  }, 60_000);
  afterAll(async () => {
    await fixture?.close();
  });
  beforeEach(async () => {
    tenant = randomUUID();
    actor = randomUUID();
    member = randomUUID();
    party = randomUUID();
    await fixture.db
      .insert(schema.organization)
      .values({ id: tenant, name: "Synthetic US", slug: tenant, createdAt: new Date() });
    await fixture.db
      .insert(schema.user)
      .values({ id: actor, name: "Synthetic actor", email: `${actor}@example.test` });
    await fixture.db.insert(schema.member).values({
      id: member,
      organizationId: tenant,
      userId: actor,
      role: "owner",
      createdAt: new Date(),
    });
    await fixture.db.insert(schema.traceabilityProfiles).values({
      tenantId: tenant,
      code: "US_FSMA204_PROCESSOR",
      baselineVersion: "US-REG-2026-09-03",
      retentionYears: 5,
      effectiveAt: new Date(),
      updatedByUserId: actor,
    });
    await fixture.db
      .insert(schema.orgProfiles)
      .values({ tenantId: tenant, timeZone: "America/Chicago" });
    await fixture.db
      .insert(schema.traceabilityParties)
      .values({ id: party, tenantId: tenant, name: "Synthetic issuer" });
  });
  const input = (number = "=0001") => ({
    type: "bol",
    typeOtherLabel: null,
    number,
    partyId: party,
    issuedOn: "2026-09-14",
    notes: "Line one\nLine two",
  });
  const audits = () =>
    fixture.db
      .select()
      .from(schema.tenantAuditEvents)
      .where(eq(schema.tenantAuditEvents.organizationId, tenant));
  const setRole = (role: string) =>
    fixture.db.update(schema.member).set({ role }).where(eq(schema.member.id, member));

  it("creates a lossless record and exact atomic audit", async () => {
    const saved = await store.createDocument(
      tenant,
      actor,
      { ...input(), number: "  =0001  " },
      "server-request",
    );
    expect(saved).toEqual({
      ...input(),
      id: expect.any(String),
      archivedAt: null,
      createdBy: actor,
      createdAt: expect.any(String),
      updatedAt: expect.any(String),
    });
    expect(await store.getDocument(tenant, actor, saved.id)).toEqual(saved);
    expect(await audits()).toEqual([
      expect.objectContaining({
        organizationId: tenant,
        actorUserId: actor,
        action: "traceability.reference_document.created",
        outcome: "success",
        targetType: "traceability_reference_document",
        targetId: saved.id,
        before: null,
        after: saved,
        requestId: "server-request",
      }),
    ]);
    expect(
      await new UsReferenceDocumentStore(fixture.db).getDocument(tenant, actor, saved.id),
    ).toEqual(saved);
  });
  it.each([
    "owner",
    "admin",
    "manager",
    "traceability_receiving",
    "traceability_production",
    "traceability_shipping",
    "traceability_qa",
  ])("permits document creation for %s", async (role) => {
    await setRole(role);
    const saved = await store.createDocument(tenant, actor, input(), "create");
    expect((await store.listDocuments(tenant, actor, {})).items).toEqual([saved]);
  });
  it("reloads capability state for creation and reads", async () => {
    const saved = await store.createDocument(tenant, actor, input(), "create");
    await setRole("traceability_auditor");
    expect(await store.getDocument(tenant, actor, saved.id)).toEqual(saved);
    await expect(store.createDocument(tenant, actor, input("NO"), "deny")).rejects.toMatchObject({
      status: 403,
    });
    for (const role of ["member", "unknown", ""]) {
      await setRole(role);
      await expect(store.listDocuments(tenant, actor, {})).rejects.toMatchObject({ status: 403 });
      await expect(store.createDocument(tenant, actor, input("NO"), "deny")).rejects.toMatchObject({
        status: 403,
      });
    }
    await fixture.db.delete(schema.member).where(eq(schema.member.id, member));
    await expect(store.getDocument(tenant, actor, saved.id)).rejects.toMatchObject({ status: 403 });
    expect(await audits()).toHaveLength(1);
  });
  it("fails closed without a valid US profile", async () => {
    await fixture.db
      .update(schema.traceabilityProfiles)
      .set({ baselineVersion: "unsupported" })
      .where(eq(schema.traceabilityProfiles.tenantId, tenant));
    await expect(store.createDocument(tenant, actor, input(), "bad-profile")).rejects.toMatchObject(
      { status: 503 },
    );
    await fixture.db
      .delete(schema.traceabilityProfiles)
      .where(eq(schema.traceabilityProfiles.tenantId, tenant));
    await expect(store.listDocuments(tenant, actor, {})).rejects.toMatchObject({ status: 403 });
    expect(await audits()).toEqual([]);
  });
  it("denies foreign, absent and archived issuers without writing", async () => {
    const foreign = randomUUID(),
      foreignParty = randomUUID();
    await fixture.db
      .insert(schema.organization)
      .values({ id: foreign, name: "Foreign", slug: foreign, createdAt: new Date() });
    await fixture.db
      .insert(schema.traceabilityParties)
      .values({ id: foreignParty, tenantId: foreign, name: "Foreign" });
    await fixture.db
      .update(schema.traceabilityParties)
      .set({ archived: true })
      .where(eq(schema.traceabilityParties.id, party));
    for (const partyId of [foreignParty, randomUUID(), party])
      await expect(
        store.createDocument(tenant, actor, { ...input(), partyId }, "deny"),
      ).rejects.toMatchObject({ status: 404, response: { code: "party_not_found" } });
    expect(await audits()).toEqual([]);
  });
  it("does not leak foreign documents through detail or filtered list", async () => {
    const foreign = randomUUID();
    await fixture.db
      .insert(schema.organization)
      .values({ id: foreign, name: "Foreign", slug: foreign, createdAt: new Date() });
    const [row] = await fixture.db
      .insert(schema.referenceDocuments)
      .values({ tenantId: foreign, type: "bol", number: "FOREIGN", createdBy: "historical" })
      .returning();
    await expect(store.getDocument(tenant, actor, row?.id)).rejects.toMatchObject({ status: 404 });
    expect((await store.listDocuments(tenant, actor, { search: "FOREIGN" })).items).toEqual([]);
    expect(await audits()).toEqual([]);
  });
  it("rejects invalid store inputs before PostgreSQL can rewrite or reject them", async () => {
    for (const patch of [
      { tenantId: "forged" },
      { createdBy: "forged" },
      { notes: "x\u0000y" },
      { notes: "\ud800" },
      { issuedOn: "2026-02-29" },
      { number: "x\n" },
      { partyId: "bad" },
    ])
      await expect(
        store.createDocument(tenant, actor, { ...input(), ...patch }, "invalid"),
      ).rejects.toMatchObject({ status: 400 });
    await expect(store.getDocument(tenant, actor, "bad")).rejects.toMatchObject({ status: 400 });
    await expect(store.listDocuments(tenant, actor, { tenantId: "forged" })).rejects.toMatchObject({
      status: 400,
    });
    for (const search of ["x\u0000y", "x\ud800y", "x\udfffy"])
      await expect(store.listDocuments(tenant, actor, { search })).rejects.toMatchObject({
        status: 400,
        response: { code: "invalid_master_data" },
      });
    expect(await audits()).toEqual([]);
  });
  it.each([true, false])(
    "prevents concurrent duplicates with issuer present=%s",
    async (withParty) => {
      const body = { ...input(), partyId: withParty ? party : null };
      const results = await Promise.allSettled([
        store.createDocument(tenant, actor, body, "one"),
        store.createDocument(tenant, actor, body, "two"),
      ]);
      expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      expect(results.find((result) => result.status === "rejected")).toMatchObject({
        reason: { status: 409, response: { code: "document_duplicate" } },
      });
      await expect(store.createDocument(tenant, actor, body, "retry")).rejects.toMatchObject({
        status: 409,
      });
      expect(await audits()).toHaveLength(1);
    },
  );
  it("escapes search metacharacters, filters and paginates without exposing archived metadata by default", async () => {
    const exact = await store.createDocument(tenant, actor, input("100%_\\"), "one");
    await store.createDocument(
      tenant,
      actor,
      { ...input("100wide"), type: "asn", partyId: null },
      "two",
    );
    expect((await store.listDocuments(tenant, actor, { search: "%_\\" })).items).toEqual([exact]);
    expect(
      (await store.listDocuments(tenant, actor, { type: "bol", partyId: party })).items,
    ).toEqual([exact]);
    const page = await store.listDocuments(tenant, actor, { limit: "1", offset: "1" });
    expect(page).toMatchObject({
      items: [expect.objectContaining({ number: "100wide" })],
      limit: 1,
      offset: 1,
    });
    await fixture.db
      .update(schema.referenceDocuments)
      .set({ archivedAt: new Date() })
      .where(eq(schema.referenceDocuments.id, exact.id));
    expect((await store.listDocuments(tenant, actor, { type: "bol" })).items).toEqual([]);
    expect(
      (await store.listDocuments(tenant, actor, { archived: "true" })).items.map((item) => item.id),
    ).toEqual([exact.id]);
    expect((await store.listDocuments(tenant, actor, { archived: "all" })).items).toHaveLength(2);
    await expect(
      store.createDocument(tenant, actor, input("100%_\\"), "repeat"),
    ).rejects.toMatchObject({ status: 409 });
  });
  it("rolls back creation when audit insertion fails", async () => {
    await fixture.pool.query(
      "CREATE FUNCTION reject_reference_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action = 'traceability.reference_document.created' THEN RAISE EXCEPTION 'synthetic audit failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER reject_reference_audit BEFORE INSERT ON tenant_audit_events FOR EACH ROW EXECUTE FUNCTION reject_reference_audit()",
    );
    try {
      await expect(store.createDocument(tenant, actor, input(), "rollback")).rejects.toThrow();
      expect((await store.listDocuments(tenant, actor, {})).items).toEqual([]);
      expect(await audits()).toEqual([]);
    } finally {
      await fixture.pool.query(
        "DROP TRIGGER reject_reference_audit ON tenant_audit_events; DROP FUNCTION reject_reference_audit()",
      );
    }
  });
  it("fails closed without returning invalid stored document content", async () => {
    const [row] = await fixture.db
      .insert(schema.referenceDocuments)
      .values({ tenantId: tenant, type: "bol", number: "🍎".repeat(65), createdBy: "historical" })
      .returning();
    await expect(store.getDocument(tenant, actor, row?.id)).rejects.toMatchObject({
      status: 503,
      response: { code: "us_database_unavailable" },
    });
    await expect(store.listDocuments(tenant, actor, {})).rejects.toMatchObject({
      status: 503,
      response: { code: "us_database_unavailable" },
    });
  });
});
