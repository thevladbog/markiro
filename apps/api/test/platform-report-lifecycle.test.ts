import { randomUUID, createHash } from "node:crypto";
import { createDb, schema } from "@markiro/db";
import {
  platformCapabilitiesForRole,
  type PlatformPrincipal,
  type PlatformReportInput,
} from "@markiro/platform-contracts";
import { and, eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { PlatformReportsService } from "../src/platform-reports/platform-reports.service";
import { PlatformReportRunnerService } from "../src/platform-reports/platform-report-runner.service";
import { PlatformAuditService } from "../src/platform-auth/platform-audit.service";
import {
  PlatformReportSourceService,
  PlatformReportSourceBusyError,
} from "../src/platform-reports/report-source.service";
import { ObjectStorageService } from "../src/modules/storage/object-storage.service";
import { loadEnv } from "../src/env";
import { PLATFORM_TEST_ENV } from "./support/platform-test-env";
import { Test } from "@nestjs/testing";
import { Reflector } from "@nestjs/core";
import request from "supertest";
import { PlatformReportsController } from "../src/platform-reports/platform-reports.controller";
import { PlatformAuthGuard } from "../src/platform-auth/platform-auth.guard";
import { listenOnLoopback } from "./support/listen-loopback";

const url = process.env.DATABASE_URL;
const local = url && ["localhost", "127.0.0.1"].includes(new URL(url).hostname);
describe.skipIf(!local)("platform report durable lifecycle", () => {
  const { db, pool } = createDb(url ?? "postgres://localhost/unavailable");
  const tenant = `report-life-${randomUUID()}`;
  const userId = `report-life-${randomUUID()}`;
  const otherId = `report-life-${randomUUID()}`;
  const principal: PlatformPrincipal = {
    userId,
    role: "platform_admin",
    capabilities: [...platformCapabilitiesForRole.platform_admin],
    twoFactorReady: true,
  };
  const input: PlatformReportInput = {
    reportType: "shifts",
    tenantIds: [tenant],
    fromDate: "2026-09-01",
    toDate: "2026-09-01",
    timezone: "Europe/Moscow",
    periodBasis: "events",
    privacy: "identified",
  };
  const audit = new PlatformAuditService();
  const source = new PlatformReportSourceService(db);
  const objects = new Map<string, { body: Buffer; sha256: string }>();
  const send = vi.fn(
    async (command: {
      constructor: { name: string };
      input: { Key: string; Body?: Buffer; Metadata?: { sha256: string } };
    }) => {
      const key = command.input.Key;
      if (command.constructor.name === "PutObjectCommand") {
        objects.set(key, { body: command.input.Body!, sha256: command.input.Metadata!.sha256 });
        return {};
      }
      if (command.constructor.name === "DeleteObjectCommand") {
        objects.delete(key);
        return {};
      }
      const object = objects.get(key);
      if (!object) throw Object.assign(new Error("missing"), { name: "NotFound" });
      return { ContentLength: object.body.length, Metadata: { sha256: object.sha256 } };
    },
  );
  const presign = vi.fn(async () => "https://private.example.invalid/download");
  const storage = new ObjectStorageService(
    loadEnv({
      ...PLATFORM_TEST_ENV,
      DATABASE_URL: url,
      BETTER_AUTH_SECRET: "test-placeholder",
      BETTER_AUTH_URL: "http://localhost:3000",
      PAIRING_CODE_PEPPER: "test-placeholder",
    }),
    { send } as never,
    presign,
  );
  const wake = {
    wakePlatformReports: vi.fn(async () => {
      throw new Error("queue unavailable");
    }),
  };
  const service = new PlatformReportsService(db, audit, storage, wake as never);
  const runner = new PlatformReportRunnerService(db, source, storage, audit);
  const create = (parameters = input) =>
    service.create(principal, { ...parameters, idempotencyKey: randomUUID() });
  it("does not let a full batch of deletion failures starve later expired reports", async () => {
    const ids = Array.from({ length: 101 }, () => randomUUID());
    await db.insert(schema.platformReports).values(
      ids.map((id, index) => ({
        id,
        createdByPlatformUserId: userId,
        parameters: input,
        idempotencyKey: randomUUID(),
        expiresAt: new Date("2000-01-01"),
        updatedAt: new Date(index < 100 ? "2000-01-01" : "2001-01-01"),
      })),
    );
    const realDelete = storage.deleteConfirmed.bind(storage);
    const poisoned = new Set<string>(ids.slice(0, 100));
    const spy = vi.spyOn(storage, "deleteConfirmed").mockImplementation(async (key) => {
      if (poisoned.has(key.split("/")[1]!)) throw new Error("unavailable");
      await realDelete(key);
    });
    try {
      await runner.reconcile();
      await runner.reconcile();
      const [row] = await db
        .select()
        .from(schema.platformReports)
        .where(eq(schema.platformReports.id, ids[100]!));
      expect(row?.status).toBe("expired");
    } finally {
      spy.mockRestore();
      await db.delete(schema.platformReports).where(inArray(schema.platformReports.id, ids));
    }
  });
  beforeAll(async () => {
    await db
      .insert(schema.organization)
      .values({ id: tenant, name: "Lifecycle", slug: tenant, createdAt: new Date() });
    await db.insert(schema.platformUsers).values(
      [userId, otherId].map((id) => ({
        id,
        name: "Test",
        email: `${id}@example.invalid`,
        role: "platform_admin" as const,
        status: "active",
        twoFactorEnabled: true,
      })),
    );
    await db.insert(schema.platformTwoFactors).values(
      [userId, otherId].map((id) => ({
        id: randomUUID(),
        userId: id,
        secret: "fixture",
        backupCodes: "fixture",
        verified: true,
      })),
    );
  });
  afterAll(async () => {
    await db
      .delete(schema.platformReports)
      .where(inArray(schema.platformReports.createdByPlatformUserId, [userId, otherId]));
    // Audit is append-only; retain its synthetic actor and tenant references.
    await pool.end();
  });
  it("enforces the actual platform guard at report HTTP routes for missing/tenant/device and downgraded identities", async () => {
    const module = await Test.createTestingModule({
      controllers: [PlatformReportsController],
      providers: [{ provide: PlatformReportsService, useValue: service }],
    }).compile();
    const app = module.createNestApplication();
    const auth = {
      api: {
        getSession: async ({ headers }: { headers: Headers }) =>
          headers.get("cookie") === "fixture=platform" ? { user: { id: userId } } : null,
      },
    };
    app.use(
      (
        req: { headers: Record<string, string>; authKind?: string },
        _res: unknown,
        next: () => void,
      ) => {
        if (req.headers["x-test-domain"]) req.authKind = req.headers["x-test-domain"];
        next();
      },
    );
    app.useGlobalGuards(new PlatformAuthGuard(new Reflector(), auth as never, db, audit));
    await app.init();
    await listenOnLoopback(app);
    try {
      await request(app.getHttpServer()).get("/platform/reports").expect(401);
      for (const domain of ["session", "station"])
        await request(app.getHttpServer())
          .get("/platform/reports")
          .set("Cookie", "fixture=platform")
          .set("x-test-domain", domain)
          .expect(403);
      await request(app.getHttpServer())
        .get("/platform/reports")
        .set("Cookie", "fixture=platform")
        .expect(200);
      await request(app.getHttpServer())
        .post("/platform/reports")
        .set("Cookie", "fixture=platform")
        .send({ ...input, idempotencyKey: randomUUID(), lineId: randomUUID() })
        .expect(400);
      await db
        .update(schema.platformUsers)
        .set({ role: "support" })
        .where(eq(schema.platformUsers.id, userId));
      await request(app.getHttpServer())
        .get("/platform/reports")
        .set("Cookie", "fixture=platform")
        .expect(403);
      await request(app.getHttpServer())
        .get("/platform/reports/options")
        .query({ tenantIds: tenant, kind: "operators" })
        .set("Cookie", "fixture=platform")
        .expect(403);
    } finally {
      await db
        .update(schema.platformUsers)
        .set({ role: "platform_admin" })
        .where(eq(schema.platformUsers.id, userId));
      await app.close();
    }
  });
  it("returns deterministic selected-tenant options with explicit overflow and no private fields", async () => {
    const ids = [randomUUID(), randomUUID()];
    await db
      .insert(schema.lines)
      .values(ids.map((id) => ({ id, tenantId: tenant, name: "Option needle" })));
    try {
      const first = await service.options(principal, {
        tenantIds: tenant,
        kind: "lines",
        search: "needle",
        limit: 1,
        offset: 0,
      });
      expect(first.nextOffset).toBe(1);
      expect(first.items).toEqual([
        { id: [...ids].sort()[0], tenantId: tenant, name: "Option needle" },
      ]);
      const second = await service.options(principal, {
        tenantIds: tenant,
        kind: "lines",
        search: "needle",
        limit: 1,
        offset: 1,
      });
      expect(second.nextOffset).toBe(null);
      expect(second.items).toEqual([
        { id: [...ids].sort()[1], tenantId: tenant, name: "Option needle" },
      ]);
      await expect(
        service.options(principal, { tenantIds: ["missing"], kind: "lines" }),
      ).rejects.toMatchObject({ status: 400 });
    } finally {
      await db.delete(schema.lines).where(inArray(schema.lines.id, ids));
    }
  });
  it("revalidates creator permissions before generation and download even for an old principal", async () => {
    const report = await create();
    const ready = await create();
    await runner.run(ready.id);
    await db
      .update(schema.platformUsers)
      .set({ role: "support" })
      .where(eq(schema.platformUsers.id, userId));
    try {
      await runner.run(report.id);
      const [row] = await db
        .select()
        .from(schema.platformReports)
        .where(eq(schema.platformReports.id, report.id));
      expect(row).toMatchObject({ status: "failed", errorCode: "REPORT_PERMISSION_REVOKED" });
      await expect(service.download(principal, ready.id)).rejects.toMatchObject({ status: 403 });
      await expect(
        service.options(principal, { tenantIds: [tenant], kind: "operators" }),
      ).rejects.toMatchObject({ status: 403 });
    } finally {
      await db
        .update(schema.platformUsers)
        .set({ role: "platform_admin" })
        .where(eq(schema.platformUsers.id, userId));
    }
  });
  it("fences an expired worker after another attempt publishes", async () => {
    const report = await create();
    const realLoad = source.load.bind(source);
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const spy = vi.spyOn(source, "load").mockImplementationOnce(async (parameters) => {
      entered();
      await gate;
      return realLoad(parameters);
    });
    const stale = runner.run(report.id);
    await started;
    await db
      .update(schema.platformReports)
      .set({ leaseExpiresAt: new Date(Date.now() - 1000) })
      .where(eq(schema.platformReports.id, report.id));
    await runner.run(report.id);
    release();
    await stale;
    spy.mockRestore();
    const [row] = await db
      .select()
      .from(schema.platformReports)
      .where(eq(schema.platformReports.id, report.id));
    expect(row).toMatchObject({ status: "ready", attemptCount: 2 });
    expect(row?.artifactObjectKey).toContain("attempt-2/report.zip");
    expect(objects.has(row!.artifactObjectKey!)).toBe(true);
    expect(objects.has(`platform-reports/${report.id}/attempt-1/report.zip`)).toBe(false);
  });
  it("uses different fencing leases when busy reuses the attempt number in the same millisecond", async () => {
    const report = await create();
    const leases: number[] = [];
    const spy = vi.spyOn(source, "load").mockImplementation(async () => {
      const [row] = await db
        .select()
        .from(schema.platformReports)
        .where(eq(schema.platformReports.id, report.id));
      leases.push(row!.leaseExpiresAt!.getTime());
      throw new PlatformReportSourceBusyError();
    });
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      await runner.run(report.id);
      await runner.run(report.id);
    } finally {
      vi.useRealTimers();
      spy.mockRestore();
    }
    expect(leases).toHaveLength(2);
    expect(leases[0]).not.toBe(leases[1]);
  });
  it("retains a late stale upload for deterministic expiry cleanup without touching winner", async () => {
    const report = await create();
    const realPut = storage.putVerified.bind(storage);
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const spy = vi.spyOn(storage, "putVerified").mockImplementationOnce(async (...args) => {
      entered();
      await gate;
      return realPut(...args);
    });
    const stale = runner.run(report.id);
    await started;
    await db
      .update(schema.platformReports)
      .set({ leaseExpiresAt: new Date(Date.now() - 1000) })
      .where(eq(schema.platformReports.id, report.id));
    await runner.run(report.id);
    release();
    await stale;
    spy.mockRestore();
    const [row] = await db
      .select()
      .from(schema.platformReports)
      .where(eq(schema.platformReports.id, report.id));
    expect(row?.artifactObjectKey).toContain("attempt-2/report.zip");
    expect(objects.has(row!.artifactObjectKey!)).toBe(true);
    await db
      .update(schema.platformReports)
      .set({ expiresAt: new Date(Date.now() - 1) })
      .where(eq(schema.platformReports.id, report.id));
    await runner.reconcile();
    expect(objects.has(`platform-reports/${report.id}/attempt-1/report.zip`)).toBe(false);
    expect(objects.has(row!.artifactObjectKey!)).toBe(false);
  });
  it("commits idempotent intent, tenant links and exact audit despite a failed queue wake", async () => {
    const body = { ...input, idempotencyKey: randomUUID() };
    const report = await service.create(principal, body);
    expect(report.status).toBe("queued");
    expect((await service.create(principal, body)).id).toBe(report.id);
    await expect(
      service.create(principal, { ...body, privacy: "aggregate" }),
    ).rejects.toMatchObject({ status: 409 });
    expect(
      await db
        .select()
        .from(schema.platformReportTenants)
        .where(eq(schema.platformReportTenants.reportId, report.id)),
    ).toEqual([{ reportId: report.id, tenantId: tenant }]);
    const events = await db
      .select()
      .from(schema.platformAuditEvents)
      .where(eq(schema.platformAuditEvents.targetId, report.id));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      actorPlatformUserId: userId,
      actorRole: "platform_admin",
      action: "platform.report.created",
      outcome: "success",
      targetType: "platform_report",
      tenantId: tenant,
      after: { tenantIds: [tenant] },
    });
  });
  it("rejects forged tenant filters and inactive current identities", async () => {
    await expect(create({ ...input, lineId: randomUUID() })).rejects.toMatchObject({ status: 400 });
    await expect(create({ ...input, tenantIds: ["missing-tenant"] })).rejects.toMatchObject({
      status: 400,
    });
    await db
      .update(schema.platformUsers)
      .set({ status: "suspended" })
      .where(eq(schema.platformUsers.id, userId));
    await expect(create()).rejects.toMatchObject({ status: 403 });
    await db
      .update(schema.platformUsers)
      .set({ status: "active" })
      .where(eq(schema.platformUsers.id, userId));
  });
  it("replays committed intent after its operator is deleted and compares mismatches before mutable filters", async () => {
    const operatorId = randomUUID();
    await db
      .insert(schema.employees)
      .values({ id: operatorId, tenantId: tenant, fullName: "Deleted filter" });
    const body = { ...input, operatorId, idempotencyKey: randomUUID() };
    const first = await service.create(principal, body);
    await db.delete(schema.employees).where(eq(schema.employees.id, operatorId));
    await expect(service.create(principal, body)).resolves.toMatchObject({
      id: first.id,
      parameters: { operatorId },
    });
    await expect(
      service.create(principal, { ...body, lineId: randomUUID() }),
    ).rejects.toMatchObject({ status: 409 });
    const events = await db
      .select()
      .from(schema.platformAuditEvents)
      .where(eq(schema.platformAuditEvents.targetId, first.id));
    expect(events).toHaveLength(1);
  });
  it("keeps the original completion timestamp across repeated expiry cleanup", async () => {
    const report = await create();
    await runner.run(report.id);
    const completedAt = new Date("2026-09-01T00:00:00Z");
    await db
      .update(schema.platformReports)
      .set({ completedAt, expiresAt: new Date(Date.now() - 1000) })
      .where(eq(schema.platformReports.id, report.id));
    await runner.reconcile();
    await runner.reconcile();
    const [row] = await db
      .select()
      .from(schema.platformReports)
      .where(eq(schema.platformReports.id, report.id));
    expect(row?.status).toBe("expired");
    expect(row?.completedAt).toEqual(completedAt);
  });
  it("preserves pseudonymous operator filters for authorized retry and redacts them without the identified capability", async () => {
    const operatorId = randomUUID();
    await db
      .insert(schema.employees)
      .values({ id: operatorId, tenantId: tenant, fullName: "Private operator" });
    try {
      const parameters = { ...input, privacy: "pseudonymous" as const, operatorId };
      const created = await create(parameters);
      expect(created.parameters).toEqual(parameters);
      const history = await service.list(principal, { limit: 100, offset: 0 });
      expect(history.items.find((row) => row.id === created.id)?.parameters).toEqual(parameters);
      const repeated = await create(created.parameters);
      expect(repeated.id).not.toBe(created.id);
      expect(repeated.parameters).toEqual(parameters);
      const lower = await service.list(
        {
          ...principal,
          capabilities: principal.capabilities.filter(
            (capability) => capability !== "reports.identified",
          ),
        },
        { limit: 100, offset: 0 },
      );
      expect(lower.items.find((row) => row.id === created.id)?.parameters).not.toHaveProperty(
        "operatorId",
      );
    } finally {
      await db.delete(schema.employees).where(eq(schema.employees.id, operatorId));
    }
  });
  it("publishes verified ZIP and checksum; scopes history/download to creator and clamps retention", async () => {
    const report = await create();
    await runner.run(report.id);
    const [row] = await db
      .select()
      .from(schema.platformReports)
      .where(eq(schema.platformReports.id, report.id));
    expect(row?.status).toBe("ready");
    const object = objects.get(row!.artifactObjectKey!);
    expect(row?.artifactChecksum).toBe(createHash("sha256").update(object!.body).digest("hex"));
    expect(await service.list({ ...principal, userId: otherId }, { limit: 50, offset: 0 })).toEqual(
      { items: [], nextOffset: null },
    );
    await expect(
      service.download({ ...principal, userId: otherId }, report.id),
    ).rejects.toMatchObject({ status: 404 });
    await db
      .update(schema.platformReports)
      .set({ expiresAt: new Date(Date.now() + 50_000) })
      .where(eq(schema.platformReports.id, report.id));
    const download = await service.download(principal, report.id);
    expect(download.expiresInSeconds).toBeGreaterThan(0);
    expect(download.expiresInSeconds).toBeLessThanOrEqual(50);
    const events = await db
      .select()
      .from(schema.platformAuditEvents)
      .where(
        and(
          eq(schema.platformAuditEvents.targetId, report.id),
          eq(schema.platformAuditEvents.action, "platform.report.downloaded"),
        ),
      );
    expect(events[0]).toMatchObject({
      actorPlatformUserId: userId,
      outcome: "success",
      tenantId: tenant,
      targetType: "platform_report",
      after: { tenantIds: [tenant] },
    });
    await db
      .update(schema.platformReports)
      .set({ expiresAt: new Date(Date.now() - 1) })
      .where(eq(schema.platformReports.id, report.id));
    await expect(service.download(principal, report.id)).rejects.toMatchObject({ status: 410 });
    await runner.reconcile();
    expect(objects.has(row!.artifactObjectKey!)).toBe(false);
  });
  it("defers source contention without consuming attempts and recovers on scheduled reconciliation", async () => {
    const report = await create();
    const spy = vi.spyOn(source, "load").mockRejectedValueOnce(new PlatformReportSourceBusyError());
    await runner.run(report.id);
    const [row] = await db
      .select()
      .from(schema.platformReports)
      .where(eq(schema.platformReports.id, report.id));
    expect(row).toMatchObject({ status: "queued", attemptCount: 0, leaseExpiresAt: null });
    spy.mockRestore();
    await runner.reconcile();
    const [done] = await db
      .select()
      .from(schema.platformReports)
      .where(eq(schema.platformReports.id, report.id));
    expect(done?.status).toBe("ready");
  });
  it("exhausts three failures with safe code and exact failure audit", async () => {
    const report = await create();
    const spy = vi.spyOn(source, "load").mockRejectedValue(new Error("sql secret"));
    for (let i = 0; i < 4; i++) await runner.run(report.id);
    spy.mockRestore();
    const [row] = await db
      .select()
      .from(schema.platformReports)
      .where(eq(schema.platformReports.id, report.id));
    expect(row).toMatchObject({
      status: "failed",
      attemptCount: 3,
      errorCode: "REPORT_GENERATION_FAILED",
    });
    expect(JSON.stringify(row)).not.toContain("sql secret");
    const events = await db
      .select()
      .from(schema.platformAuditEvents)
      .where(
        and(
          eq(schema.platformAuditEvents.targetId, report.id),
          eq(schema.platformAuditEvents.action, "platform.report.failed"),
        ),
      );
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      actorPlatformUserId: userId,
      targetType: "platform_report",
      tenantId: tenant,
      outcome: "failure",
      reason: "REPORT_GENERATION_FAILED",
      after: { tenantIds: [tenant] },
    });
  });
  it("preserves a published object when the ready commit response is lost", async () => {
    const report = await create();
    const realUpdate = db.update.bind(db);
    const spy = vi.spyOn(db, "update").mockImplementation((table) => {
      const builder = realUpdate(table);
      const realSet = builder.set.bind(builder);
      vi.spyOn(builder, "set").mockImplementation((values) => {
        const query = realSet(values);
        if (table === schema.platformReports && "status" in values && values.status === "ready") {
          const execute = query.execute.bind(query);
          vi.spyOn(query, "execute").mockImplementation(async (...args) => {
            await execute(...args);
            throw new Error("ready commit response lost");
          });
        }
        return query;
      });
      return builder;
    });
    try {
      await runner.run(report.id);
    } finally {
      spy.mockRestore();
    }
    const [row] = await db
      .select()
      .from(schema.platformReports)
      .where(eq(schema.platformReports.id, report.id));
    expect(row?.status).toBe("ready");
    expect(objects.has(row!.artifactObjectKey!)).toBe(true);
    await expect(service.download(principal, report.id)).resolves.toHaveProperty("url");
  });
  it("retries confirmed deletion after a storage outage without clearing a ready artifact pointer", async () => {
    const report = await create();
    await runner.run(report.id);
    await db
      .update(schema.platformReports)
      .set({ expiresAt: new Date(Date.now() - 1) })
      .where(eq(schema.platformReports.id, report.id));
    const realDelete = storage.deleteConfirmed.bind(storage);
    const spy = vi.spyOn(storage, "deleteConfirmed").mockImplementation(async (key) => {
      if (key.includes(report.id)) throw new Error("storage unavailable");
      await realDelete(key);
    });
    await runner.reconcile();
    spy.mockRestore();
    const [pending] = await db
      .select()
      .from(schema.platformReports)
      .where(eq(schema.platformReports.id, report.id));
    expect(pending?.status).toBe("ready");
    expect(pending?.artifactObjectKey).not.toBeNull();
    await runner.reconcile();
    const [expired] = await db
      .select()
      .from(schema.platformReports)
      .where(eq(schema.platformReports.id, report.id));
    expect(expired).toMatchObject({ status: "expired", artifactObjectKey: null });
    expect(objects.has(pending!.artifactObjectKey!)).toBe(false);
  });
});
