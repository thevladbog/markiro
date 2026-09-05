import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { schema } from "@markiro/db";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { UsMasterDataStore } from "../src/modules/traceability/master-data/us-master-data-store";
import { createUsProfileTestDatabase } from "./support/us-profile-database";

const url = process.env.US_TEST_DATABASE_URL;

describe.skipIf(!url)("US master-data store with real isolated PostgreSQL", () => {
  let fixture: Awaited<ReturnType<typeof createUsProfileTestDatabase>>;
  let store: UsMasterDataStore;
  let tenantId: string;
  let actorUserId: string;
  let memberId: string;
  let clock = Date.now();

  beforeAll(async () => {
    if (!url) throw new Error("Missing isolated test database");
    fixture = await createUsProfileTestDatabase(url);
    store = new UsMasterDataStore(fixture.db);
    vi.useFakeTimers({ toFake: ["Date"] });
  }, 60_000);

  afterAll(async () => {
    vi.useRealTimers();
    await fixture?.close();
  });

  beforeEach(async () => {
    clock += 60_000;
    vi.setSystemTime(clock);
    tenantId = randomUUID();
    actorUserId = randomUUID();
    memberId = randomUUID();
    await fixture.db
      .insert(schema.organization)
      .values({ id: tenantId, name: "Synthetic US", slug: tenantId, createdAt: new Date() });
    await fixture.db
      .insert(schema.user)
      .values({ id: actorUserId, name: "Synthetic owner", email: `${actorUserId}@example.test` });
    await fixture.db.insert(schema.member).values({
      id: memberId,
      organizationId: tenantId,
      userId: actorUserId,
      role: "owner",
      createdAt: new Date(),
    });
    await fixture.db.insert(schema.traceabilityProfiles).values({
      tenantId,
      code: "US_FSMA204_PROCESSOR",
      baselineVersion: "US-REG-2026-09-03",
      retentionYears: 5,
      effectiveAt: new Date(),
      updatedByUserId: actorUserId,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await fixture.db
      .insert(schema.orgProfiles)
      .values({ tenantId, timeZone: "America/Chicago", updatedAt: new Date() });
  });

  it("creates and reads tenant-scoped parties and draft locations with server-owned fields", async () => {
    const party = await store.createParty(
      tenantId,
      actorUserId,
      { name: "  Synthetic Foods  ", legalName: "Synthetic Foods LLC" },
      "party-create",
    );
    expect(party).toEqual({
      id: expect.any(String),
      name: "Synthetic Foods",
      legalName: "Synthetic Foods LLC",
      contactName: null,
      contactPhone: null,
      contactEmail: null,
      notes: null,
      archived: false,
      createdAt: new Date(clock).toISOString(),
      updatedAt: new Date(clock).toISOString(),
    });
    expect(await store.getParty(tenantId, actorUserId, party.id)).toEqual(party);
    expect(await store.listParties(tenantId, actorUserId, {})).toEqual({
      items: [party],
      limit: 50,
      offset: 0,
    });

    const location = await store.createLocation(
      tenantId,
      actorUserId,
      { partyId: party.id, name: "Dock", businessName: "Synthetic Dock" },
      "location-create",
    );
    expect(location).toMatchObject({
      id: expect.any(String),
      partyId: party.id,
      name: "Dock",
      businessName: "Synthetic Dock",
      phoneNumber: null,
      addressKind: "street",
      streetAddress: null,
      latitude: null,
      longitude: null,
      city: null,
      stateOrRegion: null,
      zipOrPostalCode: null,
      countryCode: null,
      roles: [],
      archived: false,
      descriptionStatus: { exportReady: false, issues: expect.any(Array) },
    });
    expect(location.descriptionStatus.issues).toContainEqual({
      field: "phoneNumber",
      code: "required",
    });
    expect(await store.getLocation(tenantId, actorUserId, location.id)).toEqual(location);
    expect(await store.listLocations(tenantId, actorUserId, {})).toEqual({
      items: [location],
      limit: 50,
      offset: 0,
    });

    const audits = await fixture.db
      .select()
      .from(schema.tenantAuditEvents)
      .where(eq(schema.tenantAuditEvents.organizationId, tenantId));
    expect(audits.map(({ action, requestId }) => ({ action, requestId }))).toEqual([
      { action: "traceability.party.created", requestId: "party-create" },
      { action: "traceability.location.created", requestId: "location-create" },
    ]);
  });

  it.each(["US_FSMA204_PROCESSOR", "US_GENERIC_LOT_TRACEABILITY"] as const)(
    "preserves incomplete draft-location CRUD under %s",
    async (code) => {
      await fixture.db
        .update(schema.traceabilityProfiles)
        .set({ code })
        .where(eq(schema.traceabilityProfiles.tenantId, tenantId));
      const party = await store.createParty(
        tenantId,
        actorUserId,
        { name: `Draft party ${code}` },
        `draft-party-${code}`,
      );
      const created = await store.createLocation(
        tenantId,
        actorUserId,
        {
          partyId: party.id,
          name: "Draft receiving dock",
          businessName: "Synthetic Draft Dock",
        },
        `draft-location-${code}`,
      );
      expect(created).toMatchObject({
        partyId: party.id,
        phoneNumber: null,
        streetAddress: null,
        city: null,
        stateOrRegion: null,
        zipOrPostalCode: null,
        countryCode: null,
        descriptionStatus: { exportReady: false, issues: expect.any(Array) },
      });
      expect(await store.getLocation(tenantId, actorUserId, created.id)).toEqual(created);

      clock += 60_000;
      vi.setSystemTime(clock);
      const updated = await store.updateLocation(
        tenantId,
        actorUserId,
        created.id,
        { city: "Chicago" },
        `draft-location-update-${code}`,
      );
      expect(updated).toMatchObject({
        city: "Chicago",
        phoneNumber: null,
        streetAddress: null,
        descriptionStatus: { exportReady: false, issues: expect.any(Array) },
      });
      expect(await store.getLocation(tenantId, actorUserId, created.id)).toEqual(updated);
    },
  );

  it("revalidates strict input, current membership permissions and the persisted US profile", async () => {
    await expect(
      store.createParty(
        tenantId,
        actorUserId,
        { name: "Forged", tenantId: randomUUID() },
        "forged",
      ),
    ).rejects.toMatchObject({ status: 400 });
    await expect(store.getParty(tenantId, actorUserId, "not-a-uuid")).rejects.toMatchObject({
      status: 400,
    });

    const party = await store.createParty(tenantId, actorUserId, { name: "Readable" }, "readable");
    await fixture.db
      .update(schema.member)
      .set({ role: "traceability_auditor" })
      .where(eq(schema.member.id, memberId));
    expect(await store.getParty(tenantId, actorUserId, party.id)).toEqual(party);
    await expect(
      store.createParty(tenantId, actorUserId, { name: "Blocked" }, "blocked"),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      store.updateParty(tenantId, actorUserId, party.id, { name: party.name }, "blocked-noop"),
    ).rejects.toMatchObject({ status: 403 });

    await fixture.db
      .update(schema.member)
      .set({ role: "member" })
      .where(eq(schema.member.id, memberId));
    await expect(store.listParties(tenantId, actorUserId, {})).rejects.toMatchObject({
      status: 403,
    });
    await fixture.db
      .update(schema.member)
      .set({ role: "owner" })
      .where(eq(schema.member.id, memberId));
    await fixture.db
      .update(schema.traceabilityProfiles)
      .set({ baselineVersion: "wrong" })
      .where(eq(schema.traceabilityProfiles.tenantId, tenantId));
    await expect(store.listParties(tenantId, actorUserId, {})).rejects.toMatchObject({
      status: 503,
      response: { code: "traceability_profile_invalid" },
    });
    await fixture.db
      .update(schema.traceabilityProfiles)
      .set({ code: "RU_CHZ", baselineVersion: null })
      .where(eq(schema.traceabilityProfiles.tenantId, tenantId));
    await expect(store.listParties(tenantId, actorUserId, {})).rejects.toMatchObject({
      status: 503,
      response: { code: "traceability_profile_invalid" },
    });
    await fixture.db
      .delete(schema.traceabilityProfiles)
      .where(eq(schema.traceabilityProfiles.tenantId, tenantId));
    await expect(store.listParties(tenantId, actorUserId, {})).rejects.toMatchObject({
      status: 403,
      response: { code: "traceability_profile_required" },
    });
    await fixture.db
      .update(schema.member)
      .set({ role: "traceability_auditor" })
      .where(eq(schema.member.id, memberId));
    await expect(store.listParties(tenantId, actorUserId, {})).rejects.toMatchObject({
      status: 403,
      response: { code: "traceability_profile_required" },
    });
  });

  it.each(["owner", "admin", "manager", "traceability_qa"])(
    "allows %s to write master data",
    async (role) => {
      await fixture.db.update(schema.member).set({ role }).where(eq(schema.member.id, memberId));
      expect(
        await store.createParty(tenantId, actorUserId, { name: `Allowed ${role}` }, role),
      ).toMatchObject({ name: `Allowed ${role}` });
    },
  );

  it.each([
    ["member", false],
    ["traceability_receiving", true],
    ["traceability_production", true],
    ["traceability_shipping", true],
    ["traceability_auditor", true],
    ["unknown", false],
  ] as const)(
    "denies %s from writing master data while preserving its read policy",
    async (role, canRead) => {
      await fixture.db.update(schema.member).set({ role }).where(eq(schema.member.id, memberId));
      await expect(
        store.createParty(tenantId, actorUserId, { name: `Denied ${role}` }, role),
      ).rejects.toMatchObject({ status: 403 });
      if (canRead)
        expect(await store.listParties(tenantId, actorUserId, {})).toMatchObject({ items: [] });
      else
        await expect(store.listParties(tenantId, actorUserId, {})).rejects.toMatchObject({
          status: 403,
        });
    },
  );

  it("merges party patches, preserves no-op timestamps, archives without cascade and maps only the active-name constraint", async () => {
    const party = await store.createParty(
      tenantId,
      actorUserId,
      { name: "Alpha", legalName: "Alpha Legal" },
      "alpha-create",
    );
    const location = await store.createLocation(
      tenantId,
      actorUserId,
      { partyId: party.id, name: "Alpha dock", businessName: "Alpha Dock" },
      "dock-create",
    );
    await expect(
      store.createParty(tenantId, actorUserId, { name: "ALPHA" }, "duplicate"),
    ).rejects.toMatchObject({ status: 409, response: { code: "party_name_taken" } });

    clock += 60_000;
    vi.setSystemTime(clock);
    const updated = await store.updateParty(
      tenantId,
      actorUserId,
      party.id,
      { legalName: null, notes: "partial" },
      "alpha-update",
    );
    expect(updated).toMatchObject({ name: "Alpha", legalName: null, notes: "partial" });
    expect(updated.updatedAt).not.toBe(party.updatedAt);
    clock += 60_000;
    vi.setSystemTime(clock);
    expect(
      await store.updateParty(
        tenantId,
        actorUserId,
        party.id,
        { legalName: null, notes: "partial" },
        "alpha-noop",
      ),
    ).toEqual(updated);

    const archived = await store.updateParty(
      tenantId,
      actorUserId,
      party.id,
      { archived: true },
      "alpha-archive",
    );
    expect(archived.archived).toBe(true);
    expect((await store.getLocation(tenantId, actorUserId, location.id)).archived).toBe(false);
    expect((await store.listParties(tenantId, actorUserId, {})).items).toEqual([]);
    expect((await store.getParty(tenantId, actorUserId, party.id)).archived).toBe(true);
    const replacement = await store.createParty(
      tenantId,
      actorUserId,
      { name: "alpha" },
      "replacement",
    );
    expect(replacement.archived).toBe(false);
    await expect(
      store.updateParty(
        tenantId,
        actorUserId,
        party.id,
        { archived: false },
        "alpha-restore-conflict",
      ),
    ).rejects.toMatchObject({ status: 409, response: { code: "party_name_taken" } });

    const actions = (
      await fixture.db
        .select({
          action: schema.tenantAuditEvents.action,
          requestId: schema.tenantAuditEvents.requestId,
        })
        .from(schema.tenantAuditEvents)
        .where(eq(schema.tenantAuditEvents.organizationId, tenantId))
    ).map((row) => `${row.action}:${row.requestId}`);
    expect(actions).not.toContain("traceability.party.updated:alpha-noop");
    expect(actions).toContain("traceability.party.updated:alpha-update");
    expect(actions).toContain("traceability.party.archived:alpha-archive");
  });

  it("hides foreign identifiers and prevents cross-tenant party links", async () => {
    const foreignTenantId = randomUUID();
    const foreignActorId = randomUUID();
    await fixture.db.insert(schema.organization).values({
      id: foreignTenantId,
      name: "Foreign tenant",
      slug: foreignTenantId,
      createdAt: new Date(),
    });
    await fixture.db.insert(schema.user).values({
      id: foreignActorId,
      name: "Foreign owner",
      email: `${foreignActorId}@example.test`,
    });
    await fixture.db.insert(schema.member).values({
      id: randomUUID(),
      organizationId: foreignTenantId,
      userId: foreignActorId,
      role: "owner",
      createdAt: new Date(),
    });
    await fixture.db.insert(schema.traceabilityProfiles).values({
      tenantId: foreignTenantId,
      code: "US_GENERIC_LOT_TRACEABILITY",
      baselineVersion: "US-REG-2026-09-03",
      retentionYears: 5,
      effectiveAt: new Date(),
      updatedByUserId: foreignActorId,
    });
    await fixture.db
      .insert(schema.orgProfiles)
      .values({ tenantId: foreignTenantId, timeZone: "America/New_York" });
    const foreignParty = await store.createParty(
      foreignTenantId,
      foreignActorId,
      { name: "Foreign" },
      "foreign-create",
    );
    await expect(store.getParty(tenantId, actorUserId, foreignParty.id)).rejects.toMatchObject({
      status: 404,
    });
    await expect(
      store.createLocation(
        tenantId,
        actorUserId,
        { partyId: foreignParty.id, name: "Forged", businessName: "Forged" },
        "foreign-link",
      ),
    ).rejects.toMatchObject({ status: 404 });
  });

  it("normalizes exact coordinate scale for no-op and permits only archive under an archived parent", async () => {
    const party = await store.createParty(
      tenantId,
      actorUserId,
      { name: "Coordinates" },
      "coordinates-party",
    );
    const location = await store.createLocation(
      tenantId,
      actorUserId,
      {
        partyId: party.id,
        name: "Coordinates dock",
        businessName: "Coordinate Dock",
        addressKind: "coordinates",
        latitude: "47.1",
        longitude: "-122.123456",
      },
      "coordinates-create",
    );
    expect(location.latitude).toBe("47.100000");
    clock += 60_000;
    vi.setSystemTime(clock);
    expect(
      await store.updateLocation(
        tenantId,
        actorUserId,
        location.id,
        { latitude: "47.1" },
        "coordinate-noop",
      ),
    ).toEqual(location);

    await store.updateParty(tenantId, actorUserId, party.id, { archived: true }, "parent-archive");
    const archived = await store.updateLocation(
      tenantId,
      actorUserId,
      location.id,
      { archived: true },
      "location-archive",
    );
    expect(archived.archived).toBe(true);
    expect(await store.getLocation(tenantId, actorUserId, location.id)).toEqual(archived);
    expect((await store.listLocations(tenantId, actorUserId, {})).items).toEqual([]);
    expect(
      await store.updateLocation(
        tenantId,
        actorUserId,
        location.id,
        { archived: true },
        "location-archive-retry",
      ),
    ).toEqual(archived);
    await expect(
      store.updateLocation(
        tenantId,
        actorUserId,
        location.id,
        { archived: true, name: "Bypass" },
        "mixed-archive",
      ),
    ).rejects.toMatchObject({ status: 403, response: { code: "party_archived" } });
    await expect(
      store.updateLocation(
        tenantId,
        actorUserId,
        location.id,
        { archived: false },
        "restore-under-archive",
      ),
    ).rejects.toMatchObject({ status: 403, response: { code: "party_archived" } });
    await expect(
      store.updateLocation(tenantId, actorUserId, location.id, { partyId: party.id }, "move-party"),
    ).rejects.toMatchObject({ status: 400 });

    const requests = (
      await fixture.db
        .select({ requestId: schema.tenantAuditEvents.requestId })
        .from(schema.tenantAuditEvents)
        .where(eq(schema.tenantAuditEvents.organizationId, tenantId))
    ).map((row) => row.requestId);
    expect(requests).not.toContain("coordinate-noop");
    expect(requests).not.toContain("location-archive-retry");
    expect(requests).not.toContain("mixed-archive");
    const [createAudit] = await fixture.db
      .select()
      .from(schema.tenantAuditEvents)
      .where(eq(schema.tenantAuditEvents.requestId, "coordinates-create"));
    expect(createAudit).toEqual({
      id: expect.any(String),
      organizationId: tenantId,
      actorUserId,
      action: "traceability.location.created",
      outcome: "success",
      targetType: "traceability_location",
      targetId: location.id,
      before: null,
      after: {
        id: location.id,
        partyId: party.id,
        name: "Coordinates dock",
        businessName: "Coordinate Dock",
        phoneNumber: null,
        addressKind: "coordinates",
        streetAddress: null,
        latitude: "47.100000",
        longitude: "-122.123456",
        city: null,
        stateOrRegion: null,
        zipOrPostalCode: null,
        countryCode: null,
        roles: [],
        archived: false,
        createdAt: location.createdAt,
        updatedAt: location.updatedAt,
      },
      requestId: "coordinates-create",
      createdAt: expect.any(Date),
    });
  });

  it("restores parties and locations under an active parent with exact lifecycle actions", async () => {
    const party = await store.createParty(
      tenantId,
      actorUserId,
      { name: "Restorable" },
      "restore-party-create",
    );
    const location = await store.createLocation(
      tenantId,
      actorUserId,
      { partyId: party.id, name: "Restorable dock", businessName: "Restorable Dock" },
      "restore-location-create",
    );
    await store.updateLocation(
      tenantId,
      actorUserId,
      location.id,
      { archived: true, name: "Archived dock" },
      "restore-location-archive",
    );
    expect(
      await store.updateLocation(
        tenantId,
        actorUserId,
        location.id,
        { archived: false },
        "restore-location-restore",
      ),
    ).toMatchObject({ archived: false, name: "Archived dock" });
    await store.updateParty(
      tenantId,
      actorUserId,
      party.id,
      { archived: true, notes: "archive wins" },
      "restore-party-archive",
    );
    expect(
      await store.updateParty(
        tenantId,
        actorUserId,
        party.id,
        { archived: false },
        "restore-party-restore",
      ),
    ).toMatchObject({ archived: false, notes: "archive wins" });
    const actions = await fixture.db
      .select({
        action: schema.tenantAuditEvents.action,
        requestId: schema.tenantAuditEvents.requestId,
      })
      .from(schema.tenantAuditEvents)
      .where(eq(schema.tenantAuditEvents.organizationId, tenantId));
    expect(actions).toEqual(
      expect.arrayContaining([
        {
          action: "traceability.location.archived",
          requestId: "restore-location-archive",
        },
        {
          action: "traceability.location.restored",
          requestId: "restore-location-restore",
        },
        { action: "traceability.party.archived", requestId: "restore-party-archive" },
        { action: "traceability.party.restored", requestId: "restore-party-restore" },
      ]),
    );
  });

  it("combines escaped search, archive, party, AND-role filters and stable bounded pagination", async () => {
    const percent = await store.createParty(
      tenantId,
      actorUserId,
      { name: "A%_\\ literal", legalName: "Needle Legal" },
      "percent",
    );
    const alpha = await store.createParty(
      tenantId,
      actorUserId,
      { name: "Alpha", legalName: "Other" },
      "alpha",
    );
    const beta = await store.createParty(
      tenantId,
      actorUserId,
      { name: "Beta", legalName: "Needle Holdings" },
      "beta",
    );
    await store.updateParty(tenantId, actorUserId, beta.id, { archived: true }, "beta-archive");
    expect((await store.listParties(tenantId, actorUserId, { search: "%_\\" })).items).toEqual([
      percent,
    ]);
    expect(
      (
        await store.listParties(tenantId, actorUserId, { search: "needle", archived: "all" })
      ).items.map((item) => item.id),
    ).toEqual([percent.id, beta.id]);
    expect(
      (await store.listParties(tenantId, actorUserId, { archived: "all", limit: "1", offset: "1" }))
        .items,
    ).toEqual([alpha]);

    const first = await store.createLocation(
      tenantId,
      actorUserId,
      {
        partyId: percent.id,
        name: "A%_\\ dock",
        businessName: "Needle Dock",
        roles: ["supplier", "processor"],
      },
      "first-location",
    );
    await store.createLocation(
      tenantId,
      actorUserId,
      { partyId: alpha.id, name: "Other", businessName: "Needle Other", roles: ["supplier"] },
      "second-location",
    );
    expect(
      (
        await store.listLocations(tenantId, actorUserId, {
          partyId: percent.id,
          search: "%_\\",
          roles: ["supplier", "processor"],
        })
      ).items,
    ).toEqual([first]);
    await store.updateLocation(
      tenantId,
      actorUserId,
      first.id,
      { archived: true },
      "first-location-archive",
    );
    expect(
      (
        await store.listLocations(tenantId, actorUserId, {
          partyId: percent.id,
          archived: "true",
          roles: "supplier",
        })
      ).items,
    ).toEqual([expect.objectContaining({ id: first.id, archived: true })]);
  });

  it("writes full safe audit snapshots atomically and rolls the entity back when audit insert fails", async () => {
    const party = await store.createParty(
      tenantId,
      actorUserId,
      { name: "Audited" },
      "audit-create",
    );
    const before = await store.getParty(tenantId, actorUserId, party.id);
    await fixture.pool.query(`
      ALTER TABLE tenant_audit_events
      ADD CONSTRAINT us_test_reject_party_update
      CHECK (request_id IS DISTINCT FROM 'forced-audit-failure')
    `);
    try {
      await expect(
        store.updateParty(
          tenantId,
          actorUserId,
          party.id,
          { legalName: "Must roll back" },
          "forced-audit-failure",
        ),
      ).rejects.toBeTruthy();
    } finally {
      await fixture.pool.query(`
        ALTER TABLE tenant_audit_events DROP CONSTRAINT us_test_reject_party_update
      `);
    }
    expect(await store.getParty(tenantId, actorUserId, party.id)).toEqual(before);

    clock += 60_000;
    vi.setSystemTime(clock);
    const after = await store.updateParty(
      tenantId,
      actorUserId,
      party.id,
      { legalName: "Committed" },
      "audit-success",
    );
    const [audit] = await fixture.db
      .select()
      .from(schema.tenantAuditEvents)
      .where(eq(schema.tenantAuditEvents.requestId, "audit-success"));
    expect(audit).toEqual({
      id: expect.any(String),
      organizationId: tenantId,
      actorUserId,
      action: "traceability.party.updated",
      outcome: "success",
      targetType: "traceability_party",
      targetId: party.id,
      before,
      after,
      requestId: "audit-success",
      createdAt: expect.any(Date),
    });
  });

  it("validates the fully merged party state before updating", async () => {
    const party = await store.createParty(
      tenantId,
      actorUserId,
      { name: "Initially valid" },
      "merge-validation-create",
    );
    await fixture.db
      .update(schema.traceabilityParties)
      .set({ name: "x".repeat(201) })
      .where(eq(schema.traceabilityParties.id, party.id));
    await expect(
      store.updateParty(
        tenantId,
        actorUserId,
        party.id,
        { notes: "must not mask invalid persisted state" },
        "merge-validation-update",
      ),
    ).rejects.toMatchObject({ status: 400 });
  });
});
