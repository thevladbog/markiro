import { randomUUID } from "node:crypto";
import { createDb, schema } from "@markiro/db";
import { eq } from "drizzle-orm";
import { afterAll, describe, expect, it, vi } from "vitest";
import {
  platformCapabilitiesForRole,
  type PlatformPrincipal,
  type EntitlementSourcePreviewRequest,
} from "@markiro/platform-contracts";
import { EntitlementsService } from "../src/subscriptions/entitlements.service";
import { EntitlementSourcesService } from "../src/subscriptions/entitlement-sources.service";
import { PlatformAuditService } from "../src/platform-auth/platform-audit.service";
import {
  entitlementDigest,
  entitlementRegistryFingerprint,
} from "../src/subscriptions/entitlement-snapshot-reader";
import {
  createManagedSubscription,
  createOrganization,
  createPublishedPlan,
} from "./support/subscription-fixtures";
const connection = createDb(process.env.DATABASE_URL ?? "postgres://invalid");
const db = connection.db;
const resolver = new EntitlementsService(db, "managed_only");
const service = new EntitlementSourcesService(db, resolver, new PlatformAuditService());
afterAll(() => connection.pool.end());
async function actor(
  role: "platform_admin" | "support" | "accountant" = "platform_admin",
): Promise<PlatformPrincipal> {
  const userId = randomUUID();
  await db.insert(schema.platformUsers).values({
    id: userId,
    email: `${userId}@example.invalid`,
    name: "Source tester",
    role,
    status: "active",
    twoFactorEnabled: true,
  });
  await db.insert(schema.platformTwoFactors).values({
    id: randomUUID(),
    userId,
    secret: "test-only",
    backupCodes: "test-only",
    verified: true,
  });
  return { userId, role, capabilities: platformCapabilitiesForRole[role], twoFactorReady: true };
}
function command(): EntitlementSourcePreviewRequest {
  return {
    intent: "prepare",
    command: {
      kind: "temporary",
      effects: [{ key: "chzIntegration", featureEnabled: true }],
      operationIds: ["nk.lookup.v1"],
      startsAt: new Date(Date.now() - 30_000).toISOString(),
      endsAt: new Date(Date.now() + 600_000).toISOString(),
      reason: "Pilot decision",
      decisionReference: "PRIVATE-DECISION-42",
      requestId: randomUUID(),
    },
  };
}
describe.skipIf(!process.env.DATABASE_URL)("prepared entitlement sources", () => {
  it("previews, confirms exactly once, audits exact facts, revokes with retained history and replays original result", async () => {
    const principal = await actor();
    const managed = await createManagedSubscription(db);
    const request = command();
    if (request.intent !== "prepare") throw new Error("Expected preparation fixture");
    const before = await resolver.resolveSnapshot(managed.tenantId);
    const preview = await service.preview(principal, managed.tenantId, request);
    expect(preview.after.current).toEqual(preview.before.current);
    expect(preview.after.candidate.features.chzIntegration).toBe(true);
    expect((await resolver.resolveSnapshot(managed.tenantId)).candidate).toEqual(before.candidate);
    const confirmation = { previewId: preview.previewId, requestId: preview.requestId };
    const [first, second] = await Promise.all([
      service.confirm(principal, managed.tenantId, confirmation),
      service.confirm(principal, managed.tenantId, confirmation),
    ]);
    expect(second).toEqual(first);
    expect(first.after).toEqual(preview.after);
    const rows = await db
      .select()
      .from(schema.entitlementSources)
      .where(eq(schema.entitlementSources.tenantId, managed.tenantId));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe(first.sourceId);
    expect(first.after.sources.some((s) => s.id === first.sourceId)).toBe(true);
    const revokeRequest: EntitlementSourcePreviewRequest = {
      intent: "revoke",
      sourceId: first.sourceId,
      reason: "Pilot ended",
      decisionReference: "REVOKE-42",
      requestId: randomUUID(),
    };
    const revoke = await service.preview(principal, managed.tenantId, revokeRequest);
    expect(revoke.after.candidate.features.chzIntegration).toBeNull();
    const revoked = await service.confirm(principal, managed.tenantId, {
      previewId: revoke.previewId,
      requestId: revoke.requestId,
    });
    expect(await service.confirm(principal, managed.tenantId, confirmation)).toEqual(first);
    expect((await service.list(principal, managed.tenantId)).sourceDetails[0]).toMatchObject({
      id: first.sourceId,
      reason: "Pilot decision",
      revokedAt: revoked.confirmedAt,
    });
    expect(
      await service.confirm(principal, managed.tenantId, {
        previewId: revoke.previewId,
        requestId: revoke.requestId,
      }),
    ).toEqual(revoked);
    const auditEvents = await db
      .select({
        actorPlatformUserId: schema.platformAuditEvents.actorPlatformUserId,
        actorRole: schema.platformAuditEvents.actorRole,
        tenantId: schema.platformAuditEvents.tenantId,
        action: schema.platformAuditEvents.action,
        outcome: schema.platformAuditEvents.outcome,
        targetType: schema.platformAuditEvents.targetType,
        targetId: schema.platformAuditEvents.targetId,
        reason: schema.platformAuditEvents.reason,
        requestId: schema.platformAuditEvents.requestId,
        before: schema.platformAuditEvents.before,
        after: schema.platformAuditEvents.after,
      })
      .from(schema.platformAuditEvents)
      .where(eq(schema.platformAuditEvents.tenantId, managed.tenantId))
      .orderBy(schema.platformAuditEvents.action);
    const sourceFacts = {
      sourceId: preview.previewId,
      versionId: preview.previewId,
      version: 1,
      effects: request.command.effects,
      operationIds: request.command.operationIds,
      startsAt: request.command.startsAt,
      endsAt: request.command.endsAt,
    };
    const auditIdentity = {
      actorPlatformUserId: principal.userId,
      actorRole: "platform_admin",
      tenantId: managed.tenantId,
      outcome: "success",
      targetType: "entitlement_source",
      targetId: preview.previewId,
    };
    // Exactly one event per mutation, even after concurrent confirmation and both replays.
    expect(auditEvents).toEqual([
      {
        ...auditIdentity,
        action: "entitlement_source.prepared",
        reason: request.command.reason,
        requestId: request.command.requestId,
        before: null,
        after: {
          ...sourceFacts,
          subscriptionId: managed.subscriptionId,
          previewId: preview.previewId,
          payloadHash: entitlementDigest(request),
          revision: preview.revision,
          usageRevision: preview.usageRevision,
          registryVersion: entitlementRegistryFingerprint(),
          decisionReference: request.command.decisionReference,
          prepared: true,
        },
      },
      {
        ...auditIdentity,
        action: "entitlement_source.revoked",
        reason: revokeRequest.reason,
        requestId: revokeRequest.requestId,
        before: sourceFacts,
        after: {
          sourceId: preview.previewId,
          versionId: preview.previewId,
          version: 1,
          subscriptionId: managed.subscriptionId,
          previewId: revoke.previewId,
          payloadHash: entitlementDigest(revokeRequest),
          revision: revoke.revision,
          usageRevision: revoke.usageRevision,
          registryVersion: entitlementRegistryFingerprint(),
          decisionReference: revokeRequest.decisionReference,
          revokedAt: revoked.confirmedAt,
        },
      },
    ]);
  });
  it("rejects changed request, tenant, actor and request binding without writes", async () => {
    const principal = await actor();
    const managed = await createManagedSubscription(db);
    const request = command();
    const preview = await service.preview(principal, managed.tenantId, request);
    if (request.intent !== "prepare") throw Error();
    await expect(
      service.preview(principal, managed.tenantId, {
        ...request,
        command: { ...request.command, reason: "changed" },
      }),
    ).rejects.toMatchObject({ response: { code: "entitlement_request_conflict" } });
    const confirmation = { previewId: preview.previewId, requestId: preview.requestId };
    await expect(
      service.confirm(await actor(), managed.tenantId, confirmation),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      service.confirm(principal, await createOrganization(db), confirmation),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      service.confirm(principal, managed.tenantId, { ...confirmation, requestId: randomUUID() }),
    ).rejects.toMatchObject({ response: { code: "entitlement_request_conflict" } });
  });
  it.each(["terms", "usage"] as const)(
    "invalidates preview on changed %s and retains old generation",
    async (change) => {
      const principal = await actor();
      const managed = await createManagedSubscription(db);
      const request = command();
      const preview = await service.preview(principal, managed.tenantId, request);
      if (change === "usage")
        await db.insert(schema.lines).values({ tenantId: managed.tenantId, name: "Occupied" });
      else
        await db
          .update(schema.tenantSubscriptions)
          .set({ endsAt: new Date(Date.now() + 2_000_000) })
          .where(eq(schema.tenantSubscriptions.id, managed.subscriptionId));
      await expect(
        service.confirm(principal, managed.tenantId, {
          previewId: preview.previewId,
          requestId: preview.requestId,
        }),
      ).rejects.toMatchObject({ response: { code: "entitlement_preview_stale" } });
      await expect(service.preview(principal, managed.tenantId, request)).rejects.toMatchObject({
        response: { code: "entitlement_preview_stale" },
      });
      if (request.intent !== "prepare") throw Error();
      const refreshed = await service.preview(principal, managed.tenantId, {
        ...request,
        command: { ...request.command, requestId: randomUUID() },
      });
      expect(refreshed.previewId).not.toBe(preview.previewId);
      expect(
        await db
          .select()
          .from(schema.entitlementSourcePreviews)
          .where(eq(schema.entitlementSourcePreviews.tenantId, managed.tenantId)),
      ).toHaveLength(2);
    },
  );
  it("reloads current actor and verified factor; filters internal source details for support", async () => {
    const admin = await actor();
    const support = await actor("support");
    const accountant = await actor("accountant");
    const managed = await createManagedSubscription(db);
    const preview = await service.preview(admin, managed.tenantId, command());
    await service.confirm(admin, managed.tenantId, {
      previewId: preview.previewId,
      requestId: preview.requestId,
    });
    expect(await service.list(support, managed.tenantId)).toMatchObject({
      detailsVisible: false,
      sourceDetails: [],
    });
    expect(JSON.stringify((await service.list(support, managed.tenantId)).snapshot)).not.toContain(
      "PRIVATE-DECISION",
    );
    await expect(service.preview(support, managed.tenantId, command())).rejects.toMatchObject({
      status: 403,
    });
    await expect(service.preview(accountant, managed.tenantId, command())).rejects.toMatchObject({
      status: 403,
    });
    await db
      .update(schema.platformTwoFactors)
      .set({ verified: false })
      .where(eq(schema.platformTwoFactors.userId, admin.userId));
    await expect(service.preview(admin, managed.tenantId, command())).rejects.toMatchObject({
      status: 403,
    });
  });
  it("reports bounded impact without assignments and current write policy", async () => {
    const principal = await actor();
    const tenantId = await createOrganization(db);
    const impact = await service.impact(principal, tenantId);
    expect(impact).toMatchObject({
      tenantId,
      scope: "tenant_current_observation",
      mode: "shadow",
      reasons: expect.arrayContaining([
        "subscription_unmanaged",
        "mapping_required",
        "lifecycle_policy_required",
      ]),
    });
    expect(
      await db
        .select()
        .from(schema.entitlementSources)
        .where(eq(schema.entitlementSources.tenantId, tenantId)),
    ).toEqual([]);
    expect(
      (await new EntitlementsService(db, "all").resolveSnapshot(tenantId)).current.writeAllowed,
    ).toBe(false);
  });
  it("normalizes valid UTC timestamp notation before binding immutable result", async () => {
    const principal = await actor();
    const managed = await createManagedSubscription(db);
    const request = command();
    if (request.intent !== "prepare") throw Error();
    request.command.startsAt = request.command.startsAt.replace(/\.\d{3}Z$/, "Z");
    request.command.endsAt = request.command.endsAt?.replace(/\.\d{3}Z$/, "Z") ?? null;
    const preview = await service.preview(principal, managed.tenantId, request);
    await expect(
      service.confirm(principal, managed.tenantId, {
        previewId: preview.previewId,
        requestId: preview.requestId,
      }),
    ).resolves.toMatchObject({ sourceId: preview.previewId });
  });
  it("invalidates server time at preview expiry without any revision update", async () => {
    const principal = await actor();
    const managed = await createManagedSubscription(db);
    const preview = await service.preview(principal, managed.tenantId, command());
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(preview.expiresAt));
    try {
      await expect(
        service.confirm(principal, managed.tenantId, {
          previewId: preview.previewId,
          requestId: preview.requestId,
        }),
      ).rejects.toMatchObject({ response: { code: "entitlement_preview_stale" } });
    } finally {
      vi.useRealTimers();
    }
  });
  it("rejects a stored result from another subscription in the same tenant", async () => {
    const principal = await actor();
    const managed = await createManagedSubscription(db);
    const request = command();
    if (request.intent !== "prepare") throw Error();
    const preview = await service.preview(principal, managed.tenantId, request);
    const other = await createManagedSubscription(db, {
      tenantId: managed.tenantId,
      status: "scheduled",
      startsAt: new Date(Date.now() + 4_000_000),
      endsAt: new Date(Date.now() + 5_000_000),
    });
    const confirmedAt = new Date();
    await db.insert(schema.entitlementSources).values({
      id: preview.previewId,
      versionId: preview.previewId,
      tenantId: managed.tenantId,
      subscriptionId: other.subscriptionId,
      kind: request.command.kind,
      effects: request.command.effects,
      operationIds: request.command.operationIds,
      startsAt: new Date(request.command.startsAt),
      endsAt: request.command.endsAt === null ? null : new Date(request.command.endsAt),
      reason: request.command.reason,
      decisionReference: request.command.decisionReference,
      requestId: request.command.requestId,
      createdByPlatformUserId: principal.userId,
      createdAt: confirmedAt,
    });
    await db
      .update(schema.entitlementSourcePreviews)
      .set({ confirmedAt, resultSourceId: preview.previewId })
      .where(eq(schema.entitlementSourcePreviews.id, preview.previewId));
    await expect(
      service.confirm(principal, managed.tenantId, {
        previewId: preview.previewId,
        requestId: preview.requestId,
      }),
    ).rejects.toMatchObject({ response: { code: "entitlement_request_conflict" } });
  });
  it("retries the whole repeatable-read transaction after an intervening usage commit and rejects stale preview", async () => {
    const principal = await actor();
    const managed = await createManagedSubscription(db);
    const preview = await service.preview(principal, managed.tenantId, command());
    const original = resolver.resolveSnapshotInTransaction.bind(resolver);
    let attempts = 0;
    const spy = vi
      .spyOn(resolver, "resolveSnapshotInTransaction")
      .mockImplementation(async (tenantId, tx) => {
        const facts = await original(tenantId, tx);
        attempts++;
        if (attempts === 1)
          await db.insert(schema.lines).values({ tenantId, name: "Concurrent occupied slot" });
        return facts;
      });
    try {
      await expect(
        service.confirm(principal, managed.tenantId, {
          previewId: preview.previewId,
          requestId: preview.requestId,
        }),
      ).rejects.toMatchObject({ response: { code: "entitlement_preview_stale" } });
      expect(attempts).toBe(2);
      expect(
        await db
          .select()
          .from(schema.entitlementSources)
          .where(eq(schema.entitlementSources.tenantId, managed.tenantId)),
      ).toHaveLength(0);
    } finally {
      spy.mockRestore();
    }
  });
  it("keeps snapshot usage and revision coherent if a resource commits between resolver reads", async () => {
    const managed = await createManagedSubscription(db);
    const baseline = await resolver.resolveSnapshot(managed.tenantId);
    const original = resolver.resolve.bind(resolver);
    const spy = vi.spyOn(resolver, "resolve").mockImplementation(async (...args) => {
      const current = await original(...args);
      await db.insert(schema.lines).values({ tenantId: managed.tenantId, name: "Concurrent line" });
      return current;
    });
    let snapshot;
    try {
      snapshot = await resolver.resolveSnapshot(managed.tenantId);
    } finally {
      spy.mockRestore();
    }
    expect(snapshot.current.quotas.lines.used).toBe(0);
    expect(snapshot.usageRevision).toBe(baseline.usageRevision);
    expect((await resolver.resolveSnapshot(managed.tenantId)).current.quotas.lines.used).toBe(1);
  });
  it("binds approved-policy facts and registry fingerprint even when term revisions match", async () => {
    const principal = await actor();
    const managed = await createManagedSubscription(db);
    const request = command();
    const preview = await service.preview(principal, managed.tenantId, request);
    const [stored] = await db
      .select()
      .from(schema.entitlementSourcePreviews)
      .where(eq(schema.entitlementSourcePreviews.id, preview.previewId));
    if (!stored) throw Error();
    const alteredId = randomUUID();
    const alteredRequestId = randomUUID();
    if (request.intent !== "prepare") throw Error();
    const payload = { ...request, command: { ...request.command, requestId: alteredRequestId } };
    await db.insert(schema.entitlementSourcePreviews).values({
      ...stored,
      id: alteredId,
      requestId: alteredRequestId,
      payload,
      payloadHash: entitlementDigest(payload),
      lifecyclePolicyFingerprint: "0".repeat(64),
    });
    await expect(
      service.confirm(principal, managed.tenantId, {
        previewId: alteredId,
        requestId: alteredRequestId,
      }),
    ).rejects.toMatchObject({ response: { code: "entitlement_preview_stale" } });
  });
  it("serializes concurrent same-intent preview retries without replacing immutable proof", async () => {
    const principal = await actor();
    const managed = await createManagedSubscription(db);
    const request = command();
    const [a, b] = await Promise.all([
      service.preview(principal, managed.tenantId, request),
      service.preview(principal, managed.tenantId, request),
    ]);
    expect(a).toEqual(b);
    expect(
      await db
        .select()
        .from(schema.entitlementSourcePreviews)
        .where(eq(schema.entitlementSourcePreviews.tenantId, managed.tenantId)),
    ).toHaveLength(1);
  });

  it("rejects changed payload during concurrent same-request preview generation", async () => {
    const principal = await actor();
    const managed = await createManagedSubscription(db);
    const request = command();
    if (request.intent !== "prepare") throw Error();
    const outcomes = await Promise.allSettled([
      service.preview(principal, managed.tenantId, request),
      service.preview(principal, managed.tenantId, {
        ...request,
        command: { ...request.command, reason: "Different intent" },
      }),
    ]);
    expect(outcomes.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.find((result) => result.status === "rejected")).toMatchObject({
      status: "rejected",
      reason: { response: { code: "entitlement_request_conflict" } },
    });
  });
  it.each(["expired", "replaced"] as const)(
    "retains source revocation after its base is %s without changing current rights",
    async (state) => {
      const principal = await actor();
      const managed = await createManagedSubscription(db);
      const prepared = await service.preview(principal, managed.tenantId, command());
      const granted = await service.confirm(principal, managed.tenantId, {
        previewId: prepared.previewId,
        requestId: prepared.requestId,
      });
      await db
        .update(schema.tenantSubscriptions)
        .set({ status: "expired", endsAt: new Date(Date.now() - 1000) })
        .where(eq(schema.tenantSubscriptions.id, managed.subscriptionId));
      if (state === "replaced")
        await createManagedSubscription(db, {
          tenantId: managed.tenantId,
          startsAt: new Date(),
          maxLines: 7,
        });
      const before = await resolver.resolveSnapshot(managed.tenantId);
      const preview = await service.preview(principal, managed.tenantId, {
        intent: "revoke",
        sourceId: granted.sourceId,
        reason: "Withdraw old pilot",
        decisionReference: "OLD-PILOT",
        requestId: randomUUID(),
      });
      expect(preview.after.current).toEqual(preview.before.current);
      expect(preview.after.candidate).toEqual(before.candidate);
      const result = await service.confirm(principal, managed.tenantId, {
        previewId: preview.previewId,
        requestId: preview.requestId,
      });
      expect((await resolver.resolveSnapshot(managed.tenantId)).current).toEqual(before.current);
      const [source] = await db
        .select()
        .from(schema.entitlementSources)
        .where(eq(schema.entitlementSources.id, granted.sourceId));
      expect(source).toMatchObject({
        subscriptionId: managed.subscriptionId,
        revokedAt: new Date(result.confirmedAt),
        revocationReason: "Withdraw old pilot",
      });
    },
  );

  it("retries and rejects concurrent policy edits even when terms and usage revisions do not change", async () => {
    const principal = await actor();
    const policyId = randomUUID();
    const payload = { stage: "draft" };
    await db.insert(schema.entitlementLifecyclePolicies).values({
      id: policyId,
      policyKey: policyId,
      version: 1,
      status: "draft",
      payload,
      payloadHash: entitlementDigest(payload),
      createdByPlatformUserId: principal.userId,
    });
    const planVersionId = await createPublishedPlan(db, {
      maxLines: 1,
      maxStations: 1,
      maxKiosks: 1,
      maxCabinetUsers: 1,
      lifecyclePolicyId: policyId,
    });
    const managed = await createManagedSubscription(db, { planVersionId });
    const preview = await service.preview(principal, managed.tenantId, command());
    const original = resolver.resolveSnapshotInTransaction.bind(resolver);
    let attempts = 0;
    const spy = vi
      .spyOn(resolver, "resolveSnapshotInTransaction")
      .mockImplementation(async (tenantId, tx) => {
        const facts = await original(tenantId, tx);
        attempts++;
        if (attempts === 1)
          await db
            .update(schema.entitlementLifecyclePolicies)
            .set({
              payload: { stage: "edited" },
              payloadHash: entitlementDigest({ stage: "edited" }),
            })
            .where(eq(schema.entitlementLifecyclePolicies.id, policyId));
        return facts;
      });
    try {
      await expect(
        service.confirm(principal, managed.tenantId, {
          previewId: preview.previewId,
          requestId: preview.requestId,
        }),
      ).rejects.toMatchObject({ response: { code: "entitlement_preview_stale" } });
      expect(attempts).toBe(2);
    } finally {
      spy.mockRestore();
    }
  });

  it.each(["source", "base", "invitation"] as const)(
    "bounds preview by the next %s interval without relying on a revision bump",
    async (boundaryType) => {
      const principal = await actor();
      const boundary = new Date(Date.now() + 30_000);
      const managed = await createManagedSubscription(
        db,
        boundaryType === "base" ? { endsAt: boundary } : {},
      );
      const request = command();
      if (request.intent !== "prepare") throw Error();
      if (boundaryType === "source") request.command.endsAt = boundary.toISOString();
      if (boundaryType === "invitation") {
        const inviterId = randomUUID();
        await db
          .insert(schema.user)
          .values({ id: inviterId, name: "Inviter", email: `${inviterId}@example.invalid` });
        await db.insert(schema.invitation).values({
          id: randomUUID(),
          organizationId: managed.tenantId,
          email: `${randomUUID()}@example.invalid`,
          role: "member",
          status: "pending",
          expiresAt: boundary,
          inviterId,
        });
      }
      const preview = await service.preview(principal, managed.tenantId, request);
      expect(preview.expiresAt).toBe(boundary.toISOString());
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(boundary);
      try {
        await expect(
          service.confirm(principal, managed.tenantId, {
            previewId: preview.previewId,
            requestId: preview.requestId,
          }),
        ).rejects.toMatchObject({ response: { code: "entitlement_preview_stale" } });
      } finally {
        vi.useRealTimers();
      }
    },
  );
});
