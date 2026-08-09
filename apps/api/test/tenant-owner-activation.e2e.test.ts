import { randomUUID } from "node:crypto";
import { and, eq, inArray, like, or } from "drizzle-orm";
import { hashPassword, verifyPassword } from "better-auth/crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, schema } from "@markiro/db";
import { provisionTenantOwner } from "../src/cli/provision-tenant-owner";
import { MailCryptoService } from "../src/modules/mail/mail-crypto.service";
import { MailDeliveryService } from "../src/modules/mail/mail-delivery.service";
import { TenantOwnerActivationService } from "../src/modules/tenant-owner-activation/tenant-owner-activation.service";
import {
  platformCapabilitiesForRole,
  type PlatformPrincipal,
} from "../src/platform-auth/platform-access-policy";
import { PlatformAuditService } from "../src/platform-auth/platform-audit.service";
import { SubscriptionLifecycleService } from "../src/subscriptions/subscription-lifecycle.service";
import { DefaultDemoSettingFixture } from "./support/default-demo-setting";

const hashCredentialPassword = hashPassword as unknown as (password: string) => Promise<string>;
const verifyCredentialPassword = verifyPassword as unknown as (input: {
  hash: string;
  password: string;
}) => Promise<boolean>;

const ready = Boolean(process.env.DATABASE_URL);

describe.skipIf(!ready)("tenant owner activation", () => {
  const connection = createDb(process.env.DATABASE_URL!);
  const defaultDemo = new DefaultDemoSettingFixture(connection.db);
  const activation = new TenantOwnerActivationService(connection.db);
  const mail = new MailDeliveryService(new MailCryptoService(Buffer.alloc(32, 0x72)));

  async function usePublishedDemo(durationDays: number): Promise<string> {
    const itemId = randomUUID();
    const versionId = randomUUID();
    await connection.db.insert(schema.catalogItems).values({
      id: itemId,
      code: `activation-demo-${randomUUID()}`,
      nameRu: "Демо активации",
      nameEn: "Activation demo",
      kind: "plan",
    });
    await connection.db.insert(schema.catalogItemVersions).values({
      id: versionId,
      catalogItemId: itemId,
      kind: "plan",
      version: 1,
      nameRu: "Демо активации",
      nameEn: "Activation demo",
      unit: "month",
      billingMode: "recurring",
      billingPeriod: "month",
      unitPrice: "0.00",
      vatIncluded: true,
    });
    await connection.db.insert(schema.planEntitlements).values({
      catalogVersionId: versionId,
      maxLines: 1,
      maxStations: 1,
      maxKiosks: 1,
      maxCabinetUsers: 2,
      demoDurationDays: durationDays,
    });
    await connection.db
      .update(schema.catalogItemVersions)
      .set({ status: "published", publishedAt: new Date() })
      .where(eq(schema.catalogItemVersions.id, versionId));
    await defaultDemo.install(versionId);
    return versionId;
  }

  async function createPublishedPaidPlan(): Promise<string> {
    const itemId = randomUUID();
    const versionId = randomUUID();
    await connection.db.insert(schema.catalogItems).values({
      id: itemId,
      code: `activation-race-paid-${randomUUID()}`,
      nameRu: "Платный план",
      nameEn: "Paid plan",
      kind: "plan",
    });
    await connection.db.insert(schema.catalogItemVersions).values({
      id: versionId,
      catalogItemId: itemId,
      kind: "plan",
      version: 1,
      nameRu: "Платный план",
      nameEn: "Paid plan",
      unit: "month",
      billingMode: "recurring",
      billingPeriod: "month",
      unitPrice: "10000.00",
      vatIncluded: true,
    });
    await connection.db.insert(schema.planEntitlements).values({
      catalogVersionId: versionId,
      maxLines: 2,
      maxStations: 2,
      maxKiosks: 1,
      maxCabinetUsers: 3,
      demoDurationDays: null,
    });
    await connection.db
      .update(schema.catalogItemVersions)
      .set({ status: "published", publishedAt: new Date() })
      .where(eq(schema.catalogItemVersions.id, versionId));
    return versionId;
  }

  async function waitForDatabaseLock(applicationName: string): Promise<void> {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const waiting = await connection.pool.query<{ waiting: boolean }>(
        `select exists (
          select 1
          from pg_stat_activity
          where application_name = $1 and wait_event_type = 'Lock'
        ) as waiting`,
        [applicationName],
      );
      if (waiting.rows[0]?.waiting) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`Timed out waiting for ${applicationName} to block on the database lock`);
  }

  beforeAll(async () => {
    await defaultDemo.capture();
  });

  afterAll(async () => {
    try {
      const deliveries = await connection.db
        .select({ id: schema.emailDeliveries.id })
        .from(schema.emailDeliveries)
        .where(
          or(
            like(schema.emailDeliveries.recipient, "fresh-activation-%@example.com"),
            like(schema.emailDeliveries.recipient, "existing-activation-%@example.com"),
            like(schema.emailDeliveries.recipient, "race-activation-%@example.com"),
          ),
        );
      if (deliveries.length > 0) {
        await connection.db.delete(schema.emailOutbox).where(
          inArray(
            schema.emailOutbox.deliveryId,
            deliveries.map((delivery) => delivery.id),
          ),
        );
      }
    } finally {
      try {
        await defaultDemo.restore();
      } finally {
        await connection.pool.end();
      }
    }
  });

  it("verifies a fresh owner and creates a credential exactly once", async () => {
    const demoVersionId = await usePublishedDemo(9);
    const token = `fresh-${randomUUID()}`;
    const email = `fresh-activation-${randomUUID()}@example.com`;
    const result = await provisionTenantOwner({
      db: connection.db,
      mail,
      adminOrigin: "https://cabinet.example.test",
      input: {
        email,
        tenantName: "Fresh activation tenant",
        tenantSlug: `fresh-activation-${randomUUID()}`,
      },
      createToken: () => token,
    });

    await expect(activation.getStatus(token)).resolves.toEqual({ hasAccount: false });
    const [pendingBeforeCompletion] = await connection.db
      .select()
      .from(schema.tenantSubscriptions)
      .where(eq(schema.tenantSubscriptions.tenantId, result.tenantId));
    expect(pendingBeforeCompletion).toEqual(
      expect.objectContaining({ status: "pending_activation", startsAt: null, endsAt: null }),
    );
    await activation.complete(token, { password: "fresh-password-123" });

    const [user] = await connection.db
      .select({ emailVerified: schema.user.emailVerified })
      .from(schema.user)
      .where(eq(schema.user.id, result.userId));
    const [account] = await connection.db
      .select({ password: schema.account.password })
      .from(schema.account)
      .where(
        and(eq(schema.account.userId, result.userId), eq(schema.account.providerId, "credential")),
      );
    expect(user?.emailVerified).toBe(true);
    expect(account?.password).toEqual(expect.any(String));
    await expect(
      verifyCredentialPassword({ hash: account!.password!, password: "fresh-password-123" }),
    ).resolves.toBe(true);
    await expect(activation.complete(token, { password: "another-password" })).rejects.toThrow();

    const [trial] = await connection.db
      .select()
      .from(schema.tenantSubscriptions)
      .where(eq(schema.tenantSubscriptions.tenantId, result.tenantId));
    expect(trial).toEqual(
      expect.objectContaining({
        planVersionId: demoVersionId,
        status: "trial",
        startsAt: expect.any(Date),
        endsAt: expect.any(Date),
      }),
    );
    expect(trial!.endsAt!.getTime() - trial!.startsAt!.getTime()).toBe(9 * 24 * 60 * 60 * 1_000);
    const activationEvents = await connection.db
      .select({
        kind: schema.subscriptionEvents.eventKind,
        effectiveAt: schema.subscriptionEvents.effectiveAt,
      })
      .from(schema.subscriptionEvents)
      .where(
        and(
          eq(schema.subscriptionEvents.tenantId, result.tenantId),
          eq(schema.subscriptionEvents.eventKind, "demo.activated"),
        ),
      );
    expect(activationEvents).toEqual([{ kind: "demo.activated", effectiveAt: trial!.startsAt }]);
  });

  it("verifies an existing multi-tenant account without changing its credential", async () => {
    await usePublishedDemo(14);
    const userId = randomUUID();
    const existingTenantId = randomUUID();
    const existingMemberId = randomUUID();
    const email = `existing-activation-${randomUUID()}@example.com`;
    const originalHash = await hashCredentialPassword("existing-password-123");
    await connection.db.insert(schema.user).values({
      id: userId,
      name: "Existing user",
      email,
      emailVerified: false,
    });
    await connection.db.insert(schema.account).values({
      id: randomUUID(),
      accountId: userId,
      providerId: "credential",
      userId,
      password: originalHash,
    });
    await connection.db.insert(schema.organization).values({
      id: existingTenantId,
      name: "Existing tenant",
      slug: `existing-${randomUUID()}`,
      createdAt: new Date(),
    });
    await connection.db.insert(schema.member).values({
      id: existingMemberId,
      organizationId: existingTenantId,
      userId,
      role: "manager",
      createdAt: new Date(),
    });

    const token = `existing-${randomUUID()}`;
    const result = await provisionTenantOwner({
      db: connection.db,
      mail,
      adminOrigin: "https://cabinet.example.test",
      input: {
        email,
        tenantName: "Second tenant",
        tenantSlug: `second-${randomUUID()}`,
      },
      createToken: () => token,
    });

    await expect(activation.getStatus(token)).resolves.toEqual({ hasAccount: true });
    await activation.complete(token, {});

    const [account] = await connection.db
      .select({ password: schema.account.password })
      .from(schema.account)
      .where(and(eq(schema.account.userId, userId), eq(schema.account.providerId, "credential")));
    const [user] = await connection.db
      .select({ emailVerified: schema.user.emailVerified })
      .from(schema.user)
      .where(eq(schema.user.id, userId));
    expect(account?.password).toBe(originalHash);
    expect(user?.emailVerified).toBe(true);
    const [trial] = await connection.db
      .select({ status: schema.tenantSubscriptions.status })
      .from(schema.tenantSubscriptions)
      .where(eq(schema.tenantSubscriptions.tenantId, result.tenantId));
    expect(trial).toEqual({ status: "trial" });
  });

  it("serializes owner activation before a concurrent direct plan replacement without stale history", async () => {
    const demoVersionId = await usePublishedDemo(7);
    const paidPlanVersionId = await createPublishedPaidPlan();
    const token = `race-${randomUUID()}`;
    const result = await provisionTenantOwner({
      db: connection.db,
      mail,
      adminOrigin: "https://cabinet.example.test",
      input: {
        email: `race-activation-${randomUUID()}@example.com`,
        tenantName: "Activation race tenant",
        tenantSlug: `activation-race-${randomUUID()}`,
      },
      createToken: () => token,
    });
    const [pending] = await connection.db
      .select({ id: schema.tenantSubscriptions.id })
      .from(schema.tenantSubscriptions)
      .where(eq(schema.tenantSubscriptions.tenantId, result.tenantId));
    expect(pending).toBeDefined();
    if (!pending) throw new Error("Expected the provisioned pending demo");

    const actorId = randomUUID();
    await connection.db.insert(schema.platformUsers).values({
      id: actorId,
      name: "Activation race admin",
      email: `activation-race-admin-${randomUUID()}@example.invalid`,
      emailVerified: true,
      role: "platform_admin",
      status: "active",
      twoFactorEnabled: true,
    });
    const actor: PlatformPrincipal = {
      userId: actorId,
      role: "platform_admin",
      capabilities: platformCapabilitiesForRole("platform_admin"),
      twoFactorReady: true,
    };

    const activationApplication = `task5-activation-${randomUUID()}`;
    const assignmentApplication = `task5-assignment-${randomUUID()}`;
    const activationUrl = new URL(process.env.DATABASE_URL!);
    activationUrl.searchParams.set("application_name", activationApplication);
    const assignmentUrl = new URL(process.env.DATABASE_URL!);
    assignmentUrl.searchParams.set("application_name", assignmentApplication);
    const activationConnection = createDb(activationUrl.toString());
    const assignmentConnection = createDb(assignmentUrl.toString());
    const racingActivation = new TenantOwnerActivationService(activationConnection.db);
    const racingAssignments = new SubscriptionLifecycleService(
      assignmentConnection.db,
      new PlatformAuditService(),
    );
    const blocker = await connection.pool.connect();
    let blockerOpen = false;
    try {
      await blocker.query("begin");
      blockerOpen = true;
      await blocker.query("select id from tenant_subscriptions where id = $1 for update", [
        pending.id,
      ]);

      const activationAttempt = racingActivation.complete(token, {
        password: "race-password-123",
      });
      await waitForDatabaseLock(activationApplication);
      const assignmentAttempt = racingAssignments.assignPlan(actor, result.tenantId, {
        catalogVersionId: paidPlanVersionId,
        activationPolicy: "immediate",
        endsAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1_000),
        reason: "activation race reconciliation",
      });
      await waitForDatabaseLock(assignmentApplication);
      await blocker.query("commit");
      blockerOpen = false;

      await Promise.race([
        Promise.all([activationAttempt, assignmentAttempt]),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("Concurrent lifecycle operations deadlocked")), 10_000),
        ),
      ]);
    } finally {
      if (blockerOpen) await blocker.query("rollback");
      blocker.release();
      await activationConnection.pool.end();
      await assignmentConnection.pool.end();
    }

    const subscriptions = await connection.db
      .select({
        id: schema.tenantSubscriptions.id,
        planVersionId: schema.tenantSubscriptions.planVersionId,
        status: schema.tenantSubscriptions.status,
      })
      .from(schema.tenantSubscriptions)
      .where(eq(schema.tenantSubscriptions.tenantId, result.tenantId));
    expect(subscriptions).toEqual(
      expect.arrayContaining([
        { id: pending.id, planVersionId: demoVersionId, status: "superseded" },
        expect.objectContaining({ planVersionId: paidPlanVersionId, status: "active" }),
      ]),
    );
    const events = await connection.db
      .select({
        kind: schema.subscriptionEvents.eventKind,
        before: schema.subscriptionEvents.before,
        after: schema.subscriptionEvents.after,
      })
      .from(schema.subscriptionEvents)
      .where(eq(schema.subscriptionEvents.tenantId, result.tenantId));
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "demo.activated",
          before: expect.objectContaining({ status: "pending_activation" }),
          after: expect.objectContaining({ status: "trial" }),
        }),
        expect.objectContaining({
          kind: "plan.superseded",
          before: expect.objectContaining({ status: "trial" }),
          after: expect.objectContaining({ status: "superseded" }),
        }),
        expect.objectContaining({
          kind: "plan.assigned",
          before: expect.objectContaining({ status: "trial" }),
          after: expect.objectContaining({ status: "active" }),
        }),
      ]),
    );
    const [assignmentAudit] = await connection.db
      .select({
        before: schema.platformAuditEvents.before,
        after: schema.platformAuditEvents.after,
      })
      .from(schema.platformAuditEvents)
      .where(
        and(
          eq(schema.platformAuditEvents.tenantId, result.tenantId),
          eq(schema.platformAuditEvents.action, "platform.tenant.subscription.plan_assigned"),
        ),
      );
    expect(assignmentAudit).toEqual({
      before: expect.objectContaining({ status: "trial" }),
      after: expect.objectContaining({ status: "active" }),
    });
  }, 30_000);

  it("captures the activation timestamp only after entering the tenant timeline", async () => {
    await usePublishedDemo(5);
    const token = `timeline-time-${randomUUID()}`;
    const result = await provisionTenantOwner({
      db: connection.db,
      mail,
      adminOrigin: "https://cabinet.example.test",
      input: {
        email: `race-activation-time-${randomUUID()}@example.com`,
        tenantName: "Activation timestamp tenant",
        tenantSlug: `activation-time-${randomUUID()}`,
      },
      createToken: () => token,
    });
    const applicationName = `task5-activation-time-${randomUUID()}`;
    const activationUrl = new URL(process.env.DATABASE_URL!);
    activationUrl.searchParams.set("application_name", applicationName);
    const activationConnection = createDb(activationUrl.toString());
    const racingActivation = new TenantOwnerActivationService(activationConnection.db);
    const blocker = await connection.pool.connect();
    let blockerOpen = false;
    let releasedAtMs: number | undefined;
    try {
      await blocker.query("begin");
      blockerOpen = true;
      await blocker.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [
        `tenant-subscription:${result.tenantId}`,
      ]);
      const activationAttempt = racingActivation.complete(token, {
        password: "timeline-password-123",
      });
      await waitForDatabaseLock(applicationName);
      releasedAtMs = Date.now();
      await blocker.query("commit");
      blockerOpen = false;
      await activationAttempt;
    } finally {
      if (blockerOpen) await blocker.query("rollback");
      blocker.release();
      await activationConnection.pool.end();
    }
    const [trial] = await connection.db
      .select({ startsAt: schema.tenantSubscriptions.startsAt })
      .from(schema.tenantSubscriptions)
      .where(eq(schema.tenantSubscriptions.tenantId, result.tenantId));
    if (!trial?.startsAt || releasedAtMs === undefined) {
      throw new Error("Expected a trial timestamp and a recorded timeline release");
    }
    expect(trial.startsAt.getTime()).toBeGreaterThanOrEqual(releasedAtMs);
  }, 30_000);
});
