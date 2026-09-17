import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { createDb, schema, type Db } from "@markiro/db";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { afterAll, afterEach, beforeAll, expect, vi } from "vitest";
import type { DeviceReplacementReadinessRequest } from "@markiro/platform-contracts";
import { DeviceReplacementService } from "../../src/modules/device-licensing/device-replacement.service";
import { DeviceReplacementReadinessService } from "../../src/modules/device-licensing/device-replacement-readiness.service";
import { DeviceReplacementExecutionService } from "../../src/modules/device-licensing/device-replacement-execution.service";
import { DeviceReplacementExecutionRepairService } from "../../src/modules/device-licensing/device-replacement-execution-repair.service";
import { PlatformAuditService } from "../../src/platform-auth/platform-audit.service";
import { EntitlementsService } from "../../src/subscriptions/entitlements.service";
import { transitionWorkingAssignment } from "../../src/subscriptions/working-device-assignments";
import { seedGrantPolicy } from "./grant-policy-fixture";
import {
  createOrganization,
  createPublishedPlan,
  createManagedSubscription,
} from "./subscription-fixtures";

type DbConnection = ReturnType<typeof createDb>;

export function replacementExecutionHarness(): ReturnType<typeof executionFixtures> & {
  connection: DbConnection;
} {
  const name = `replacement_execution_${randomUUID().replaceAll("-", "_")}`;
  const url = new URL(process.env.DATABASE_URL ?? "postgres://invalid");
  const maintenance = createDb(url.toString());
  url.pathname = `/${name}`;
  const connection: ReturnType<typeof createDb> = createDb(url.toString());
  const db = connection.db;
  let created = false;
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });
  beforeAll(async () => {
    await maintenance.pool.query(`CREATE DATABASE "${name}"`);
    created = true;
    await migrate(db, { migrationsFolder: join(__dirname, "../../../../packages/db/migrations") });
  }, 120_000);
  afterAll(async () => {
    await connection.pool.end();
    if (created) await maintenance.pool.query(`DROP DATABASE "${name}"`);
    await maintenance.pool.end();
  });
  return { ...executionFixtures(db), connection };
}

type Fixture = {
  tenantId: string;
  policy: Awaited<ReturnType<typeof seedGrantPolicy>> | null;
  device: typeof schema.stationDevices.$inferSelect;
  actor: { domain: "cabinet"; id: string };
  prepared: Awaited<ReturnType<DeviceReplacementService["confirm"]>>;
  identity: { tenantId: string; deviceId: string; kind: "station" | "handheld"; apiKeyId: string };
};
type Drain = {
  request: { requestId: string; expectedRevision: number };
  receipt: Awaited<ReturnType<DeviceReplacementReadinessService["requestDrain"]>>;
  intent: NonNullable<Awaited<ReturnType<DeviceReplacementReadinessService["currentIntent"]>>>;
  body: DeviceReplacementReadinessRequest;
};
type Ready = Fixture & { d: Drain; preparation: Fixture["prepared"]["preparation"] };
type ExecutionFixtures = {
  db: Db;
  entitlements: EntitlementsService;
  audit: PlatformAuditService;
  service: DeviceReplacementService;
  readiness: DeviceReplacementReadinessService;
  execution: DeviceReplacementExecutionService;
  repair: DeviceReplacementExecutionRepairService;
  fixture: (
    kind?: "station" | "handheld",
    credentialEpoch?: number,
    configured?: boolean,
    taskBounds?: Parameters<typeof seedGrantPolicy>[1],
  ) => Promise<Fixture>;
  drain: (fixture: Fixture) => Promise<Drain>;
  ready: () => Promise<Ready>;
  preview: (fixture: Ready) => Promise<{
    p: Awaited<ReturnType<DeviceReplacementExecutionService["previewExecution"]>>;
    request: { requestId: string; expectedRevision: number; previewId: string; mode: "normal" };
  }>;
};
function executionFixtures(db: Db): ExecutionFixtures {
  const entitlements = new EntitlementsService(db, "managed_only");
  const audit = new PlatformAuditService();
  const service = new DeviceReplacementService(db, entitlements, audit);
  const readiness = new DeviceReplacementReadinessService(db, entitlements, audit);
  const execution = new DeviceReplacementExecutionService(db, entitlements, audit);
  const repair = new DeviceReplacementExecutionRepairService(db, execution);
  async function fixture(
    kind: "station" | "handheld" = "station",
    credentialEpoch = 1,
    configured = false,
    taskBounds: Parameters<typeof seedGrantPolicy>[1] = {},
  ): Promise<Fixture> {
    const tenantId = await createOrganization(db);
    const policy = configured ? await seedGrantPolicy(db, taskBounds) : null;
    if (policy) {
      const planVersionId = await createPublishedPlan(db, {
        maxLines: 5,
        maxStations: 1,
        maxKiosks: 1,
        maxCabinetUsers: 5,
        lifecyclePolicyId: policy.id,
      });
      await createManagedSubscription(db, { tenantId, planVersionId });
    }
    const id = randomUUID();
    await db.insert(schema.user).values({ id, name: "Owner", email: `${id}@example.invalid` });
    await db.insert(schema.member).values({
      id: randomUUID(),
      organizationId: tenantId,
      userId: id,
      role: "owner",
      createdAt: new Date(),
    });
    const apiKeyId = randomUUID();
    await db.insert(schema.apikey).values({
      id: apiKeyId,
      configId: "station",
      referenceId: tenantId,
      key: "test-digest",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const [device] = await db
      .insert(schema.stationDevices)
      .values({ tenantId, name: "Source", kind, apiKeyId, pairedAt: new Date(), credentialEpoch })
      .returning();
    if (!device) throw new Error("fixture");
    await db.transaction((tx) => transitionWorkingAssignment(tx, device));
    const actor = { domain: "cabinet" as const, id };
    const preview = await service.preview(
      tenantId,
      device.id,
      { requestId: randomUUID(), target: { name: "Target", kind }, reason: "replace" },
      actor,
    );
    const prepared = await service.confirm(
      tenantId,
      device.id,
      { requestId: preview.requestId, previewId: preview.id },
      actor,
    );
    return {
      tenantId,
      policy,
      device,
      actor,
      prepared,
      identity: { tenantId, deviceId: device.id, kind, apiKeyId },
    };
  }
  async function drain(f: Fixture): Promise<Drain> {
    await readiness.currentIntentProjection(f.identity, undefined, "replacement-readiness-v1");
    const request = { requestId: randomUUID(), expectedRevision: 1 };
    const receipt = await readiness.requestDrain(
      f.tenantId,
      f.prepared.preparation.id,
      request,
      f.actor,
    );
    const intent = await readiness.currentIntent(f.identity, "replacement-readiness-v1");
    if (!intent) throw new Error("intent missing");
    const body: DeviceReplacementReadinessRequest = {
      requestId: randomUUID(),
      intentId: intent.intentId,
      credentialEpoch: f.device.credentialEpoch,
      reportSequence: 0,
      clientBuild: "test-v1",
      storageRevision: 1,
      pending: {
        scans: 0,
        inventories: 0,
        shiftClosures: 0,
        productLabels: 0,
        boxes: 0,
        exceptions: 0,
      },
      conflicts: 0,
      unknownPrints: 0,
      activeTasks: [],
      installedGrants: [],
      journal: { digest: "a".repeat(64), highestSequence: 0 },
    };
    return { request, receipt, intent, body };
  }

  async function ready(): Promise<Ready> {
    const f = await fixture();
    const d = await drain(f);
    expect((await readiness.report(f.identity, d.body)).eligibility.status).toBe("eligible");
    const preparation = (await service.list(f.tenantId, f.actor)).items[0]!.preparation;
    return { ...f, d, preparation };
  }
  async function preview(f: Ready) {
    const request = { requestId: randomUUID(), expectedRevision: f.preparation.revision };
    const p = await execution.previewExecution(f.tenantId, f.preparation.id, request, f.actor);
    return { p, request: { ...request, previewId: p.id, mode: "normal" as const } };
  }
  return {
    db,
    entitlements,
    audit,
    service,
    readiness,
    execution,
    repair,
    fixture,
    drain,
    ready,
    preview,
  };
}
