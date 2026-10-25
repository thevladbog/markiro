import { randomUUID } from "node:crypto";
import { HttpException } from "@nestjs/common";
import { createDb, schema } from "@markiro/db";
import { verifyStandaloneLicense } from "@markiro/domain";
import { STANDALONE_DEMO_PLAN_VERSION_ID } from "@markiro/platform-contracts";
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

const TRIAL_RIGHTS = {
  quotas: { lines: null, stations: null, kiosks: null, cabinetUsers: null },
  features: {
    labelEditor: true,
    publicApi: true,
    pallets: true,
    chzIntegration: true,
    inventory: true,
    commerceMl: true,
    handheld: true,
    customLogo: true,
  },
};

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

/** A tenant without a cabinet, one site, and optionally an assigned plan with one add-on. */
async function offlineSite(assign: { plan?: boolean; addon?: boolean } = {}) {
  clock = new Date();
  const admin = await platformActor(db);
  const tenantId = await createTenantWithoutCabinet(db);
  await setTenantInns(db, tenantId, { org: "7707083893" });
  const site = await sites.register(admin, tenantId, {
    intent: "create",
    requestId: randomUUID(),
    name: "Пилотный цех",
    request: activationRequest({ inn: "7707083893" }),
    acknowledgedWarnings: [],
  });
  let subscriptionId = "";
  let planVersionId = "";
  let addonId = "";
  let addonVersionId = "";
  if (assign.plan) {
    const managed = await createManagedSubscription(db, {
      tenantId,
      status: "active",
      startsAt: new Date(clock.getTime() - 60_000),
      endsAt: null,
      maxLines: 2,
      maxStations: 3,
      maxKiosks: 0,
      maxCabinetUsers: 5,
    });
    subscriptionId = managed.subscriptionId;
    planVersionId = managed.planVersionId;
    if (assign.addon) {
      addonVersionId = await createPublishedAddon(db, [{ entitlementKey: "lines", increment: 2 }]);
      const [addon] = await db
        .insert(schema.subscriptionAddons)
        .values({
          tenantId,
          subscriptionId,
          addonVersionId,
          quantity: 1,
          startsAt: new Date(clock.getTime() - 60_000),
          status: "active",
          source: "manual",
        })
        .returning({ id: schema.subscriptionAddons.id });
      addonId = addon!.id;
    }
  }
  return { admin, tenantId, site, subscriptionId, planVersionId, addonId, addonVersionId };
}

describe.skipIf(!process.env.DATABASE_URL)(
  "offline demo file of a tenant without a cabinet (spec 2026-10-20 §4.2–4.3)",
  () => {
    it("extends the trial without an assignment: every feature, no quotas, no grace, exact journal and audit", async () => {
      const f = await offlineSite();
      const preview = await issuance.preview(f.admin, f.tenantId, f.site.id, {
        graceDays: null,
        offline: null,
        demo: { termDays: 14 },
      });
      const validUntil = new Date(clock.getTime() + 14 * DAY).toISOString();
      expect(preview.next).toEqual({
        sequence: 1,
        source: "offline_demo",
        plan: "demo",
        planVersionId: STANDALONE_DEMO_PLAN_VERSION_ID,
        entitlementRevision: preview.expected.entitlementRevision,
        validFrom: clock.toISOString(),
        validUntil,
        validUntilReason: "demo_term",
        graceDays: 0,
        sourceAssignments: null,
        customer: { name: `Offline tenant ${f.tenantId}`, inn: "7707083893" },
        rights: TRIAL_RIGHTS,
      });
      expect(preview.warnings).toEqual([]);
      expect(preview.expected).toMatchObject({ previousSequence: 0, boundaryAt: null });
      expect(await issuedRows(f.tenantId)).toEqual([]);

      const requestId = randomUUID();
      const file = await issuance.confirm(f.admin, f.tenantId, f.site.id, {
        requestId,
        graceDays: null,
        offline: null,
        demo: { termDays: 14 },
        expected: preview.expected,
      });
      expect(await verifyStandaloneLicense(file.compact, trustedKeyset())).toMatchObject({
        ok: true,
        license: {
          tenantId: f.tenantId,
          siteId: f.site.id,
          plan: "demo",
          planVersionId: STANDALONE_DEMO_PLAN_VERSION_ID,
          graceDays: 0,
          validFrom: clock.getTime(),
          validUntil: clock.getTime() + 14 * DAY,
          quotas: TRIAL_RIGHTS.quotas,
          features: TRIAL_RIGHTS.features,
          replaces: null,
        },
      });
      const [row] = await issuedRows(f.tenantId);
      expect(row).toMatchObject({
        source: "offline_demo",
        plan: "demo",
        graceDays: 0,
        validUntilReason: "demo_term",
        sourceAssignments: null,
        requestId,
      });
      const issued = (await auditRows(db, f.tenantId)).filter(
        (entry) => entry.action === "standalone_license.issued",
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
            source: "offline_demo",
            offlineTerms: null,
            demoTerm: { termDays: 14 },
            sourceAssignments: null,
            plan: "demo",
            planVersionId: STANDALONE_DEMO_PLAN_VERSION_ID,
            entitlementRevision: preview.next.entitlementRevision,
            validFrom: clock.toISOString(),
            validUntil,
            validUntilReason: "demo_term",
            graceDays: 0,
            kid: "test-lic-api",
            sha256: file.sha256,
            customer: { name: `Offline tenant ${f.tenantId}`, inn: "7707083893" },
            quotas: TRIAL_RIGHTS.quotas,
            features: TRIAL_RIGHTS.features,
            warnings: [],
          },
        },
      ]);

      // The same request id replays the same file; the term is part of its terms.
      clock = new Date(clock.getTime() + 60_000);
      expect(
        await issuance.confirm(f.admin, f.tenantId, f.site.id, {
          requestId,
          graceDays: null,
          offline: null,
          demo: { termDays: 14 },
          expected: preview.expected,
        }),
      ).toEqual(file);
      for (const demo of [{ termDays: 30 }, null])
        expect(
          await httpRefusal(
            issuance.confirm(f.admin, f.tenantId, f.site.id, {
              requestId,
              graceDays: null,
              offline: null,
              demo,
              expected: preview.expected,
            }),
          ),
        ).toEqual({ status: 409, body: { code: "standalone_license_request_conflict" } });
      expect(await issuedRows(f.tenantId)).toHaveLength(1);
    });

    it("bridges payment with the rights of the assigned tariff, naming its assignments", async () => {
      const f = await offlineSite({ plan: true, addon: true });
      const preview = await issuance.preview(f.admin, f.tenantId, f.site.id, {
        graceDays: 0,
        offline: null,
        demo: { termDays: 14 },
      });
      const assignments = [
        { kind: "plan", id: f.subscriptionId, catalogVersionId: f.planVersionId },
        { kind: "addon", id: f.addonId, catalogVersionId: f.addonVersionId },
      ];
      expect(preview.next).toMatchObject({
        source: "offline_demo",
        plan: "demo",
        planVersionId: f.planVersionId,
        graceDays: 0,
        validUntil: new Date(clock.getTime() + 14 * DAY).toISOString(),
        validUntilReason: "demo_term",
        sourceAssignments: assignments,
        rights: { quotas: { lines: 4, stations: 3, kiosks: 0, cabinetUsers: 5 } },
      });
      expect(preview.next.entitlementRevision).not.toBe("0");
      expect(preview.warnings).toEqual(
        expect.arrayContaining([{ code: "feature_unmapped", feature: "handheld" }]),
      );
      const file = await issuance.confirm(f.admin, f.tenantId, f.site.id, {
        requestId: randomUUID(),
        graceDays: 0,
        offline: null,
        demo: { termDays: 14 },
        expected: preview.expected,
      });
      expect(await verifyStandaloneLicense(file.compact, trustedKeyset())).toMatchObject({
        ok: true,
        license: {
          plan: "demo",
          planVersionId: f.planVersionId,
          graceDays: 0,
          quotas: { lines: 4, stations: 3, kiosks: 0, cabinetUsers: 5 },
        },
      });
      expect(file.issuance.sourceAssignments).toEqual(assignments);

      // Paid: the subscription file follows with the next sequence and replaces the demo.
      const paid = await issuance.preview(f.admin, f.tenantId, f.site.id, {
        graceDays: null,
        offline: null,
      });
      expect(paid.next).toMatchObject({
        sequence: 2,
        source: "offline_assignments",
        plan: "subscription",
      });
      expect(paid.previous).toMatchObject({ source: "offline_demo", plan: "demo" });
      const subscriptionFile = await issuance.confirm(f.admin, f.tenantId, f.site.id, {
        requestId: randomUUID(),
        graceDays: null,
        offline: null,
        expected: paid.expected,
      });
      expect(subscriptionFile.issuance).toMatchObject({
        sequence: 2,
        replaces: file.issuance.licenseId,
      });
    });

    it("refuses a term outside 1 to 45 days and a grace other than zero, writing nothing", async () => {
      const f = await offlineSite();
      for (const termDays of [0, 46, 1.5, -3])
        for (const call of [
          () =>
            issuance.preview(f.admin, f.tenantId, f.site.id, {
              graceDays: null,
              offline: null,
              demo: { termDays },
            }),
          () =>
            issuance.confirm(f.admin, f.tenantId, f.site.id, {
              requestId: randomUUID(),
              graceDays: null,
              offline: null,
              demo: { termDays },
              expected: {
                entitlementRevision: "0",
                previousSequence: 0,
                boundaryAt: null,
                termsDigest: "a".repeat(64),
              },
            }),
        ])
          expect(await httpRefusal(call())).toEqual({
            status: 400,
            body: { code: "standalone_license_demo_term_invalid" },
          });
      expect(
        await httpRefusal(
          issuance.preview(f.admin, f.tenantId, f.site.id, {
            graceDays: 7,
            offline: null,
            demo: { termDays: 14 },
          }),
        ),
      ).toEqual({ status: 400, body: { code: "standalone_license_grace_invalid" } });
      const edge = await issuance.preview(f.admin, f.tenantId, f.site.id, {
        graceDays: null,
        offline: null,
        demo: { termDays: 45 },
      });
      expect(edge.next.validUntil).toBe(new Date(clock.getTime() + 45 * DAY).toISOString());
      expect(await issuedRows(f.tenantId)).toEqual([]);
    });

    it("refuses a confirmation with another term or after the assignments moved", async () => {
      const f = await offlineSite({ plan: true });
      const preview = await issuance.preview(f.admin, f.tenantId, f.site.id, {
        graceDays: null,
        offline: null,
        demo: { termDays: 14 },
      });
      expect(
        await httpRefusal(
          issuance.confirm(f.admin, f.tenantId, f.site.id, {
            requestId: randomUUID(),
            graceDays: null,
            offline: null,
            demo: { termDays: 30 },
            expected: preview.expected,
          }),
        ),
      ).toEqual({ status: 409, body: { code: "standalone_license_preview_stale" } });
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
            demo: { termDays: 14 },
            expected: preview.expected,
          }),
        ),
      ).toEqual({ status: 409, body: { code: "standalone_license_preview_stale" } });
      expect(await issuedRows(f.tenantId)).toEqual([]);
    });

    it("never gives an offline demo to a tenant with a cabinet", async () => {
      clock = new Date();
      const admin = await platformActor(db);
      const tenantId = await createOrganization(db);
      await createManagedSubscription(db, {
        tenantId,
        status: "active",
        startsAt: new Date(clock.getTime() - 60_000),
        endsAt: new Date(clock.getTime() + 90 * DAY),
        maxLines: 1,
        maxStations: 1,
        maxKiosks: 0,
        maxCabinetUsers: 1,
      });
      await setTenantInns(db, tenantId, { org: "7707083893" });
      const site = await sites.register(admin, tenantId, {
        intent: "create",
        requestId: randomUUID(),
        name: "Облачный цех",
        request: activationRequest({ inn: "7707083893" }),
        acknowledgedWarnings: [],
      });
      expect(
        await httpRefusal(
          issuance.preview(admin, tenantId, site.id, {
            graceDays: null,
            offline: null,
            demo: { termDays: 14 },
          }),
        ),
      ).toEqual({ status: 409, body: { code: "standalone_license_demo_offline_only" } });
      expect(
        await httpRefusal(
          issuance.confirm(admin, tenantId, site.id, {
            requestId: randomUUID(),
            graceDays: null,
            offline: null,
            demo: { termDays: 14 },
            expected: {
              entitlementRevision: "0",
              previousSequence: 0,
              boundaryAt: null,
              termsDigest: "a".repeat(64),
            },
          }),
        ),
      ).toEqual({ status: 409, body: { code: "standalone_license_demo_offline_only" } });
      expect(await issuedRows(tenantId)).toEqual([]);
    });

    it("denies the demo to roles without the license capability", async () => {
      const f = await offlineSite();
      for (const role of ["support", "accountant"] as const) {
        const actor = await platformActor(db, role);
        expect(
          (
            await httpRefusal(
              issuance.preview(actor, f.tenantId, f.site.id, {
                graceDays: null,
                offline: null,
                demo: { termDays: 14 },
              }),
            )
          ).status,
        ).toBe(403);
        expect(
          (
            await httpRefusal(
              issuance.confirm(actor, f.tenantId, f.site.id, {
                requestId: randomUUID(),
                graceDays: null,
                offline: null,
                demo: { termDays: 14 },
                expected: {
                  entitlementRevision: "0",
                  previousSequence: 0,
                  boundaryAt: null,
                  termsDigest: "a".repeat(64),
                },
              }),
            )
          ).status,
        ).toBe(403);
      }
      expect(await issuedRows(f.tenantId)).toEqual([]);
    });
  },
);
