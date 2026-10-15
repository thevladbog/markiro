import { randomUUID, generateKeyPairSync } from "node:crypto";
import {
  ForbiddenException,
  NotFoundException,
  UnprocessableEntityException,
} from "@nestjs/common";
import { createDb, schema } from "@markiro/db";
import { eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { PlatformAuditService } from "../src/platform-auth/platform-audit.service";
import {
  StandaloneDiagnosticsService,
  noPublishedStandaloneBuild,
} from "../src/modules/standalone-diagnostics/standalone-diagnostics.service";
import { createOrganization } from "./support/subscription-fixtures";
import { auditRows, platformActor } from "./support/standalone-license-fixture";
import {
  sealSupportToken,
  supportPayloadV1,
  supportPayloadV2,
  supportText,
} from "./support/standalone-support-token";

const connection = createDb(process.env.DATABASE_URL ?? "postgres://invalid");
const db = connection.db;
const NOW = new Date("2026-10-20T09:00:00.000Z");
const pairA = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const KEYS = [{ kid: "sup-e2e", privateKey: pairA.privateKey }];
const service = new StandaloneDiagnosticsService(
  db,
  new PlatformAuditService(),
  KEYS,
  () => NOW,
  noPublishedStandaloneBuild,
);
afterAll(() => connection.pool.end());

const token = (payload: unknown, compress = true) =>
  sealSupportToken(JSON.stringify(payload), pairA.publicKey, "sup-e2e", compress);
const text = (payload: unknown) => supportText(token(payload));

async function refusal(promise: Promise<unknown>) {
  const error = await promise.then(
    () => null,
    (caught: unknown) => caught,
  );
  if (error === null || typeof error !== "object" || !("getResponse" in error))
    throw new Error("expected an HTTP exception");
  const e = error as { getStatus(): number; getResponse(): unknown };
  return { status: e.getStatus(), body: e.getResponse() };
}

async function bindSite(tenantId: string, hostId: string, adminId: string, history: string[] = []) {
  const id = randomUUID();
  await db.insert(schema.standaloneSites).values({
    id,
    tenantId,
    hostId,
    name: "Цех розлива",
    requestInn: null,
    lastActivationRequest: {},
    hostHistory: [hostId, ...history].map((h) => ({
      hostId: h,
      requestInn: null,
      requestId: randomUUID(),
      boundAt: NOW.toISOString(),
      boundByPlatformUserId: adminId,
    })),
    requestId: randomUUID(),
    createdByPlatformUserId: adminId,
  });
  return id;
}

const rows = (tenantId: string) =>
  db
    .select()
    .from(schema.standaloneSupportDiagnostics)
    .where(eq(schema.standaloneSupportDiagnostics.tenantId, tenantId));

describe.skipIf(!process.env.DATABASE_URL)("standalone diagnostics (plan ДИАГ А2)", () => {
  it("accepts a v2 report: history row, month aggregates and the exact audit row", async () => {
    const admin = await platformActor(db);
    const tenantId = await createOrganization(db);
    const hostId = randomUUID();
    const siteId = await bindSite(tenantId, hostId, admin.userId);
    const payload = supportPayloadV2({ hostId });
    const blob = token(payload);

    const result = await service.ingest(admin, tenantId, { text: supportText(blob) });

    expect(result).toMatchObject({ duplicate: false, monthsApplied: 2, monthsSkipped: 0 });
    expect(result.diagnostic).toMatchObject({
      hostKey: hostId,
      siteId,
      payloadVersion: 2,
      appVersion: "0.2.0",
      hostVersion: "0.2.0",
      pcRole: "host",
      os: "Windows 11",
      arch: "x64",
      webview: "WebView2 130.0.2849.80",
      licenseState: "active",
      generatedAt: "2026-10-14T09:00:00.000Z",
    });
    const [row] = await rows(tenantId);
    expect(row).toMatchObject({
      blobSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
      receivedByPlatformUserId: admin.userId,
      devicesStation: 3,
      devicesOffice: 2,
      devicesHandheld: 1,
    });
    expect(JSON.stringify(row)).not.toContain("MKS1.");
    const months = await db
      .select()
      .from(schema.standaloneSupportUsageMonths)
      .where(eq(schema.standaloneSupportUsageMonths.tenantId, tenantId));
    expect(months.map((m) => m.month).sort()).toEqual(["2026-09", "2026-10"]);
    expect(await auditRows(db, tenantId)).toEqual([
      {
        actorPlatformUserId: admin.userId,
        actorRole: "platform_admin",
        tenantId,
        action: "standalone.diagnostics.ingest",
        outcome: "success",
        targetType: "standalone_support_diagnostic",
        targetId: result.diagnostic.id,
        reason: null,
        requestId: null,
        before: null,
        after: {
          blobSha256: row?.blobSha256,
          kid: "sup-e2e",
          payloadVersion: 2,
          hostKey: hostId,
          siteId,
          generatedAt: "2026-10-14T09:00:00.000Z",
          appVersion: "0.2.0",
          hostVersion: "0.2.0",
          pcRole: "host",
          licenseState: "active",
          monthsApplied: 2,
          monthsSkipped: 0,
          unboundAcknowledged: false,
          textBytes: Buffer.byteLength(supportText(blob), "utf8"),
        },
      },
    ]);
  });

  it("a repeat of the same token, or of the same exact instant in another token, is a duplicate", async () => {
    const admin = await platformActor(db);
    const tenantId = await createOrganization(db);
    const hostId = randomUUID();
    await bindSite(tenantId, hostId, admin.userId);
    const payload = supportPayloadV2({ hostId });
    const text1 = text(payload);
    const first = await service.ingest(admin, tenantId, { text: text1 });
    const again = await service.ingest(admin, tenantId, { text: text1 });
    expect(again).toMatchObject({ duplicate: true, monthsApplied: 0, monthsSkipped: 0 });
    expect(again.diagnostic.id).toBe(first.diagnostic.id);
    const remade = await service.ingest(admin, tenantId, { text: text(payload) });
    expect(remade).toMatchObject({ duplicate: true });
    expect(remade.diagnostic.id).toBe(first.diagnostic.id);
    expect(await rows(tenantId)).toHaveLength(1);
    const audit = await auditRows(db, tenantId);
    expect(audit.map((a) => a.outcome)).toEqual(["success", "duplicate", "duplicate"]);
    expect(audit[1]).toMatchObject({ targetId: first.diagnostic.id, reason: null, before: null });
    // A different instant is a different report.
    const next = await service.ingest(admin, tenantId, {
      text: text(supportPayloadV2({ hostId, generatedAt: "2026-10-14T09:00:01.000Z" })),
    });
    expect(next.duplicate).toBe(false);
  });

  it("two operators pasting the same token at once: one winner, the other a duplicate, no 500", async () => {
    const [one, two] = [await platformActor(db), await platformActor(db)];
    const tenantId = await createOrganization(db);
    const hostId = randomUUID();
    await bindSite(tenantId, hostId, one.userId);
    const body = { text: text(supportPayloadV2({ hostId })) };
    const results = await Promise.all([
      service.ingest(one, tenantId, body),
      service.ingest(two, tenantId, body),
    ]);
    expect(results.map((r) => r.duplicate).sort()).toEqual([false, true]);
    expect(await rows(tenantId)).toHaveLength(1);
  });

  it("an older report sent later does not overwrite fresher months but adds the missing ones", async () => {
    const admin = await platformActor(db);
    const tenantId = await createOrganization(db);
    const hostId = randomUUID();
    await bindSite(tenantId, hostId, admin.userId);
    const fresh = supportPayloadV2({
      hostId,
      generatedAt: "2026-10-14T09:00:00.000Z",
      months: ["2026-09", "2026-10"],
    });
    const older = supportPayloadV2({
      hostId,
      generatedAt: "2026-10-10T09:00:00.000Z",
      months: ["2026-08", "2026-09"],
    });
    await service.ingest(admin, tenantId, { text: text(fresh) });
    const result = await service.ingest(admin, tenantId, { text: text(older) });
    expect(result).toMatchObject({ duplicate: false, monthsApplied: 1, monthsSkipped: 1 });
    const stats = await service.statistics(admin, tenantId, {});
    expect(stats.months.map((m) => m.month)).toEqual(["2026-08", "2026-09", "2026-10"]);
    const [audit] = (await auditRows(db, tenantId)).slice(-1);
    expect(audit?.after).toMatchObject({ monthsApplied: 1, monthsSkipped: 1 });
  });

  it("binding: another tenant's host is refused, an unknown host needs the acknowledgement, a rebound host is found by history", async () => {
    const admin = await platformActor(db);
    const tenantA = await createOrganization(db);
    const tenantB = await createOrganization(db);
    const hostB = randomUUID();
    await bindSite(tenantB, hostB, admin.userId);

    const other = await refusal(
      service.ingest(admin, tenantA, { text: text(supportPayloadV2({ hostId: hostB })) }),
    );
    expect(other.status).toBe(409);
    expect(other.body).toMatchObject({ code: "standalone_diagnostics_host_other_tenant" });
    expect(JSON.stringify(other.body)).not.toContain(tenantB);
    expect(await rows(tenantA)).toHaveLength(0);
    const rejected = await auditRows(db, tenantA);
    expect(rejected).toEqual([
      expect.objectContaining({
        action: "standalone.diagnostics.ingest",
        outcome: "rejected",
        reason: "host_other_tenant",
        targetType: "standalone_support_diagnostic",
        targetId: null,
        actorPlatformUserId: admin.userId,
      }),
    ]);

    const lone = randomUUID();
    const unbound = text(supportPayloadV2({ hostId: lone }));
    expect((await refusal(service.ingest(admin, tenantA, { text: unbound }))).body).toMatchObject({
      code: "standalone_diagnostics_host_unbound",
    });
    const ok = await service.ingest(admin, tenantA, {
      text: unbound,
      acknowledgeUnboundHost: true,
    });
    expect(ok.diagnostic.siteId).toBeNull();
    const accepted = (await auditRows(db, tenantA)).at(-1);
    expect(accepted?.after).toMatchObject({ siteId: null, unboundAcknowledged: true });

    const oldHost = randomUUID();
    const siteId = await bindSite(tenantA, randomUUID(), admin.userId, [oldHost]);
    const viaHistory = await service.ingest(admin, tenantA, {
      text: text(supportPayloadV2({ hostId: oldHost })),
    });
    expect(viaHistory.diagnostic.siteId).toBe(siteId);
  });

  it("a v1 report always needs the acknowledgement; the same token in another tenant is a token_conflict", async () => {
    const admin = await platformActor(db);
    const tenantA = await createOrganization(db);
    const tenantB = await createOrganization(db);
    const v1 = text(supportPayloadV1());
    expect((await refusal(service.ingest(admin, tenantA, { text: v1 }))).body).toMatchObject({
      code: "standalone_diagnostics_host_unbound",
    });
    const stored = await service.ingest(admin, tenantA, { text: v1, acknowledgeUnboundHost: true });
    expect(stored.diagnostic).toMatchObject({
      hostKey: "unknown",
      payloadVersion: 1,
      pcRole: null,
    });
    const conflict = await refusal(
      service.ingest(admin, tenantB, { text: v1, acknowledgeUnboundHost: true }),
    );
    expect(conflict.status).toBe(409);
    expect(conflict.body).toMatchObject({ code: "standalone_diagnostics_token_conflict" });
    expect(await rows(tenantB)).toHaveLength(0);
  });

  it("refuses with the documented statuses and writes only a rejected audit row", async () => {
    const admin = await platformActor(db);
    const tenantId = await createOrganization(db);
    const hostId = randomUUID();
    await bindSite(tenantId, hostId, admin.userId);
    const cases: Array<[string, number, string, string]> = [
      ["без токена", 400, "standalone_diagnostics_no_token", "no_token"],
      [
        text(supportPayloadV2({ hostId, generatedAt: "2026-10-22T09:00:00.000Z" })),
        422,
        "standalone_diagnostics_generated_in_future",
        "generated_in_future",
      ],
      [
        text({ ...supportPayloadV2({ hostId }), extra: 1 }),
        422,
        "standalone_diagnostics_payload_invalid",
        "payload_invalid",
      ],
      [
        supportText(token(supportPayloadV2({ hostId })).replace("sup-e2e", "sup-zzz")),
        422,
        "standalone_diagnostics_unknown_key",
        "unknown_key",
      ],
      ["x".repeat(32_769), 413, "standalone_diagnostics_text_too_large", "text_too_large"],
    ];
    for (const [input, status, code] of cases) {
      const result = await refusal(service.ingest(admin, tenantId, { text: input }));
      expect(result.status).toBe(status);
      expect(result.body).toMatchObject({ code });
    }
    expect(await rows(tenantId)).toHaveLength(0);
    const audit = await auditRows(db, tenantId);
    expect(audit.map((a) => [a.outcome, a.reason])).toEqual(
      cases.map(([, , , reason]) => ["rejected", reason]),
    );
    expect(audit.every((a) => a.targetId === null && a.before === null)).toBe(true);
    expect(audit[3]?.after).toEqual({ textBytes: expect.any(Number), kid: "sup-zzz" });
    expect(audit[0]?.after).toEqual({ textBytes: expect.any(Number) });
  });

  it("answers 409 not_configured without keys and 404 for a missing tenant, before touching the token", async () => {
    const admin = await platformActor(db);
    const tenantId = await createOrganization(db);
    const off = new StandaloneDiagnosticsService(
      db,
      new PlatformAuditService(),
      null,
      () => NOW,
      noPublishedStandaloneBuild,
    );
    const result = await refusal(off.ingest(admin, tenantId, { text: "anything" }));
    expect(result).toMatchObject({
      status: 409,
      body: { code: "standalone_diagnostics_not_configured" },
    });
    expect(await auditRows(db, tenantId)).toEqual([]);
    await expect(service.ingest(admin, randomUUID(), { text: "anything" })).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it("access: write needs the licensing capability, read only tenants.read; sessions re-checked", async () => {
    const admin = await platformActor(db);
    const support = await platformActor(db, "support");
    const unverified = await platformActor(db, "platform_admin", { verified: false });
    const tenantId = await createOrganization(db);
    const hostId = randomUUID();
    await bindSite(tenantId, hostId, admin.userId);
    const body = { text: text(supportPayloadV2({ hostId })) };
    await expect(service.ingest(support, tenantId, body)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    await expect(service.ingest(unverified, tenantId, body)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    await expect(service.ingest(undefined, tenantId, body)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    await service.ingest(admin, tenantId, body);
    expect((await service.history(support, tenantId, {})).items).toHaveLength(1);
    await expect(service.history(unverified, tenantId, {})).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    await db
      .update(schema.platformUsers)
      .set({ status: "suspended" })
      .where(eq(schema.platformUsers.id, support.userId));
    await expect(service.history(support, tenantId, {})).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("reads are tenant-scoped: another tenant's history, overview, statistics and detail are empty or 404", async () => {
    const admin = await platformActor(db);
    const tenantA = await createOrganization(db);
    const tenantB = await createOrganization(db);
    const hostA = randomUUID();
    await bindSite(tenantA, hostA, admin.userId);
    const stored = await service.ingest(admin, tenantA, {
      text: text(supportPayloadV2({ hostId: hostA })),
    });
    expect((await service.history(admin, tenantB, {})).items).toEqual([]);
    expect((await service.overview(admin, tenantB)).hosts).toEqual([]);
    expect((await service.statistics(admin, tenantB, {})).months).toEqual([]);
    await expect(service.detail(admin, tenantB, stored.diagnostic.id)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    const detail = await service.detail(admin, tenantA, stored.diagnostic.id);
    expect(detail.months.map((m) => m.month)).toEqual(["2026-09", "2026-10"]);
    expect(detail.license?.quotas.stations).toEqual({ limit: 3, used: 2, over: false });
  });

  it("overview shows the last report per host, the cloud's newest file and no 'outdated' without a source", async () => {
    const admin = await platformActor(db);
    const tenantId = await createOrganization(db);
    const hostId = randomUUID();
    const siteId = await bindSite(tenantId, hostId, admin.userId);
    await service.ingest(admin, tenantId, {
      text: text(supportPayloadV2({ hostId, generatedAt: "2026-10-10T09:00:00.000Z" })),
    });
    await service.ingest(admin, tenantId, {
      text: text(supportPayloadV2({ hostId, generatedAt: "2026-10-14T09:00:00.000Z" })),
    });
    const overview = await service.overview(admin, tenantId);
    expect(overview.latestPublishedVersion).toBeNull();
    expect(overview.hosts).toHaveLength(1);
    expect(overview.hosts[0]).toMatchObject({
      hostKey: hostId,
      siteId,
      siteName: "Цех розлива",
      outdated: null,
      cloudLicense: null,
      devices: { station: 3, office: 2, handheld: 1 },
      license: { state: "active", sequence: 3 },
      last: { generatedAt: "2026-10-14T09:00:00.000Z" },
    });
    const withSource = new StandaloneDiagnosticsService(
      db,
      new PlatformAuditService(),
      KEYS,
      () => NOW,
      {
        latestPublishedVersion: async () => "0.3.0",
      },
    );
    const compared = await withSource.overview(admin, tenantId);
    expect(compared.latestPublishedVersion).toBe("0.3.0");
    expect(compared.hosts[0]?.outdated).toBe(true);
  });

  it("statistics sum over hosts with a 'several hosts' flag and filter by host and range; gaps stay gaps", async () => {
    const admin = await platformActor(db);
    const tenantId = await createOrganization(db);
    const [h1, h2] = [randomUUID(), randomUUID()];
    await bindSite(tenantId, h1, admin.userId);
    await bindSite(tenantId, h2, admin.userId);
    await service.ingest(admin, tenantId, {
      text: text(supportPayloadV2({ hostId: h1, months: ["2026-08", "2026-10"] })),
    });
    await service.ingest(admin, tenantId, {
      text: text(supportPayloadV2({ hostId: h2, months: ["2026-10"] })),
    });
    const all = await service.statistics(admin, tenantId, {});
    expect(all.multipleHosts).toBe(true);
    expect(all.hosts.sort()).toEqual([h1, h2].sort());
    expect(all.months.map((m) => [m.month, m.hostCount])).toEqual([
      ["2026-08", 1],
      ["2026-10", 2],
    ]);
    expect(all.months[1]?.stats.scans.accepted).toBe(14040);
    const one = await service.statistics(admin, tenantId, { hostKey: h1 });
    expect(one.multipleHosts).toBe(false);
    expect(one.months[1]?.stats.scans.accepted).toBe(7020);
    const ranged = await service.statistics(admin, tenantId, { from: "2026-09", to: "2026-10" });
    expect(ranged.months.map((m) => m.month)).toEqual(["2026-10"]);
  });

  it("history pages by generated instant, newest first, with a cursor", async () => {
    const admin = await platformActor(db);
    const tenantId = await createOrganization(db);
    const hostId = randomUUID();
    await bindSite(tenantId, hostId, admin.userId);
    for (const second of ["01", "02", "03"]) {
      await service.ingest(admin, tenantId, {
        text: text(supportPayloadV2({ hostId, generatedAt: `2026-10-14T09:00:${second}.000Z` })),
      });
    }
    const first = await service.history(admin, tenantId, { limit: "2" });
    expect(first.items.map((i) => i.generatedAt)).toEqual([
      "2026-10-14T09:00:03.000Z",
      "2026-10-14T09:00:02.000Z",
    ]);
    expect(first.nextCursor).not.toBeNull();
    const second = await service.history(admin, tenantId, {
      limit: "2",
      cursor: first.nextCursor ?? "",
    });
    expect(second.items.map((i) => i.generatedAt)).toEqual(["2026-10-14T09:00:01.000Z"]);
    expect(second.nextCursor).toBeNull();
    await expect(service.history(admin, tenantId, { cursor: "AAAA" })).rejects.toBeInstanceOf(
      UnprocessableEntityException,
    );
  });

  it("leaks nothing: neither the token, the payload nor a key in a response, a refusal or the audit", async () => {
    const admin = await platformActor(db);
    const tenantId = await createOrganization(db);
    const hostId = randomUUID();
    await bindSite(tenantId, hostId, admin.userId);
    const blob = token(supportPayloadV2({ hostId }));
    const ok = await service.ingest(admin, tenantId, { text: supportText(blob) });
    const bad = await refusal(
      service.ingest(admin, tenantId, { text: supportText(blob.replace("sup-e2e", "sup-zzz")) }),
    );
    const everything = JSON.stringify([
      ok,
      bad,
      await auditRows(db, tenantId),
      await service.history(admin, tenantId, {}),
    ]);
    expect(everything).not.toContain(blob);
    expect(everything).not.toContain("MKS1.sup-e2e");
    expect(everything).not.toMatch(/PRIVATE KEY/u);
    expect(everything).not.toContain("WebView2 130");
  });

  it("purges reports older than 24 months with their months and keeps the rest", async () => {
    const admin = await platformActor(db);
    const tenantId = await createOrganization(db);
    const hostId = randomUUID();
    await bindSite(tenantId, hostId, admin.userId);
    const kept = await service.ingest(admin, tenantId, {
      text: text(supportPayloadV2({ hostId })),
    });
    const old = await service.ingest(admin, tenantId, {
      text: text(
        supportPayloadV2({ hostId, generatedAt: "2026-10-01T09:00:00.000Z", months: ["2023-01"] }),
      ),
    });
    await db
      .update(schema.standaloneSupportDiagnostics)
      .set({ receivedAt: new Date("2024-10-01T00:00:00.000Z") })
      .where(eq(schema.standaloneSupportDiagnostics.id, old.diagnostic.id));
    const removed = await service.purgeExpired();
    expect(removed).toBeGreaterThanOrEqual(1);
    expect((await rows(tenantId)).map((r) => r.id)).toEqual([kept.diagnostic.id]);
    const stats = await service.statistics(admin, tenantId, {});
    expect(stats.months.map((m) => m.month)).not.toContain("2023-01");
    expect(stats.months.map((m) => m.month)).toContain("2026-10");
  });
});
