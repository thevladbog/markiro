import { createHash, randomUUID } from "node:crypto";
import {
  ConflictException,
  ForbiddenException,
  HttpException,
  NotFoundException,
} from "@nestjs/common";
import { createDb, schema } from "@markiro/db";
import { verifyStandaloneLicense } from "@markiro/domain";
import { eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { EntitlementsService } from "../src/subscriptions/entitlements.service";
import { PlatformAuditService } from "../src/platform-auth/platform-audit.service";
import { configureStandaloneLicenseSigning } from "../src/modules/standalone-licenses/standalone-license-keyset";
import { StandaloneLicenseIssuanceService } from "../src/modules/standalone-licenses/standalone-license-issuance.service";
import { StandaloneSitesService } from "../src/modules/standalone-licenses/standalone-sites.service";
import {
  createManagedSubscription,
  createOrganization,
  createPublishedAddon,
  createPublishedPlan,
} from "./support/subscription-fixtures";
import {
  activationRequest,
  auditRows,
  createTenantWithoutCabinet,
  platformActor,
  setTenantInns,
  signingEnv,
  STANDALONE_TEST_ISSUER,
} from "./support/standalone-license-fixture";

const DAY = 86_400_000;
const connection = createDb(process.env.DATABASE_URL ?? "postgres://invalid");
const db = connection.db;
const entitlements = new EntitlementsService(db, "managed_only");
const audit = new PlatformAuditService();
const signing = configureStandaloneLicenseSigning(signingEnv());
let clock = new Date();
const now = () => clock;
const sites = new StandaloneSitesService(db, audit, signing, now);
const issuance = new StandaloneLicenseIssuanceService(db, entitlements, audit, signing, now);
afterAll(() => connection.pool.end());

const NO_FEATURES = {
  labelEditor: false,
  publicApi: false,
  pallets: false,
  chzIntegration: false,
  inventory: false,
  commerceMl: false,
  handheld: false,
};
const UNMAPPED = (["chzIntegration", "inventory", "commerceMl", "handheld"] as const).map(
  (feature) => ({ code: "feature_unmapped" as const, feature }),
);

async function httpRefusal(promise: Promise<unknown>): Promise<{ status: number; body: unknown }> {
  const error = await promise.then(
    () => null,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(HttpException);
  return error instanceof HttpException
    ? { status: error.getStatus(), body: error.getResponse() }
    : { status: 0, body: null };
}

async function issuedRows(tenantId: string) {
  return db
    .select()
    .from(schema.standaloneLicenseIssuances)
    .where(eq(schema.standaloneLicenseIssuances.tenantId, tenantId));
}

/** A managed tenant with an organization INN and one registered site. */
async function siteFor(
  input: {
    status?: "trial" | "active";
    endsAt?: Date | null;
    org?: string | null;
    billing?: string;
    usage?: { stations: number; cabinetUsers: number; lines: number };
    managed?: boolean;
    tenantId?: string;
  } = {},
) {
  clock = new Date();
  const admin = await platformActor(db);
  const endsAt = input.endsAt === undefined ? new Date(clock.getTime() + 90 * DAY) : input.endsAt;
  const tenantId = await createOrganization(db, input.tenantId);
  const managed =
    input.managed === false
      ? { tenantId, planVersionId: "", subscriptionId: "" }
      : await createManagedSubscription(db, {
          tenantId,
          status: input.status ?? "active",
          startsAt: new Date(clock.getTime() - 60_000),
          endsAt,
          maxLines: 2,
          maxStations: 3,
          maxKiosks: 0,
          maxCabinetUsers: 5,
        });
  await setTenantInns(db, managed.tenantId, {
    org: input.org === undefined ? "7707083893" : input.org,
    ...(input.billing === undefined ? {} : { billing: input.billing }),
  });
  const request = activationRequest({
    inn: "7707083893",
    ...(input.usage === undefined ? {} : { usage: input.usage }),
  });
  const inspection = await sites.inspect(admin, managed.tenantId, { request });
  const site = await sites.register(admin, managed.tenantId, {
    intent: "create",
    requestId: randomUUID(),
    name: "Цех",
    request,
    acknowledgedWarnings: inspection.warnings,
  });
  return { admin, ...managed, endsAt, site };
}

function trustedKeyset() {
  if (!signing) throw new Error("fixture signing");
  return {
    origin: STANDALONE_TEST_ISSUER,
    keys: signing.keyset.keys.map((key) => ({
      kid: key.kid,
      jwk: { kty: key.jwk.kty, crv: key.jwk.crv, x: key.jwk.x, y: key.jwk.y },
    })),
    retiredKids: [],
  };
}

describe.skipIf(!process.env.DATABASE_URL)("standalone license issuance (plan ЛЦ-0)", () => {
  it("issues a subscription file from the snapshot that the domain verifies, with an exact audit row", async () => {
    const f = await siteFor();
    const preview = await issuance.preview(f.admin, f.tenantId, f.site.id, {
      graceDays: null,
      offline: null,
    });

    expect(preview.previous).toBeNull();
    expect(preview.next).toEqual({
      sequence: 1,
      source: "subscription",
      plan: "subscription",
      planVersionId: f.planVersionId,
      entitlementRevision: preview.expected.entitlementRevision,
      validFrom: clock.toISOString(),
      validUntil: f.endsAt?.toISOString(),
      validUntilReason: "subscription_end",
      graceDays: 14,
      customer: { name: `Subscription fixture ${f.tenantId}`, inn: "7707083893" },
      rights: {
        quotas: { lines: 2, stations: 3, kiosks: 0, cabinetUsers: 5 },
        features: NO_FEATURES,
      },
    });
    expect(preview.warnings).toEqual(UNMAPPED);
    expect(preview.expected).toEqual({
      entitlementRevision: preview.next.entitlementRevision,
      previousSequence: 0,
      boundaryAt: f.endsAt?.toISOString(),
    });
    expect(await issuedRows(f.tenantId)).toEqual([]);

    const requestId = randomUUID();
    const file = await issuance.confirm(f.admin, f.tenantId, f.site.id, {
      requestId,
      graceDays: null,
      offline: null,
      expected: preview.expected,
    });

    expect(file.fileName).toBe(`markiro-${f.site.hostId.slice(0, 8)}-001.mklic`);
    expect(file.sha256).toBe(createHash("sha256").update(file.compact, "utf8").digest("hex"));
    expect(
      JSON.parse(Buffer.from(file.compact.split(".")[0] ?? "", "base64url").toString("utf8")),
    ).toEqual({ alg: "ES256", typ: "markiro-standalone-license+jws", kid: "test-lic-api" });
    expect(await verifyStandaloneLicense(file.compact, trustedKeyset())).toMatchObject({
      ok: true,
      kid: "test-lic-api",
      license: {
        version: 1,
        licenseId: file.issuance.licenseId,
        sequence: 1,
        issuer: STANDALONE_TEST_ISSUER,
        tenantId: f.tenantId,
        siteId: f.site.id,
        hostId: f.site.hostId,
        customer: { inn: "7707083893" },
        plan: "subscription",
        planVersionId: f.planVersionId,
        issuedAt: clock.getTime(),
        validFrom: clock.getTime(),
        validUntil: f.endsAt?.getTime(),
        graceDays: 14,
        quotas: preview.next.rights.quotas,
        features: preview.next.rights.features,
        replaces: null,
      },
    });
    expect(file.issuance).toMatchObject({
      sequence: 1,
      source: "subscription",
      siteId: f.site.id,
      hostId: f.site.hostId,
      plan: "subscription",
      validUntilReason: "subscription_end",
      graceDays: 14,
      kid: "test-lic-api",
      sha256: file.sha256,
      issuedByPlatformUserId: f.admin.userId,
      replaces: null,
      rights: preview.next.rights,
    });

    // A transport retry replays the same file; the journal and the audit stay single.
    expect(
      await issuance.confirm(f.admin, f.tenantId, f.site.id, {
        requestId,
        graceDays: null,
        offline: null,
        expected: preview.expected,
      }),
    ).toEqual(file);
    expect(
      await issuance.download(f.admin, f.tenantId, f.site.id, file.issuance.licenseId),
    ).toEqual(file);
    expect((await issuance.listIssuances(f.admin, f.tenantId, f.site.id)).items).toEqual([
      file.issuance,
    ]);
    expect(await issuedRows(f.tenantId)).toHaveLength(1);
    const [siteRow] = await db
      .select({ last: schema.standaloneSites.lastIssuedSequence })
      .from(schema.standaloneSites)
      .where(eq(schema.standaloneSites.id, f.site.id));
    expect(siteRow?.last).toBe(1);
    const rows = await auditRows(db, f.tenantId);
    expect(rows.map((row) => row.action)).toEqual([
      "standalone_site.registered",
      "standalone_license.issued",
    ]);
    expect(rows[1]).toEqual({
      actorPlatformUserId: f.admin.userId,
      actorRole: "platform_admin",
      tenantId: f.tenantId,
      action: "standalone_license.issued",
      outcome: "success",
      targetType: "standalone_license",
      targetId: file.issuance.licenseId,
      reason: null,
      requestId,
      before: null,
      after: {
        siteId: f.site.id,
        hostId: f.site.hostId,
        licenseId: file.issuance.licenseId,
        sequence: 1,
        previousSequence: 0,
        replaces: null,
        source: "subscription",
        offlineTerms: null,
        plan: "subscription",
        planVersionId: f.planVersionId,
        entitlementRevision: preview.next.entitlementRevision,
        validFrom: clock.toISOString(),
        validUntil: f.endsAt?.toISOString(),
        validUntilReason: "subscription_end",
        graceDays: 14,
        kid: "test-lic-api",
        sha256: file.sha256,
        customer: preview.next.customer,
        quotas: preview.next.rights.quotas,
        features: preview.next.rights.features,
        warnings: UNMAPPED,
      },
    });
  });

  it("issues a demo file from a trial subscription with no grace and refuses a grace for it", async () => {
    const endsAt = new Date(Date.now() + 14 * DAY);
    const f = await siteFor({ status: "trial", endsAt });
    const preview = await issuance.preview(f.admin, f.tenantId, f.site.id, {
      graceDays: null,
      offline: null,
    });
    expect({
      plan: preview.next.plan,
      graceDays: preview.next.graceDays,
      validUntil: preview.next.validUntil,
      reason: preview.next.validUntilReason,
    }).toEqual({
      plan: "demo",
      graceDays: 0,
      validUntil: endsAt.toISOString(),
      reason: "subscription_end",
    });
    expect(
      await httpRefusal(
        issuance.preview(f.admin, f.tenantId, f.site.id, { graceDays: 3, offline: null }),
      ),
    ).toEqual({ status: 400, body: { code: "standalone_license_grace_invalid" } });
    const file = await issuance.confirm(f.admin, f.tenantId, f.site.id, {
      requestId: randomUUID(),
      graceDays: 0,
      offline: null,
      expected: preview.expected,
    });
    expect(file.issuance).toMatchObject({ plan: "demo", graceDays: 0 });
  });

  it("cuts validUntil at the first reduction of rights and ignores an increase before it", async () => {
    const f = await siteFor({ endsAt: new Date(Date.now() + 120 * DAY) });
    const temporary = await createPublishedAddon(db, [
      { entitlementKey: "stations", increment: 2 },
    ]);
    const growth = await createPublishedAddon(db, [{ entitlementKey: "lines", increment: 1 }]);
    const shrinkAt = new Date(clock.getTime() + 30 * DAY);
    await db.insert(schema.subscriptionAddons).values([
      {
        tenantId: f.tenantId,
        subscriptionId: f.subscriptionId,
        addonVersionId: growth,
        quantity: 1,
        startsAt: new Date(clock.getTime() + 10 * DAY),
        endsAt: null,
        status: "scheduled",
        source: "manual",
      },
      {
        tenantId: f.tenantId,
        subscriptionId: f.subscriptionId,
        addonVersionId: temporary,
        quantity: 1,
        startsAt: new Date(clock.getTime() - 60_000),
        endsAt: shrinkAt,
        status: "active",
        source: "manual",
      },
    ]);
    const preview = await issuance.preview(f.admin, f.tenantId, f.site.id, {
      graceDays: null,
      offline: null,
    });
    expect(preview.next.rights.quotas).toMatchObject({ stations: 5, lines: 2 });
    expect({
      validUntil: preview.next.validUntil,
      reason: preview.next.validUntilReason,
      boundaryAt: preview.expected.boundaryAt,
    }).toEqual({
      validUntil: shrinkAt.toISOString(),
      reason: "entitlement_reduction",
      boundaryAt: shrinkAt.toISOString(),
    });
  });

  it("orders two concurrent confirmations: one file 1, the other stale; the next issuance replaces it", async () => {
    const f = await siteFor();
    const preview = await issuance.preview(f.admin, f.tenantId, f.site.id, {
      graceDays: null,
      offline: null,
    });
    const results = await Promise.allSettled([
      issuance.confirm(f.admin, f.tenantId, f.site.id, {
        requestId: randomUUID(),
        graceDays: null,
        offline: null,
        expected: preview.expected,
      }),
      issuance.confirm(f.admin, f.tenantId, f.site.id, {
        requestId: randomUUID(),
        graceDays: null,
        offline: null,
        expected: preview.expected,
      }),
    ]);
    const fulfilled = results.flatMap((result) =>
      result.status === "fulfilled" ? [result.value] : [],
    );
    const rejected = results.flatMap((result) =>
      result.status === "rejected" ? [result.reason as unknown] : [],
    );
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]).toBeInstanceOf(ConflictException);
    expect(rejected[0] instanceof ConflictException ? rejected[0].getResponse() : null).toEqual({
      code: "standalone_license_preview_stale",
    });
    const first = fulfilled[0];
    if (!first) throw new Error("no winner");
    expect(first.issuance.sequence).toBe(1);
    expect(await issuedRows(f.tenantId)).toHaveLength(1);
    expect(
      (await auditRows(db, f.tenantId)).filter((row) => row.action === "standalone_license.issued"),
    ).toHaveLength(1);

    const next = await issuance.preview(f.admin, f.tenantId, f.site.id, {
      graceDays: 7,
      offline: null,
    });
    expect(next.previous).toEqual(first.issuance);
    expect(next.next).toMatchObject({ sequence: 2, graceDays: 7 });
    expect(next.expected.previousSequence).toBe(1);
    const secondRequest = randomUUID();
    const second = await issuance.confirm(f.admin, f.tenantId, f.site.id, {
      requestId: secondRequest,
      graceDays: 7,
      offline: null,
      expected: next.expected,
    });
    expect(second.issuance).toMatchObject({
      sequence: 2,
      graceDays: 7,
      replaces: first.issuance.licenseId,
    });
    expect(second.fileName).toBe(`markiro-${f.site.hostId.slice(0, 8)}-002.mklic`);
    const issued = (await auditRows(db, f.tenantId)).filter(
      (row) => row.action === "standalone_license.issued",
    );
    expect(issued[1]).toMatchObject({
      targetId: second.issuance.licenseId,
      requestId: secondRequest,
      before: {
        licenseId: first.issuance.licenseId,
        sequence: 1,
        plan: "subscription",
        validUntil: first.issuance.validUntil,
      },
      after: { sequence: 2, previousSequence: 1, replaces: first.issuance.licenseId, graceDays: 7 },
    });
    expect(
      (await issuance.listIssuances(f.admin, f.tenantId, f.site.id)).items.map(
        (item) => item.sequence,
      ),
    ).toEqual([2, 1]);
  });

  it("replays one request id confirmed twice at once as one file", async () => {
    const f = await siteFor();
    const preview = await issuance.preview(f.admin, f.tenantId, f.site.id, {
      graceDays: null,
      offline: null,
    });
    const body = {
      requestId: randomUUID(),
      graceDays: null,
      offline: null,
      expected: preview.expected,
    };
    const [a, b] = await Promise.all([
      issuance.confirm(f.admin, f.tenantId, f.site.id, body),
      issuance.confirm(f.admin, f.tenantId, f.site.id, body),
    ]);
    expect(b).toEqual(a);
    expect(await issuedRows(f.tenantId)).toHaveLength(1);
    expect(
      await httpRefusal(
        issuance.confirm(f.admin, f.tenantId, f.site.id, { ...body, graceDays: 30 }),
      ),
    ).toEqual({ status: 409, body: { code: "standalone_license_request_conflict" } });
  });

  it("refuses a stale expectation without writing anything", async () => {
    const f = await siteFor();
    const preview = await issuance.preview(f.admin, f.tenantId, f.site.id, {
      graceDays: null,
      offline: null,
    });
    for (const expected of [
      {
        ...preview.expected,
        entitlementRevision: String(BigInt(preview.expected.entitlementRevision) + 1n),
      },
      { ...preview.expected, previousSequence: 1 },
      { ...preview.expected, boundaryAt: new Date(clock.getTime() + DAY).toISOString() },
    ]) {
      expect(
        await httpRefusal(
          issuance.confirm(f.admin, f.tenantId, f.site.id, {
            requestId: randomUUID(),
            graceDays: null,
            offline: null,
            expected,
          }),
        ),
      ).toEqual({ status: 409, body: { code: "standalone_license_preview_stale" } });
    }
    expect(await issuedRows(f.tenantId)).toEqual([]);
    expect(
      (await auditRows(db, f.tenantId)).filter((row) => row.action === "standalone_license.issued"),
    ).toEqual([]);
  });

  it("refuses no managed subscription, no valid INN and no signing key", async () => {
    const unmanaged = await siteFor({ managed: false });
    expect(
      await httpRefusal(
        issuance.preview(unmanaged.admin, unmanaged.tenantId, unmanaged.site.id, {
          graceDays: null,
          offline: null,
        }),
      ),
    ).toEqual({ status: 409, body: { code: "standalone_license_subscription_required" } });

    const noInn = await siteFor({ org: null });
    expect(
      await httpRefusal(
        issuance.preview(noInn.admin, noInn.tenantId, noInn.site.id, {
          graceDays: null,
          offline: null,
        }),
      ),
    ).toEqual({ status: 409, body: { code: "standalone_license_inn_required" } });

    const billingOnly = await siteFor({ org: null, billing: "7707083893" });
    const fromBilling = await issuance.preview(
      billingOnly.admin,
      billingOnly.tenantId,
      billingOnly.site.id,
      { graceDays: null, offline: null },
    );
    expect(fromBilling.next.customer).toEqual({ name: "ООО «Завод Тест»", inn: "7707083893" });
    expect(fromBilling.warnings).toEqual([{ code: "customer_inn_from_billing" }, ...UNMAPPED]);

    const crowded = await siteFor({ usage: { stations: 4, cabinetUsers: 1, lines: 1 } });
    expect(
      (
        await issuance.preview(crowded.admin, crowded.tenantId, crowded.site.id, {
          graceDays: null,
          offline: null,
        })
      ).warnings,
    ).toEqual([{ code: "quota_below_usage", quota: "stations", limit: 3, used: 4 }, ...UNMAPPED]);

    const unsigned = new StandaloneLicenseIssuanceService(db, entitlements, audit, null, now);
    const f = await siteFor();
    const preview = await unsigned.preview(f.admin, f.tenantId, f.site.id, {
      graceDays: null,
      offline: null,
    });
    expect(
      await httpRefusal(
        unsigned.confirm(f.admin, f.tenantId, f.site.id, {
          requestId: randomUUID(),
          graceDays: null,
          offline: null,
          expected: preview.expected,
        }),
      ),
    ).toEqual({ status: 409, body: { code: "standalone_license_signing_unavailable" } });
    expect(await issuedRows(f.tenantId)).toEqual([]);
  });

  it("issues for a tenant whose id the counterparty chose, not a UUID (owner decision 2026-10-13)", async () => {
    const cabinetId = `Zq4b${randomUUID().replaceAll("-", "").slice(0, 20)}`;
    const f = await siteFor({ tenantId: cabinetId });
    const preview = await issuance.preview(f.admin, f.tenantId, f.site.id, {
      graceDays: null,
      offline: null,
    });
    const file = await issuance.confirm(f.admin, f.tenantId, f.site.id, {
      requestId: randomUUID(),
      graceDays: null,
      offline: null,
      expected: preview.expected,
    });
    expect(await verifyStandaloneLicense(file.compact, trustedKeyset())).toMatchObject({
      ok: true,
      license: { tenantId: cabinetId, siteId: f.site.id },
    });
  });

  it("signs a customer name without the characters the host refuses to show", async () => {
    const f = await siteFor();
    await db
      .update(schema.organization)
      .set({ name: "ООО\u202eЗавод\u0085 «Тест»\u2028\u2066" })
      .where(eq(schema.organization.id, f.tenantId));
    const preview = await issuance.preview(f.admin, f.tenantId, f.site.id, {
      graceDays: null,
      offline: null,
    });
    expect(preview.next.customer.name).toBe("ООО Завод  «Тест»");
    const file = await issuance.confirm(f.admin, f.tenantId, f.site.id, {
      requestId: randomUUID(),
      graceDays: null,
      offline: null,
      expected: preview.expected,
    });
    expect(await verifyStandaloneLicense(file.compact, trustedKeyset())).toMatchObject({
      ok: true,
    });
  });

  it("keeps tenants apart and denies roles without the capability", async () => {
    const a = await siteFor();
    const b = await siteFor();
    const preview = await issuance.preview(a.admin, a.tenantId, a.site.id, {
      graceDays: null,
      offline: null,
    });
    const file = await issuance.confirm(a.admin, a.tenantId, a.site.id, {
      requestId: randomUUID(),
      graceDays: null,
      offline: null,
      expected: preview.expected,
    });
    await expect(
      issuance.preview(b.admin, b.tenantId, a.site.id, { graceDays: null, offline: null }),
    ).rejects.toBeInstanceOf(NotFoundException);
    await expect(
      issuance.confirm(b.admin, b.tenantId, a.site.id, {
        requestId: randomUUID(),
        graceDays: null,
        offline: null,
        expected: preview.expected,
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
    await expect(issuance.listIssuances(b.admin, b.tenantId, a.site.id)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    await expect(
      issuance.download(b.admin, b.tenantId, a.site.id, file.issuance.licenseId),
    ).rejects.toBeInstanceOf(NotFoundException);
    await expect(
      issuance.download(b.admin, b.tenantId, b.site.id, file.issuance.licenseId),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(await issuedRows(b.tenantId)).toEqual([]);
    expect(
      (await auditRows(db, b.tenantId)).filter((row) => row.action === "standalone_license.issued"),
    ).toEqual([]);

    for (const actor of [
      await platformActor(db, "support"),
      await platformActor(db, "accountant"),
    ]) {
      await expect(
        issuance.preview(actor, a.tenantId, a.site.id, { graceDays: null, offline: null }),
      ).rejects.toBeInstanceOf(ForbiddenException);
      await expect(
        issuance.confirm(actor, a.tenantId, a.site.id, {
          requestId: randomUUID(),
          graceDays: null,
          offline: null,
          expected: preview.expected,
        }),
      ).rejects.toBeInstanceOf(ForbiddenException);
      await expect(issuance.listIssuances(actor, a.tenantId, a.site.id)).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      await expect(
        issuance.download(actor, a.tenantId, a.site.id, file.issuance.licenseId),
      ).rejects.toBeInstanceOf(ForbiddenException);
    }
    expect(await issuedRows(a.tenantId)).toHaveLength(1);
  });

  it("marks the site for renewal 30 days before validUntil", async () => {
    const f = await siteFor({ endsAt: new Date(Date.now() + 20 * DAY) });
    const preview = await issuance.preview(f.admin, f.tenantId, f.site.id, {
      graceDays: null,
      offline: null,
    });
    await issuance.confirm(f.admin, f.tenantId, f.site.id, {
      requestId: randomUUID(),
      graceDays: null,
      offline: null,
      expected: preview.expected,
    });
    const [site] = (await sites.list(f.admin, f.tenantId)).sites;
    expect(site).toMatchObject({
      renewalDue: true,
      lastIssuedSequence: 1,
      latestIssuance: { sequence: 1 },
    });
  });
});

/** A tenant without a cabinet, its organization INN and one registered site (owner decision 2026-10-13). */
async function offlineSiteFor() {
  clock = new Date();
  const admin = await platformActor(db);
  const tenantId = await createTenantWithoutCabinet(db);
  await setTenantInns(db, tenantId, { org: "7707083893" });
  const request = activationRequest({ inn: "7707083893" });
  const site = await sites.register(admin, tenantId, {
    intent: "create",
    requestId: randomUUID(),
    name: "Офлайн-цех",
    request,
    acknowledgedWarnings: [],
  });
  const planVersionId = await createPublishedPlan(db, {
    maxLines: 1,
    maxStations: 2,
    maxKiosks: 0,
    maxCabinetUsers: 3,
    palletsEnabled: true,
  });
  return { admin, tenantId, site, planVersionId };
}

async function cloudFootprint(tenantId: string) {
  const [tenant] = await db
    .select({ cabinetAccess: schema.organization.cabinetAccess })
    .from(schema.organization)
    .where(eq(schema.organization.id, tenantId));
  const subscriptions = await db
    .select({ id: schema.tenantSubscriptions.id })
    .from(schema.tenantSubscriptions)
    .where(eq(schema.tenantSubscriptions.tenantId, tenantId));
  const members = await db
    .select({ id: schema.member.id })
    .from(schema.member)
    .where(eq(schema.member.organizationId, tenantId));
  return { cabinetAccess: tenant?.cabinetAccess, subscriptions, members };
}

describe.skipIf(!process.env.DATABASE_URL)(
  "offline licenses for a tenant without a cabinet (owner decision 2026-10-13)",
  () => {
    it("issues a file from offline terms — a plan version and a term — with an exact audit row and no cloud access", async () => {
      const f = await offlineSiteFor();
      const offline = { planVersionId: f.planVersionId, termDays: 200 };
      const preview = await issuance.preview(f.admin, f.tenantId, f.site.id, {
        graceDays: null,
        offline,
      });
      const validUntil = new Date(clock.getTime() + 200 * DAY).toISOString();
      expect(preview.next).toEqual({
        sequence: 1,
        source: "offline",
        plan: "subscription",
        planVersionId: f.planVersionId,
        entitlementRevision: "0",
        validFrom: clock.toISOString(),
        validUntil,
        validUntilReason: "offline_term",
        graceDays: 14,
        customer: { name: `Offline tenant ${f.tenantId}`, inn: "7707083893" },
        rights: {
          quotas: { lines: 1, stations: 2, kiosks: 0, cabinetUsers: 3 },
          features: { ...NO_FEATURES, pallets: true },
        },
      });
      expect(preview.warnings).toEqual(UNMAPPED);
      expect(preview.expected).toEqual({
        entitlementRevision: "0",
        previousSequence: 0,
        boundaryAt: null,
      });

      const requestId = randomUUID();
      const file = await issuance.confirm(f.admin, f.tenantId, f.site.id, {
        requestId,
        graceDays: null,
        offline,
        expected: preview.expected,
      });
      expect(await verifyStandaloneLicense(file.compact, trustedKeyset())).toMatchObject({
        ok: true,
        license: {
          tenantId: f.tenantId,
          siteId: f.site.id,
          plan: "subscription",
          planVersionId: f.planVersionId,
          entitlementRevision: "0",
          validFrom: clock.getTime(),
          validUntil: clock.getTime() + 200 * DAY,
          graceDays: 14,
          quotas: { lines: 1, stations: 2, kiosks: 0, cabinetUsers: 3 },
        },
      });
      expect(file.issuance).toMatchObject({ source: "offline", validUntilReason: "offline_term" });
      const issued = (await auditRows(db, f.tenantId)).filter(
        (row) => row.action === "standalone_license.issued",
      );
      expect(issued).toEqual([
        {
          actorPlatformUserId: f.admin.userId,
          actorRole: "platform_admin",
          tenantId: f.tenantId,
          action: "standalone_license.issued",
          outcome: "success",
          targetType: "standalone_license",
          targetId: file.issuance.licenseId,
          reason: null,
          requestId,
          before: null,
          after: {
            siteId: f.site.id,
            hostId: f.site.hostId,
            licenseId: file.issuance.licenseId,
            sequence: 1,
            previousSequence: 0,
            replaces: null,
            source: "offline",
            offlineTerms: offline,
            plan: "subscription",
            planVersionId: f.planVersionId,
            entitlementRevision: "0",
            validFrom: clock.toISOString(),
            validUntil,
            validUntilReason: "offline_term",
            graceDays: 14,
            kid: "test-lic-api",
            sha256: file.sha256,
            customer: preview.next.customer,
            quotas: preview.next.rights.quotas,
            features: preview.next.rights.features,
            warnings: UNMAPPED,
          },
        },
      ]);
      expect(await cloudFootprint(f.tenantId)).toEqual({
        cabinetAccess: "none",
        subscriptions: [],
        members: [],
      });

      // The same request replays the file; other terms under the same request id conflict.
      expect(
        await issuance.confirm(f.admin, f.tenantId, f.site.id, {
          requestId,
          graceDays: null,
          offline,
          expected: preview.expected,
        }),
      ).toEqual(file);
      for (const other of [
        { ...offline, termDays: 100 },
        { ...offline, planVersionId: randomUUID() },
        null,
      ]) {
        expect(
          await httpRefusal(
            issuance.confirm(f.admin, f.tenantId, f.site.id, {
              requestId,
              graceDays: null,
              offline: other,
              expected: preview.expected,
            }),
          ),
        ).toEqual({ status: 409, body: { code: "standalone_license_request_conflict" } });
      }
      expect(await issuedRows(f.tenantId)).toHaveLength(1);
    });

    it("requires offline terms, refuses a plan version that is not a published plan, and never a cloud path", async () => {
      const f = await offlineSiteFor();
      expect(
        await httpRefusal(
          issuance.preview(f.admin, f.tenantId, f.site.id, { graceDays: null, offline: null }),
        ),
      ).toEqual({ status: 409, body: { code: "standalone_license_offline_terms_required" } });
      const unknown = randomUUID();
      const retired = await createPublishedPlan(db, {
        maxLines: 1,
        maxStations: 1,
        maxKiosks: 0,
        maxCabinetUsers: 1,
      });
      await db
        .update(schema.catalogItemVersions)
        .set({ status: "retired" })
        .where(eq(schema.catalogItemVersions.id, retired));
      const addon = await createPublishedAddon(db, [{ entitlementKey: "stations", increment: 1 }]);
      for (const planVersionId of [unknown, addon, retired]) {
        expect(
          await httpRefusal(
            issuance.preview(f.admin, f.tenantId, f.site.id, {
              graceDays: null,
              offline: { planVersionId, termDays: 30 },
            }),
          ),
        ).toEqual({ status: 409, body: { code: "standalone_license_offline_plan_unavailable" } });
      }
      expect(
        await httpRefusal(
          issuance.confirm(f.admin, f.tenantId, f.site.id, {
            requestId: randomUUID(),
            graceDays: null,
            offline: null,
            expected: { entitlementRevision: "0", previousSequence: 0, boundaryAt: null },
          }),
        ),
      ).toEqual({ status: 409, body: { code: "standalone_license_offline_terms_required" } });
      expect(await issuedRows(f.tenantId)).toEqual([]);

      const cloud = await siteFor();
      expect(
        await httpRefusal(
          issuance.preview(cloud.admin, cloud.tenantId, cloud.site.id, {
            graceDays: null,
            offline: { planVersionId: cloud.planVersionId, termDays: 30 },
          }),
        ),
      ).toEqual({ status: 409, body: { code: "standalone_license_offline_not_allowed" } });
    });

    it("denies support and accountant the offline path too", async () => {
      const f = await offlineSiteFor();
      for (const actor of [
        await platformActor(db, "support"),
        await platformActor(db, "accountant"),
      ]) {
        await expect(
          issuance.preview(actor, f.tenantId, f.site.id, {
            graceDays: null,
            offline: { planVersionId: f.planVersionId, termDays: 30 },
          }),
        ).rejects.toBeInstanceOf(ForbiddenException);
      }
    });
  },
);
