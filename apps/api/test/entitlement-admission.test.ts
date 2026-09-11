import { randomUUID } from "node:crypto";
import { createDb, schema } from "@markiro/db";
import { eq, sql } from "drizzle-orm";
import { Logger } from "@nestjs/common";
import { afterAll, describe, expect, it, vi } from "vitest";
import type { EntitlementSnapshotV1 } from "@markiro/platform-contracts";
import { EntitlementsService } from "../src/subscriptions/entitlements.service";
import {
  EntitlementAdmissionService,
  admissionScopeDigest,
} from "../src/subscriptions/entitlement-admission.service";
import { projectEntitlements } from "../src/subscriptions/entitlement-projection";
import {
  createManagedSubscription,
  createOrganization,
  createPublishedPlan,
} from "./support/subscription-fixtures";
import { entitlementDigest } from "../src/subscriptions/entitlement-snapshot-reader";

const connection = createDb(process.env.DATABASE_URL ?? "postgres://invalid");
afterAll(() => connection.pool.end());
function snapshot(tenantId: string): EntitlementSnapshotV1 {
  const startsAt = new Date(Date.now() - 60_000);
  const endsAt = new Date(Date.now() + 60_000);
  const features = { labelEditor: false, publicApi: false, pallets: false };
  const quotas = { lines: 1, stations: 1, kiosks: 1, cabinetUsers: 1 };
  const id = randomUUID(),
    versionId = randomUUID();
  return projectEntitlements({
    current: {
      tenantId,
      access: "managed",
      quotas,
      features,
      subscription: { id, planVersionId: versionId, status: "active", startsAt, endsAt },
    },
    sources: [
      {
        id,
        versionId,
        kind: "plan",
        prepared: false,
        startsAt: startsAt.toISOString(),
        endsAt: endsAt.toISOString(),
        effects: [],
        operationIds: [],
        plan: {
          quotas,
          features: {
            ...features,
            chzIntegration: false,
            inventory: true,
            commerceMl: false,
            handheld: false,
          },
        },
      },
      {
        id: randomUUID(),
        versionId: randomUUID(),
        kind: "compatibility",
        prepared: true,
        startsAt: startsAt.toISOString(),
        endsAt: endsAt.toISOString(),
        effects: [{ key: "chzIntegration", featureEnabled: true }],
        operationIds: ["nk.lookup.v1"],
      },
    ],
    at: new Date(),
    usage: { lines: 0, stations: 0, kiosks: 0, cabinetUsers: 0 },
    enforcementMode: "managed_only",
    revision: "11",
    usageRevision: "12",
    boundaries: [],
    readinessReasons: [],
  });
}
describe.skipIf(!process.env.DATABASE_URL)("shadow admission", () => {
  async function fixture() {
    const tenantId = await createOrganization(connection.db);
    const entitlements = new EntitlementsService(connection.db, "managed_only");
    const resolve = entitlements.resolveSnapshotInTransaction.bind(entitlements);
    const resolver = vi
      .spyOn(entitlements, "resolveSnapshotInTransaction")
      .mockImplementation(async (id, tx) => ({
        ...(await resolve(id, tx)),
        snapshot: snapshot(id),
      }));
    const service = new EntitlementAdmissionService(connection.db, entitlements);
    const input = {
      tenantId,
      actor: { domain: "cabinet" as const, id: randomUUID() },
      operationId: "nk.lookup.v1" as const,
      scopeDigest: admissionScopeDigest({ productId: randomUUID() }),
      runtime: { enabled: true, observedAt: new Date() },
    };
    return { service, input, resolver };
  }
  async function realFixture() {
    const platformUserId = randomUUID();
    await connection.db.insert(schema.platformUsers).values({
      id: platformUserId,
      email: `${platformUserId}@example.invalid`,
      name: "Admission fixture",
      role: "platform_admin",
      status: "active",
    });
    const policyId = randomUUID();
    const payload = { stage: "draft" };
    await connection.db.insert(schema.entitlementLifecyclePolicies).values({
      id: policyId,
      policyKey: policyId,
      version: 1,
      payload,
      payloadHash: entitlementDigest(payload),
      createdByPlatformUserId: platformUserId,
    });
    const planVersionId = await createPublishedPlan(connection.db, {
      maxLines: 2,
      maxStations: 2,
      maxKiosks: 1,
      maxCabinetUsers: 1,
      lifecyclePolicyId: policyId,
    });
    const managed = await createManagedSubscription(connection.db, { planVersionId });
    const sourceId = randomUUID();
    const sourceVersionId = randomUUID();
    await connection.db.insert(schema.entitlementSources).values({
      id: sourceId,
      versionId: sourceVersionId,
      tenantId: managed.tenantId,
      subscriptionId: managed.subscriptionId,
      kind: "compatibility",
      effects: [{ key: "chzIntegration", featureEnabled: true }],
      operationIds: ["nk.lookup.v1"],
      startsAt: new Date(Date.now() - 60_000),
      endsAt: new Date(Date.now() + 600_000),
      reason: "Synthetic NK compatibility proof",
      decisionReference: "TEST-ONLY-NK",
      requestId: randomUUID(),
      createdByPlatformUserId: platformUserId,
    });
    const entitlements = new EntitlementsService(connection.db, "managed_only");
    const service = new EntitlementAdmissionService(connection.db, entitlements);
    const input = {
      tenantId: managed.tenantId,
      actor: { domain: "cabinet" as const, id: randomUUID() },
      operationId: "nk.lookup.v1" as const,
      scopeDigest: admissionScopeDigest({ productId: randomUUID() }),
      runtime: { enabled: true, observedAt: new Date() },
    };
    return { ...managed, policyId, sourceId, sourceVersionId, service, input };
  }
  it("resolves real legacy mapping and immutable NK compatibility without allowing fresh CHZ export", async () => {
    const { service, input, sourceId, sourceVersionId } = await realFixture();
    const facts = await service.capture(input.tenantId);
    expect(facts.snapshot?.candidate.features.inventory).toBeNull();
    expect(facts.snapshot?.sources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: sourceId,
          versionId: sourceVersionId,
          kind: "compatibility",
          prepared: true,
          operationIds: ["nk.lookup.v1"],
        }),
      ]),
    );
    await connection.db.transaction(async (tx) => {
      expect(await service.observe({ ...input, facts, transaction: tx })).toMatchObject({
        decision: "allow",
      });
      expect(
        await service.observe({
          ...input,
          facts,
          transaction: tx,
          operationId: "chz.export.create.v1",
        }),
      ).toMatchObject({ decision: "unknown" });
      expect(
        await service.observe({
          ...input,
          facts,
          transaction: tx,
          operationId: "inventory.file.create.v1",
        }),
      ).toMatchObject({ decision: "unknown" });
    });
    const [source] = await connection.db
      .select()
      .from(schema.entitlementSources)
      .where(eq(schema.entitlementSources.id, sourceId));
    expect(source).toMatchObject({
      versionId: sourceVersionId,
      prepared: true,
      revokedAt: null,
      effects: [{ key: "chzIntegration", featureEnabled: true }],
      operationIds: ["nk.lookup.v1"],
    });
  });
  it.each(["usage", "catalog", "policy"] as const)(
    "invalidates owner admission on independent %s drift with real captured facts",
    async (change) => {
      const { service, input, planVersionId, policyId } = await realFixture();
      const facts = await service.capture(input.tenantId);
      expect(facts.snapshot).not.toBeNull();
      if (!facts.snapshot) throw new Error("Missing real captured snapshot");
      expect(facts.versionIds).toContain(planVersionId);
      if (change === "usage") {
        await connection.db
          .insert(schema.lines)
          .values({ tenantId: input.tenantId, name: "New usage" });
      } else if (change === "catalog") {
        await connection.db
          .update(schema.catalogItemVersions)
          .set({ status: "retired" })
          .where(eq(schema.catalogItemVersions.id, planVersionId));
      } else {
        const payload = { stage: "edited draft" };
        await connection.db
          .update(schema.entitlementLifecyclePolicies)
          .set({ payload, payloadHash: entitlementDigest(payload) })
          .where(eq(schema.entitlementLifecyclePolicies.id, policyId));
      }
      const [revision] = await connection.db
        .select()
        .from(schema.entitlementRevisions)
        .where(eq(schema.entitlementRevisions.tenantId, input.tenantId));
      expect(revision?.revision.toString()).toBe(facts.snapshot?.revision);
      if (change === "usage") {
        expect(revision?.usageRevision).toBe(BigInt(facts.snapshot.usageRevision) + 1n);
      } else {
        expect(revision?.usageRevision.toString()).toBe(facts.snapshot?.usageRevision);
      }
      const observation = await connection.db.transaction(async (tx) => {
        const result = await service.observe({ ...input, facts, transaction: tx });
        await tx
          .update(schema.organization)
          .set({ name: `Owner survived ${change} drift` })
          .where(eq(schema.organization.id, input.tenantId));
        return result;
      });
      expect(observation).toMatchObject({
        decision: "unknown",
        reasons: ["shadow_snapshot_stale"],
        observationId: expect.any(String),
      });
      const [row] = await connection.db
        .select()
        .from(schema.entitlementShadowObservations)
        .where(eq(schema.entitlementShadowObservations.id, observation.observationId!));
      expect(row).toMatchObject({
        revision: BigInt(facts.snapshot.revision),
        usageRevision: BigInt(facts.snapshot.usageRevision),
        lifecyclePolicyFingerprint: facts.policyFingerprint,
      });
      const [tenant] = await connection.db
        .select()
        .from(schema.organization)
        .where(eq(schema.organization.id, input.tenantId));
      expect(tenant?.name).toBe(`Owner survived ${change} drift`);
    },
  );
  it("isolates a real current-proof query failure and commits the observation and owner write", async () => {
    const { service, input } = await realFixture();
    const facts = await service.capture(input.tenantId);
    expect(facts.snapshot).not.toBeNull();
    if (!facts.snapshot) throw new Error("Missing real captured snapshot");
    const log = vi.spyOn(Logger.prototype, "error").mockImplementation(() => {});
    try {
      const observation = await connection.db.transaction(async (tx) => {
        // A connection-local relation shadows only the proof read, and disappears on commit.
        // Its absent revision column causes a real PostgreSQL statement failure in the savepoint.
        await tx.execute(
          sql`create temporary table entitlement_revisions (proof_failure integer) on commit drop`,
        );
        const result = await service.observe({ ...input, facts, transaction: tx });
        await tx
          .update(schema.organization)
          .set({ name: "Owner survived proof query failure" })
          .where(eq(schema.organization.id, input.tenantId));
        return result;
      });
      expect(observation).toMatchObject({
        decision: "unknown",
        reasons: ["shadow_calculation_failed"],
        observationId: expect.any(String),
      });
      const [row] = await connection.db
        .select()
        .from(schema.entitlementShadowObservations)
        .where(eq(schema.entitlementShadowObservations.id, observation.observationId!));
      expect(row).toMatchObject({ outcome: "unknown", reasonCodes: ["shadow_calculation_failed"] });
      const [tenant] = await connection.db
        .select()
        .from(schema.organization)
        .where(eq(schema.organization.id, input.tenantId));
      expect(tenant?.name).toBe("Owner survived proof query failure");
      expect(log).toHaveBeenCalledWith(
        "entitlement_shadow_calculation_failed operation=nk.lookup.v1",
      );
    } finally {
      log.mockRestore();
    }
  });
  it("persists exact actor, registry, revisions, scope and operation-scoped compatibility", async () => {
    const { service, input } = await fixture();
    const nk = await service.observe(input);
    expect(nk).toMatchObject({
      mode: "shadow",
      decision: "allow",
      observationId: expect.any(String),
    });
    expect(await service.observe({ ...input, operationId: "chz.export.create.v1" })).toMatchObject({
      decision: "deny",
    });
    const [row] = await connection.db
      .select()
      .from(schema.entitlementShadowObservations)
      .where(eq(schema.entitlementShadowObservations.id, nk.observationId!));
    expect(row).toMatchObject({
      tenantId: input.tenantId,
      operationId: input.operationId,
      registryVersion: "p1a.v1",
      revision: 11n,
      usageRevision: 12n,
      actorType: "cabinet",
      actorId: input.actor.id,
      outcome: "allow",
      resourceScope: {
        digest: input.scopeDigest,
        operationVersion: 1,
        runtime: { enabled: true, observedAt: input.runtime.observedAt.toISOString() },
      },
    });
  });
  it("composes publicApi from the verified actor domain, with no caller feature list", async () => {
    const { service, input } = await fixture();
    expect(
      await service.observe({ ...input, actor: { domain: "api_key", id: randomUUID() } }),
    ).toMatchObject({ decision: "deny" });
  });
  it("keeps unobserved runtime unknown and never treats registry gate labels as enabled", async () => {
    const { service, input } = await fixture();
    expect(await service.observe({ ...input, runtime: undefined })).toMatchObject({
      decision: "unknown",
      reasons: expect.arrayContaining(["runtime_readiness_unknown"]),
    });
  });
  it("preserves existing denial and emits unknown on unexpected shadow calculation failure without secrets", async () => {
    const { service, input, resolver } = await fixture();
    const log = vi.spyOn(Logger.prototype, "error").mockImplementation(() => {});
    resolver.mockRejectedValue(new Error("secret-provider-token"));
    expect(await service.observe(input)).toMatchObject({
      mode: "shadow",
      decision: "unknown",
      observationId: expect.any(String),
    });
    const denial = new Error("existing-security-denial");
    await expect(
      service.withAdmission(input, async () => {
        throw denial;
      }),
    ).rejects.toBe(denial);
    expect(JSON.stringify(log.mock.calls)).not.toContain("secret-provider-token");
    log.mockRestore();
  });
  it("uses a separate coherent read with an owner transaction and rolls observation back with its owner", async () => {
    const { service, input, resolver } = await fixture();
    const facts = await service.capture(input.tenantId);
    let observationId: string | null = null;
    await expect(
      connection.db.transaction(async (tx) => {
        observationId = (
          await service.observe({
            ...input,
            transaction: tx,
            facts,
            attempt: { number: 2, identity: "worker-step" },
          })
        ).observationId;
        throw new Error("owner rollback");
      }),
    ).rejects.toThrow("owner rollback");
    expect(resolver).toHaveBeenCalledTimes(1);
    const rows = await connection.db
      .select()
      .from(schema.entitlementShadowObservations)
      .where(eq(schema.entitlementShadowObservations.id, observationId!));
    expect(rows).toHaveLength(0);
  });
  it("completes owner work with a one-connection pool and detects revision drift after waiting for its lock", async () => {
    const tenantId = await createOrganization(connection.db);
    const narrow = createDb(process.env.DATABASE_URL!, { max: 1 });
    try {
      const admission = new EntitlementAdmissionService(
        narrow.db,
        new EntitlementsService(narrow.db, "managed_only"),
      );
      const facts = await admission.capture(tenantId);
      let release: () => void = () => {};
      const barrier = new Promise<void>((resolve) => {
        release = resolve;
      });
      let locked: () => void = () => {};
      const lockReady = new Promise<void>((resolve) => {
        locked = resolve;
      });
      const blocker = connection.db.transaction(async (tx) => {
        await tx
          .select()
          .from(schema.organization)
          .where(eq(schema.organization.id, tenantId))
          .for("update");
        locked();
        await barrier;
        await tx
          .insert(schema.entitlementRevisions)
          .values({ tenantId, revision: 1n, usageRevision: 0n })
          .onConflictDoUpdate({
            target: schema.entitlementRevisions.tenantId,
            set: { revision: sql`${schema.entitlementRevisions.revision} + 1` },
          });
      });
      await lockReady;
      let ownerPid = 0;
      const owner = narrow.db.transaction(async (tx) => {
        const backend = await tx.execute(sql`select pg_backend_pid() as pid`);
        ownerPid = Number(backend.rows[0]?.pid);
        await tx
          .select()
          .from(schema.organization)
          .where(eq(schema.organization.id, tenantId))
          .for("update");
        const result = await admission.observe({
          tenantId,
          actor: { domain: "system", id: null },
          operationId: "nk.worker.v1",
          scopeDigest: admissionScopeDigest({ tenantId }),
          runtime: { enabled: true, observedAt: new Date() },
          transaction: tx,
          facts,
        });
        await tx
          .update(schema.organization)
          .set({ name: "Owner completed" })
          .where(eq(schema.organization.id, tenantId));
        return result;
      });
      try {
        await vi.waitFor(async () => {
          expect(ownerPid).toBeGreaterThan(0);
          const state = await connection.pool.query<{ wait_event_type: string }>(
            "select wait_event_type from pg_stat_activity where pid=$1",
            [ownerPid],
          );
          expect(state.rows[0]?.wait_event_type).toBe("Lock");
        });
      } finally {
        release();
      }
      await blocker;
      expect(await owner).toMatchObject({
        decision: "unknown",
        reasons: ["shadow_snapshot_stale"],
        observationId: expect.any(String),
      });
    } finally {
      await narrow.pool.end();
    }
  });
  it("isolates a rejected observation insert with a savepoint and commits the owner's write", async () => {
    const { service, input } = await fixture();
    const log = vi.spyOn(Logger.prototype, "error").mockImplementation(() => {});
    await connection.db.transaction(async (tx) => {
      expect(
        await service.observe({ ...input, tenantId: randomUUID(), transaction: tx }),
      ).toMatchObject({
        decision: "unknown",
        observationId: null,
        reasons: ["shadow_persistence_failed"],
      });
      await tx
        .update(schema.organization)
        .set({ name: "Survived shadow failure" })
        .where(eq(schema.organization.id, input.tenantId));
    });
    const [tenant] = await connection.db
      .select()
      .from(schema.organization)
      .where(eq(schema.organization.id, input.tenantId));
    expect(tenant?.name).toBe("Survived shadow failure");
    log.mockRestore();
  });
  it("never admits expired snapshots or crosses a known time boundary", async () => {
    const { service, input } = await fixture();
    const facts = await service.capture(input.tenantId);
    if (!facts.snapshot) throw new Error("fixture missing");
    facts.snapshot.nextChangeAt = new Date(Date.now() - 1).toISOString();
    expect(await service.observe({ ...input, facts })).toMatchObject({
      decision: "unknown",
      reasons: ["shadow_snapshot_stale"],
    });
  });
});
