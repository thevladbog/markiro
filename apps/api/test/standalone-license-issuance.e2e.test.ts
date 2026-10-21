import { createHash, randomUUID } from "node:crypto";
import {
  ConflictException,
  ForbiddenException,
  HttpException,
  NotFoundException,
} from "@nestjs/common";
import { createDb, schema } from "@markiro/db";
import { standaloneLicensePayloadV1Schema, verifyStandaloneLicense } from "@markiro/domain";
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
  customLogo: false,
};
const UNMAPPED = (
  ["chzIntegration", "inventory", "commerceMl", "handheld", "customLogo"] as const
).map((feature) => ({ code: "feature_unmapped" as const, feature }));

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
      sourceAssignments: null,
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
      termsDigest: expect.stringMatching(/^[0-9a-f]{64}$/u),
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
        demoTerm: null,
        sourceAssignments: null,
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

  it("refuses to sign anything the preview did not show: another grace, a rebound host, a changed name", async () => {
    const f = await siteFor();
    const preview = await issuance.preview(f.admin, f.tenantId, f.site.id, {
      graceDays: null,
      offline: null,
    });
    const stale = { status: 409, body: { code: "standalone_license_preview_stale" } };
    expect(
      await httpRefusal(
        issuance.confirm(f.admin, f.tenantId, f.site.id, {
          requestId: randomUUID(),
          graceDays: 30,
          offline: null,
          expected: preview.expected,
        }),
      ),
    ).toEqual(stale);
    await db
      .update(schema.organization)
      .set({ name: "ООО «Новое имя»" })
      .where(eq(schema.organization.id, f.tenantId));
    expect(
      await httpRefusal(
        issuance.confirm(f.admin, f.tenantId, f.site.id, {
          requestId: randomUUID(),
          graceDays: null,
          offline: null,
          expected: preview.expected,
        }),
      ),
    ).toEqual(stale);
    const renamed = await issuance.preview(f.admin, f.tenantId, f.site.id, {
      graceDays: null,
      offline: null,
    });
    await sites.register(f.admin, f.tenantId, {
      intent: "rebind",
      requestId: randomUUID(),
      siteId: f.site.id,
      request: activationRequest({ inn: "7707083893" }),
      acknowledgedWarnings: [],
    });
    expect(
      await httpRefusal(
        issuance.confirm(f.admin, f.tenantId, f.site.id, {
          requestId: randomUUID(),
          graceDays: null,
          offline: null,
          expected: renamed.expected,
        }),
      ),
    ).toEqual(stale);
    expect(await issuedRows(f.tenantId)).toEqual([]);
  });

  it("replays a request id only for its own administrator and site", async () => {
    const f = await siteFor();
    const other = await platformActor(db);
    const second = await sites.register(f.admin, f.tenantId, {
      intent: "create",
      requestId: randomUUID(),
      name: "Склад",
      request: activationRequest({ inn: "7707083893" }),
      acknowledgedWarnings: [],
    });
    const preview = await issuance.preview(f.admin, f.tenantId, f.site.id, {
      graceDays: null,
      offline: null,
    });
    const requestId = randomUUID();
    const file = await issuance.confirm(f.admin, f.tenantId, f.site.id, {
      requestId,
      graceDays: null,
      offline: null,
      expected: preview.expected,
    });
    expect(
      await httpRefusal(
        issuance.confirm(other, f.tenantId, f.site.id, {
          requestId,
          graceDays: null,
          offline: null,
          expected: preview.expected,
        }),
      ),
    ).toEqual({ status: 409, body: { code: "standalone_license_request_conflict" } });
    // The same request id on the tenant's other site is a new issuance there, not this file.
    const secondPreview = await issuance.preview(f.admin, f.tenantId, second.id, {
      graceDays: null,
      offline: null,
    });
    const secondFile = await issuance.confirm(f.admin, f.tenantId, second.id, {
      requestId,
      graceDays: null,
      offline: null,
      expected: secondPreview.expected,
    });
    expect(secondFile.issuance).toMatchObject({ siteId: second.id, sequence: 1 });
    expect(secondFile.issuance.licenseId).not.toBe(file.issuance.licenseId);
    await expect(
      issuance.download(f.admin, f.tenantId, second.id, file.issuance.licenseId),
    ).rejects.toBeInstanceOf(NotFoundException);
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
      { ...preview.expected, termsDigest: "0".repeat(64) },
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
      .set({ name: "ООО\u202eЗавод\u0085 «Тест»\u2028\u2066\t\n\u007f\u2029" })
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

  it("cuts a long name with emoji to 300 UTF-16 units and names a tenant of control characters with a dash", async () => {
    const f = await siteFor();
    await db
      .update(schema.organization)
      .set({ name: `${"Я".repeat(290)}${"🏭".repeat(60)}` })
      .where(eq(schema.organization.id, f.tenantId));
    const preview = await issuance.preview(f.admin, f.tenantId, f.site.id, {
      graceDays: null,
      offline: null,
    });
    expect(preview.next.customer.name).toBe(`${"Я".repeat(290)}${"🏭".repeat(5)}`);
    expect(preview.next.customer.name).toHaveLength(300);
    const file = await issuance.confirm(f.admin, f.tenantId, f.site.id, {
      requestId: randomUUID(),
      graceDays: null,
      offline: null,
      expected: preview.expected,
    });
    expect(await verifyStandaloneLicense(file.compact, trustedKeyset())).toMatchObject({
      ok: true,
    });

    await db
      .update(schema.organization)
      .set({ name: "\u0001\u202e\u2028" })
      .where(eq(schema.organization.id, f.tenantId));
    expect(
      (await issuance.preview(f.admin, f.tenantId, f.site.id, { graceDays: null, offline: null }))
        .next.customer.name,
    ).toBe("—");
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

type OfflineAssignments = {
  plan?: {
    maxLines: number | null;
    maxStations: number | null;
    maxKiosks: number | null;
    maxCabinetUsers: number | null;
  };
  endsAt?: Date | null;
  addonLines?: { increment: number; quantity: number; endsAt?: Date | null };
};

/** A tenant without a cabinet, its organization INN, one site and its direct assignments (spec 2026-10-16). */
async function offlineSiteFor(
  assign: OfflineAssignments = {
    plan: { maxLines: 1, maxStations: 2, maxKiosks: 0, maxCabinetUsers: 3 },
  },
) {
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
  let subscriptionId = "";
  let planVersionId = "";
  let addonVersionId = "";
  let addonId = "";
  if (assign.plan) {
    const managed = await createManagedSubscription(db, {
      tenantId,
      status: "active",
      startsAt: new Date(clock.getTime() - 60_000),
      endsAt: assign.endsAt === undefined ? null : assign.endsAt,
      ...assign.plan,
    });
    subscriptionId = managed.subscriptionId;
    planVersionId = managed.planVersionId;
    if (assign.addonLines) {
      addonVersionId = await createPublishedAddon(db, [
        { entitlementKey: "lines", increment: assign.addonLines.increment },
      ]);
      const [addon] = await db
        .insert(schema.subscriptionAddons)
        .values({
          tenantId,
          subscriptionId,
          addonVersionId,
          quantity: assign.addonLines.quantity,
          startsAt: new Date(clock.getTime() - 60_000),
          endsAt: assign.addonLines.endsAt ?? null,
          status: "active",
          source: "manual",
        })
        .returning({ id: schema.subscriptionAddons.id });
      addonId = addon!.id;
    }
  }
  return { admin, tenantId, site, subscriptionId, planVersionId, addonVersionId, addonId };
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
  const invitations = await db
    .select({ id: schema.invitation.id })
    .from(schema.invitation)
    .where(eq(schema.invitation.organizationId, tenantId));
  const addons = await db
    .select({ id: schema.subscriptionAddons.id })
    .from(schema.subscriptionAddons)
    .where(eq(schema.subscriptionAddons.tenantId, tenantId));
  const sources = await db
    .select({ id: schema.entitlementSources.id })
    .from(schema.entitlementSources)
    .where(eq(schema.entitlementSources.tenantId, tenantId));
  const revisions = await db
    .select({ tenantId: schema.entitlementRevisions.tenantId })
    .from(schema.entitlementRevisions)
    .where(eq(schema.entitlementRevisions.tenantId, tenantId));
  const devices = await db
    .select({ id: schema.stationDevices.id })
    .from(schema.stationDevices)
    .where(eq(schema.stationDevices.tenantId, tenantId));
  const assignments = await db
    .select({ id: schema.workingDeviceAssignments.id })
    .from(schema.workingDeviceAssignments)
    .where(eq(schema.workingDeviceAssignments.tenantId, tenantId));
  return {
    cabinetAccess: tenant?.cabinetAccess,
    subscriptions,
    members,
    invitations,
    addons,
    sources,
    revisions,
    devices,
    assignments,
  };
}

describe.skipIf(!process.env.DATABASE_URL)(
  "offline licenses from the assignments of a tenant without a cabinet (spec 2026-10-16)",
  () => {
    it("issues a file from the plan and add-on assignments with an exact journal row and audit", async () => {
      const f = await offlineSiteFor({
        plan: { maxLines: 2, maxStations: 3, maxKiosks: 0, maxCabinetUsers: 5 },
        addonLines: { increment: 3, quantity: 2 },
        endsAt: null,
      });
      const preview = await issuance.preview(f.admin, f.tenantId, f.site.id, {
        graceDays: null,
        offline: null,
      });
      const assignments = [
        { kind: "plan", id: f.subscriptionId, catalogVersionId: f.planVersionId },
        { kind: "addon", id: f.addonId, catalogVersionId: f.addonVersionId },
      ];
      expect(preview.next).toMatchObject({
        sequence: 1,
        source: "offline_assignments",
        plan: "subscription",
        planVersionId: f.planVersionId,
        validUntil: new Date(clock.getTime() + 365 * DAY).toISOString(),
        validUntilReason: "one_year_cap",
        graceDays: 14,
        rights: { quotas: { lines: 8, stations: 3, kiosks: 0, cabinetUsers: 5 } },
        sourceAssignments: assignments,
      });
      expect(preview.next.entitlementRevision).not.toBe("0");
      expect(preview.warnings).toEqual(
        expect.arrayContaining([{ code: "feature_unmapped", feature: "handheld" }]),
      );

      const requestId = randomUUID();
      const file = await issuance.confirm(f.admin, f.tenantId, f.site.id, {
        requestId,
        graceDays: null,
        offline: null,
        expected: preview.expected,
      });
      expect(await verifyStandaloneLicense(file.compact, trustedKeyset())).toMatchObject({
        ok: true,
        license: {
          tenantId: f.tenantId,
          plan: "subscription",
          planVersionId: f.planVersionId,
          entitlementRevision: preview.next.entitlementRevision,
          quotas: { lines: 8, stations: 3, kiosks: 0, cabinetUsers: 5 },
        },
      });
      const [row] = await issuedRows(f.tenantId);
      expect(row).toMatchObject({
        source: "offline_assignments",
        validUntilReason: "one_year_cap",
        sourceAssignments: assignments,
      });
      const issued = (await auditRows(db, f.tenantId)).filter(
        (entry) => entry.action === "standalone_license.issued",
      );
      expect(issued).toHaveLength(1);
      expect(issued[0]).toMatchObject({
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
          source: "offline_assignments",
          offlineTerms: null,
          sourceAssignments: assignments,
          entitlementRevision: preview.next.entitlementRevision,
          validUntilReason: "one_year_cap",
          quotas: { lines: 8, stations: 3, kiosks: 0, cabinetUsers: 5 },
        },
      });
      // Issuing changes nothing in the cloud: no cabinet, no new subscription rows, no documents.
      const footprint = await cloudFootprint(f.tenantId);
      expect(footprint.cabinetAccess).toBe("none");
      expect(footprint.subscriptions).toEqual([{ id: f.subscriptionId }]);
      expect(footprint.members).toEqual([]);
      const documents = await db
        .select({ id: schema.invoices.id })
        .from(schema.invoices)
        .where(eq(schema.invoices.tenantId, f.tenantId));
      expect(documents).toEqual([]);

      // The same request replays the file for the assignments source too.
      expect(
        await issuance.confirm(f.admin, f.tenantId, f.site.id, {
          requestId,
          graceDays: null,
          offline: null,
          expected: preview.expected,
        }),
      ).toEqual(file);
    });

    it("ends the file with the assignment when it has an end date", async () => {
      const endsAt = new Date(Date.now() + 90 * DAY);
      const f = await offlineSiteFor({
        plan: { maxLines: 1, maxStations: 1, maxKiosks: 0, maxCabinetUsers: 1 },
        endsAt,
      });
      const preview = await issuance.preview(f.admin, f.tenantId, f.site.id, {
        graceDays: null,
        offline: null,
      });
      expect(preview.next.validUntil).toBe(endsAt.toISOString());
      expect(preview.next.validUntilReason).toBe("subscription_end");
    });

    it("cuts the file where an add-on ends and the rights shrink", async () => {
      const addonEnds = new Date(Date.now() + 30 * DAY);
      const f = await offlineSiteFor({
        plan: { maxLines: 1, maxStations: 1, maxKiosks: 0, maxCabinetUsers: 1 },
        endsAt: null,
        addonLines: { increment: 2, quantity: 1, endsAt: addonEnds },
      });
      const preview = await issuance.preview(f.admin, f.tenantId, f.site.id, {
        graceDays: null,
        offline: null,
      });
      expect(preview.next.validUntil).toBe(addonEnds.toISOString());
      expect(preview.next.validUntilReason).toBe("entitlement_reduction");
    });

    it("refuses a tenant without a current plan assignment, also after it has expired", async () => {
      const bare = await offlineSiteFor({});
      expect(
        await httpRefusal(
          issuance.preview(bare.admin, bare.tenantId, bare.site.id, {
            graceDays: null,
            offline: null,
          }),
        ),
      ).toEqual({ status: 409, body: { code: "standalone_license_assignments_required" } });
      const f = await offlineSiteFor({
        plan: { maxLines: 1, maxStations: 1, maxKiosks: 0, maxCabinetUsers: 1 },
        endsAt: null,
      });
      await db
        .update(schema.tenantSubscriptions)
        .set({ status: "expired", endsAt: new Date(clock.getTime() - 1_000) })
        .where(eq(schema.tenantSubscriptions.tenantId, f.tenantId));
      expect(
        await httpRefusal(
          issuance.preview(f.admin, f.tenantId, f.site.id, { graceDays: null, offline: null }),
        ),
      ).toEqual({ status: 409, body: { code: "standalone_license_assignments_required" } });
      expect(await issuedRows(f.tenantId)).toEqual([]);
    });

    it("refuses a trial assignment of a tenant without a cabinet", async () => {
      const f = await offlineSiteFor({
        plan: { maxLines: 1, maxStations: 1, maxKiosks: 0, maxCabinetUsers: 1 },
        endsAt: null,
      });
      await db
        .update(schema.tenantSubscriptions)
        .set({ status: "trial" })
        .where(eq(schema.tenantSubscriptions.tenantId, f.tenantId));
      expect(
        await httpRefusal(
          issuance.preview(f.admin, f.tenantId, f.site.id, { graceDays: null, offline: null }),
        ),
      ).toEqual({ status: 409, body: { code: "standalone_license_assignments_required" } });
    });

    it("refuses a stale preview when an assignment changes before confirmation", async () => {
      const f = await offlineSiteFor({
        plan: { maxLines: 1, maxStations: 1, maxKiosks: 0, maxCabinetUsers: 1 },
        endsAt: null,
      });
      const preview = await issuance.preview(f.admin, f.tenantId, f.site.id, {
        graceDays: null,
        offline: null,
      });
      const addonVersionId = await createPublishedAddon(db, [
        { entitlementKey: "lines", increment: 1 },
      ]);
      await db.insert(schema.subscriptionAddons).values({
        tenantId: f.tenantId,
        subscriptionId: f.subscriptionId,
        addonVersionId,
        quantity: 1,
        startsAt: new Date(clock.getTime() - 60_000),
        status: "active",
        source: "manual",
      });
      expect(
        await httpRefusal(
          issuance.confirm(f.admin, f.tenantId, f.site.id, {
            requestId: randomUUID(),
            graceDays: null,
            offline: null,
            expected: preview.expected,
          }),
        ),
      ).toEqual({ status: 409, body: { code: "standalone_license_preview_stale" } });
      expect(await issuedRows(f.tenantId)).toEqual([]);
    });

    it("names only the assignments that contribute at the issuance instant", async () => {
      const f = await offlineSiteFor({
        plan: { maxLines: 2, maxStations: 3, maxKiosks: 0, maxCabinetUsers: 5 },
        endsAt: null,
        addonLines: { increment: 3, quantity: 2 },
      });
      // Not yet started: the entitlement projection ignores it until it starts.
      const futureVersionId = await createPublishedAddon(db, [
        { entitlementKey: "lines", increment: 7 },
      ]);
      await db.insert(schema.subscriptionAddons).values({
        tenantId: f.tenantId,
        subscriptionId: f.subscriptionId,
        addonVersionId: futureVersionId,
        quantity: 1,
        startsAt: new Date(clock.getTime() + 10 * DAY),
        status: "scheduled",
        source: "manual",
      });
      // Past its end but not yet materialized by the status job: still `active` in the row.
      const endedVersionId = await createPublishedAddon(db, [
        { entitlementKey: "lines", increment: 11 },
      ]);
      await db.insert(schema.subscriptionAddons).values({
        tenantId: f.tenantId,
        subscriptionId: f.subscriptionId,
        addonVersionId: endedVersionId,
        quantity: 1,
        startsAt: new Date(clock.getTime() - 2 * DAY),
        endsAt: new Date(clock.getTime() - 60_000),
        status: "active",
        source: "manual",
      });
      const contributing = [
        { kind: "plan", id: f.subscriptionId, catalogVersionId: f.planVersionId },
        { kind: "addon", id: f.addonId, catalogVersionId: f.addonVersionId },
      ];
      const preview = await issuance.preview(f.admin, f.tenantId, f.site.id, {
        graceDays: null,
        offline: null,
      });
      expect(preview.next.sourceAssignments).toEqual(contributing);
      expect(preview.next.rights.quotas.lines).toBe(8);

      const requestId = randomUUID();
      const file = await issuance.confirm(f.admin, f.tenantId, f.site.id, {
        requestId,
        graceDays: null,
        offline: null,
        expected: preview.expected,
      });
      const [row] = await issuedRows(f.tenantId);
      expect(row).toMatchObject({ source: "offline_assignments", sourceAssignments: contributing });
      const issued = (await auditRows(db, f.tenantId)).filter(
        (entry) => entry.action === "standalone_license.issued",
      );
      expect(issued).toHaveLength(1);
      expect(issued[0]).toMatchObject({
        actorPlatformUserId: f.admin.userId,
        actorRole: "platform_admin",
        tenantId: f.tenantId,
        action: "standalone_license.issued",
        outcome: "success",
        targetType: "standalone_license",
        targetId: file.issuance.licenseId,
        requestId,
        after: {
          source: "offline_assignments",
          sourceAssignments: contributing,
          quotas: { lines: 8 },
        },
      });
    });

    it("issues a plan with 64 add-ons: 65 references are the journal's whole capacity", async () => {
      const f = await offlineSiteFor({
        plan: { maxLines: 1, maxStations: 1, maxKiosks: 0, maxCabinetUsers: 1 },
        endsAt: null,
      });
      const versionId = await createPublishedAddon(db, [{ entitlementKey: "lines", increment: 1 }]);
      await db.insert(schema.subscriptionAddons).values(
        Array.from({ length: 64 }, () => ({
          tenantId: f.tenantId,
          subscriptionId: f.subscriptionId,
          addonVersionId: versionId,
          quantity: 1,
          startsAt: new Date(clock.getTime() - 60_000),
          status: "active" as const,
          source: "manual" as const,
        })),
      );
      const preview = await issuance.preview(f.admin, f.tenantId, f.site.id, {
        graceDays: null,
        offline: null,
      });
      expect(preview.next.sourceAssignments).toHaveLength(65);
      expect(preview.next.rights.quotas.lines).toBe(65);
      await issuance.confirm(f.admin, f.tenantId, f.site.id, {
        requestId: randomUUID(),
        graceDays: null,
        offline: null,
        expected: preview.expected,
      });
      const [row] = await issuedRows(f.tenantId);
      expect(row?.sourceAssignments).toHaveLength(65);
    });

    it("refuses 66 references with a clear code, in the preview and the confirmation, and writes nothing", async () => {
      const f = await offlineSiteFor({
        plan: { maxLines: 1, maxStations: 1, maxKiosks: 0, maxCabinetUsers: 1 },
        endsAt: null,
      });
      const versionId = await createPublishedAddon(db, [{ entitlementKey: "lines", increment: 1 }]);
      await db.insert(schema.subscriptionAddons).values(
        Array.from({ length: 65 }, () => ({
          tenantId: f.tenantId,
          subscriptionId: f.subscriptionId,
          addonVersionId: versionId,
          quantity: 1,
          startsAt: new Date(clock.getTime() - 60_000),
          status: "active" as const,
          source: "manual" as const,
        })),
      );
      const refusal = { status: 409, body: { code: "standalone_assignment_limit_reached" } };
      expect(
        await httpRefusal(
          issuance.preview(f.admin, f.tenantId, f.site.id, { graceDays: null, offline: null }),
        ),
      ).toEqual(refusal);
      expect(
        await httpRefusal(
          issuance.confirm(f.admin, f.tenantId, f.site.id, {
            requestId: randomUUID(),
            graceDays: null,
            offline: null,
            expected: {
              entitlementRevision: "0",
              previousSequence: 0,
              boundaryAt: null,
              termsDigest: "0".repeat(64),
            },
          }),
        ),
      ).toEqual(refusal);
      expect(await issuedRows(f.tenantId)).toEqual([]);
    });

    it("does not cap a tenant with a cabinet: it names no assignments, however many add-ons it has", async () => {
      const f = await siteFor({ endsAt: null });
      const versionId = await createPublishedAddon(db, [{ entitlementKey: "lines", increment: 1 }]);
      await db.insert(schema.subscriptionAddons).values(
        Array.from({ length: 65 }, () => ({
          tenantId: f.tenantId,
          subscriptionId: f.subscriptionId,
          addonVersionId: versionId,
          quantity: 1,
          startsAt: new Date(clock.getTime() - 60_000),
          status: "active" as const,
          source: "manual" as const,
        })),
      );
      const preview = await issuance.preview(f.admin, f.tenantId, f.site.id, {
        graceDays: null,
        offline: null,
      });
      expect(preview.next).toMatchObject({ source: "subscription", sourceAssignments: null });
      expect(preview.next.rights.quotas.lines).toBe(67);
    });

    it("refuses the previewed file when the tenant got a cabinet before confirmation", async () => {
      const f = await offlineSiteFor();
      const preview = await issuance.preview(f.admin, f.tenantId, f.site.id, {
        graceDays: null,
        offline: null,
      });
      await db
        .update(schema.organization)
        .set({ cabinetAccess: "enabled" })
        .where(eq(schema.organization.id, f.tenantId));
      expect(
        await httpRefusal(
          issuance.confirm(f.admin, f.tenantId, f.site.id, {
            requestId: randomUUID(),
            graceDays: null,
            offline: null,
            expected: preview.expected,
          }),
        ),
      ).toEqual({ status: 409, body: { code: "standalone_license_preview_stale" } });
      expect(await issuedRows(f.tenantId)).toEqual([]);
    });

    it("refuses the removed offline terms and keeps replaying an offline issuance made before", async () => {
      const f = await offlineSiteFor();
      const offline = { planVersionId: f.planVersionId, termDays: 30 };
      expect(
        await httpRefusal(
          issuance.preview(f.admin, f.tenantId, f.site.id, { graceDays: null, offline }),
        ),
      ).toEqual({ status: 409, body: { code: "standalone_license_offline_terms_removed" } });

      // A row of the removed manual path, as the journal holds it from before.
      const legacyRequestId = randomUUID();
      const legacyId = randomUUID();
      const legacyPayload = standaloneLicensePayloadV1Schema.parse({
        version: 1,
        licenseId: legacyId,
        sequence: 1,
        issuer: STANDALONE_TEST_ISSUER,
        tenantId: f.tenantId,
        siteId: f.site.id,
        hostId: f.site.hostId,
        customer: { name: "Офлайн-клиент", inn: "7707083893" },
        plan: "subscription",
        planVersionId: f.planVersionId,
        entitlementRevision: "0",
        issuedAt: clock.getTime(),
        validFrom: clock.getTime(),
        validUntil: clock.getTime() + 30 * DAY,
        graceDays: 14,
        quotas: { lines: 1, stations: 2, kiosks: 0, cabinetUsers: 3 },
        features: NO_FEATURES,
        replaces: null,
      });
      await db.insert(schema.standaloneLicenseIssuances).values({
        id: legacyId,
        tenantId: f.tenantId,
        siteId: f.site.id,
        sequence: 1,
        requestId: legacyRequestId,
        hostId: f.site.hostId,
        source: "offline",
        plan: "subscription",
        planVersionId: f.planVersionId,
        entitlementRevision: 0n,
        payload: legacyPayload,
        compact: "legacy.compact.value",
        sha256: "c".repeat(64),
        kid: "test-lic-api",
        graceDays: 14,
        issuedAt: clock,
        validFrom: clock,
        validUntil: new Date(clock.getTime() + 30 * DAY),
        validUntilReason: "offline_term",
        issuedByPlatformUserId: f.admin.userId,
      });
      await db
        .update(schema.standaloneSites)
        .set({ lastIssuedSequence: 1 })
        .where(eq(schema.standaloneSites.id, f.site.id));
      const [summary] = (await issuance.listIssuances(f.admin, f.tenantId, f.site.id)).items;
      expect(summary).toMatchObject({
        source: "offline",
        validUntilReason: "offline_term",
        entitlementRevision: "0",
        sourceAssignments: null,
      });
      const replay = await issuance.confirm(f.admin, f.tenantId, f.site.id, {
        requestId: legacyRequestId,
        graceDays: null,
        offline,
        expected: {
          entitlementRevision: "0",
          previousSequence: 0,
          boundaryAt: null,
          termsDigest: "d".repeat(64),
        },
      });
      expect(replay.issuance.licenseId).toBe(legacyId);
      expect(
        await httpRefusal(
          issuance.confirm(f.admin, f.tenantId, f.site.id, {
            requestId: legacyRequestId,
            graceDays: null,
            offline: null,
            expected: {
              entitlementRevision: "0",
              previousSequence: 0,
              boundaryAt: null,
              termsDigest: "d".repeat(64),
            },
          }),
        ),
      ).toEqual({ status: 409, body: { code: "standalone_license_request_conflict" } });
    });

    it("keeps tenants apart and denies roles without the capability", async () => {
      const a = await offlineSiteFor();
      const b = await offlineSiteFor();
      expect(
        await httpRefusal(issuance.listIssuances(a.admin, a.tenantId, b.site.id)),
      ).toMatchObject({ status: 404 });
      for (const role of ["support", "accountant"] as const) {
        const actor = await platformActor(db, role);
        await expect(
          issuance.preview(actor, a.tenantId, a.site.id, { graceDays: null, offline: null }),
        ).rejects.toBeInstanceOf(ForbiddenException);
      }
    });

    it("does not read another tenant's assignments", async () => {
      const a = await offlineSiteFor({
        plan: { maxLines: 7, maxStations: 7, maxKiosks: 0, maxCabinetUsers: 7 },
        endsAt: null,
      });
      const b = await offlineSiteFor({
        plan: { maxLines: 1, maxStations: 1, maxKiosks: 0, maxCabinetUsers: 1 },
        endsAt: null,
      });
      const preview = await issuance.preview(b.admin, b.tenantId, b.site.id, {
        graceDays: null,
        offline: null,
      });
      expect(preview.next.rights.quotas).toEqual({
        lines: 1,
        stations: 1,
        kiosks: 0,
        cabinetUsers: 1,
      });
      expect(preview.next.sourceAssignments).toEqual([
        { kind: "plan", id: b.subscriptionId, catalogVersionId: b.planVersionId },
      ]);
      expect(a.subscriptionId).not.toBe(b.subscriptionId);
    });

    it("issues from the subscription path once the tenant has a cabinet, with the same rights", async () => {
      const f = await offlineSiteFor();
      await db
        .update(schema.organization)
        .set({ cabinetAccess: "enabled" })
        .where(eq(schema.organization.id, f.tenantId));
      const preview = await issuance.preview(f.admin, f.tenantId, f.site.id, {
        graceDays: null,
        offline: null,
      });
      expect(preview.next).toMatchObject({
        source: "subscription",
        sourceAssignments: null,
        rights: { quotas: { lines: 1, stations: 2, kiosks: 0, cabinetUsers: 3 } },
      });
    });
  },
);
