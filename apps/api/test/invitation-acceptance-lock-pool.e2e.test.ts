import express from "express";
import { Test } from "@nestjs/testing";
import type { INestApplication } from "@nestjs/common";
import { and, eq, inArray } from "drizzle-orm";
import { createDb, schema } from "@markiro/db";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { AppModule } from "../src/app.module";
import { mountAuth, setupAuth } from "../src/auth/auth.setup";
import { loadEnv } from "../src/env";
import { EntitlementsService } from "../src/subscriptions/entitlements.service";
import { signUpAndActivate } from "./support/auth";
import { listenOnLoopback } from "./support/listen-loopback";
import { PLATFORM_TEST_ENV } from "./support/platform-test-env";
import { createManagedSubscription, createPublishedPlan } from "./support/subscription-fixtures";

const ready = Boolean(
  process.env.DATABASE_URL && process.env.BETTER_AUTH_SECRET && process.env.BETTER_AUTH_URL,
);

function databaseUrlWithApplicationName(databaseUrl: string, applicationName: string): string {
  const parsed = new URL(databaseUrl);
  parsed.searchParams.set("application_name", applicationName);
  return parsed.toString();
}

async function settleWithin<T>(
  promise: Promise<T>,
  timeoutMs: number,
): Promise<{ kind: "completed"; value: T } | { kind: "timed_out" }> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise.then((value) => ({ kind: "completed" as const, value })),
      new Promise<{ kind: "timed_out" }>((resolve) => {
        timeout = setTimeout(() => resolve({ kind: "timed_out" }), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

describe.skipIf(!ready)("invitation acceptance advisory-lock pool", () => {
  it("keeps ten simultaneous Better Auth accepts off the saturated primary pool", async () => {
    const rootDatabaseUrl = process.env.DATABASE_URL;
    if (!rootDatabaseUrl) throw new Error("DATABASE_URL is required for this test");
    const applicationName = `invitation-accept-primary-${crypto.randomUUID()}`;
    const probeApplicationName = `invitation-accept-probe-${crypto.randomUUID()}`;
    const databaseUrl = databaseUrlWithApplicationName(rootDatabaseUrl, applicationName);
    const probeConnection = createDb(
      databaseUrlWithApplicationName(rootDatabaseUrl, probeApplicationName),
    );
    const env = loadEnv({
      ...process.env,
      ...PLATFORM_TEST_ENV,
      DATABASE_URL: databaseUrl,
      SUBSCRIPTION_ENFORCEMENT_MODE: "managed_only",
    });
    const setup = setupAuth(env);
    const ref = await Test.createTestingModule({
      imports: [AppModule.forRoot({ ...setup, databaseUrl, env })],
    }).compile();
    const app: INestApplication = ref.createNestApplication({ bodyParser: false });
    const server = app.getHttpAdapter().getInstance();
    mountAuth(server, setup.auth);
    server.use(express.json());
    await app.init();
    await listenOnLoopback(app);
    expect(setup.pool.options.max).toBe(10);

    const owner = request.agent(app.getHttpServer());
    const tenantId = await signUpAndActivate(owner);
    const planVersionId = await createPublishedPlan(setup.db, {
      maxLines: null,
      maxStations: null,
      maxKiosks: null,
      maxCabinetUsers: 11,
    });
    await createManagedSubscription(setup.db, { tenantId, planVersionId });
    const invitees = Array.from({ length: 10 }, () => request.agent(app.getHttpServer()));
    const inviteeTenantIds = await Promise.all(
      invitees.map((invitee) => signUpAndActivate(invitee)),
    );
    const inviteeUsers = await setup.db
      .select({
        tenantId: schema.member.organizationId,
        id: schema.user.id,
        email: schema.user.email,
      })
      .from(schema.member)
      .innerJoin(schema.user, eq(schema.user.id, schema.member.userId))
      .where(inArray(schema.member.organizationId, inviteeTenantIds));
    expect(inviteeUsers).toHaveLength(10);
    const userByTenant = new Map(inviteeUsers.map((row) => [row.tenantId, row]));
    const recipients = inviteeTenantIds.map((inviteeTenantId) => {
      const recipient = userByTenant.get(inviteeTenantId);
      if (!recipient) throw new Error(`Missing invitee user for tenant ${inviteeTenantId}`);
      return recipient;
    });
    const invitationResponses = await Promise.all(
      recipients.map((recipient) =>
        owner
          .post("/team/invitations")
          .send({ email: recipient.email, role: "manager" })
          .expect(201),
      ),
    );
    const invitationIds = invitationResponses.map((response) => response.body.id as string);
    const deliveries = await setup.db
      .select({ id: schema.emailDeliveries.id, sourceId: schema.emailDeliveries.sourceId })
      .from(schema.emailDeliveries)
      .where(inArray(schema.emailDeliveries.sourceId, invitationIds));
    expect(deliveries).toHaveLength(10);

    const probe = await probeConnection.pool.connect();
    let quotaBarrierHeld = false;
    let completion:
      { kind: "completed"; value: request.Response[] } | { kind: "timed_out" } | undefined;
    let lockPhase: "dedicated_waiters" | "primary_saturated" | undefined;
    let primaryPoolExpanded = false;
    try {
      await probe.query("select pg_advisory_lock(hashtext($1), $2)", [
        `subscription-quota:${tenantId}`,
        4,
      ]);
      quotaBarrierHeld = true;
      const acceptanceAttempts = invitees.map((invitee, index) => {
        const invitationId = invitationIds[index];
        if (!invitationId) throw new Error(`Missing invitation at index ${index}`);
        return invitee.post(`/invitations/${invitationId}/accept`).then((response) => response);
      });

      const phaseDeadline = Date.now() + 10_000;
      while (Date.now() < phaseDeadline) {
        const waiting = await probe.query<{ count: number }>(
          `select count(*)::int as count
           from pg_locks
           where locktype = 'advisory'
             and database = (select oid from pg_database where datname = current_database())
             and classid = hashtext($1)::oid
             and objid = $2::oid
             and not granted`,
          [`subscription-quota:${tenantId}`, 4],
        );
        const waiterCount = waiting.rows[0]?.count ?? 0;
        if (waiterCount >= 10) {
          lockPhase = "primary_saturated";
          break;
        }
        if (
          waiterCount >= 4 &&
          setup.pool.totalCount > 0 &&
          setup.pool.idleCount === setup.pool.totalCount &&
          setup.pool.waitingCount === 0
        ) {
          lockPhase = "dedicated_waiters";
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      if (!lockPhase) throw new Error("Timed out waiting for invitation acceptance lock waiters");

      await probe.query("select pg_advisory_unlock(hashtext($1), $2)", [
        `subscription-quota:${tenantId}`,
        4,
      ]);
      quotaBarrierHeld = false;
      completion = await settleWithin(Promise.all(acceptanceAttempts), 5_000);
      if (completion.kind === "timed_out") {
        setup.pool.options.max += 1;
        primaryPoolExpanded = true;
        const pulse = setup.pool.connect().then((client) => client.release());
        await Promise.allSettled(acceptanceAttempts);
        await pulse;
      }

      expect(lockPhase).toBe("dedicated_waiters");
      expect(completion.kind).toBe("completed");
      if (completion.kind !== "completed") return;
      expect(completion.value.map((response) => response.status)).toEqual(Array(10).fill(200));

      const invitationState = await probeConnection.db
        .select({ id: schema.invitation.id, status: schema.invitation.status })
        .from(schema.invitation)
        .where(inArray(schema.invitation.id, invitationIds));
      expect(invitationState.sort((left, right) => left.id.localeCompare(right.id))).toEqual(
        invitationIds
          .map((id) => ({ id, status: "accepted" }))
          .sort((left, right) => left.id.localeCompare(right.id)),
      );
      const members = await probeConnection.db
        .select({ userId: schema.member.userId, role: schema.member.role })
        .from(schema.member)
        .where(eq(schema.member.organizationId, tenantId));
      const [ownerMember] = members.filter((member) => member.role === "owner");
      expect(ownerMember).toBeDefined();
      if (!ownerMember) throw new Error("Missing tenant owner membership");
      expect(members.sort((left, right) => left.userId.localeCompare(right.userId))).toEqual(
        [
          { userId: ownerMember.userId, role: "owner" },
          ...recipients.map((recipient) => ({ userId: recipient.id, role: "manager" })),
        ].sort((left, right) => left.userId.localeCompare(right.userId)),
      );
      expect((await app.get(EntitlementsService).usage(tenantId)).cabinetUsers).toBe(11);
      const deliveryState = await probeConnection.db
        .select({
          id: schema.emailDeliveries.id,
          status: schema.emailDeliveries.status,
          encryptedPayload: schema.emailDeliveries.encryptedPayload,
          payloadNonce: schema.emailDeliveries.payloadNonce,
          payloadTag: schema.emailDeliveries.payloadTag,
          attemptId: schema.emailDeliveries.attemptId,
          attemptDeadline: schema.emailDeliveries.attemptDeadline,
        })
        .from(schema.emailDeliveries)
        .where(
          inArray(
            schema.emailDeliveries.id,
            deliveries.map((delivery) => delivery.id),
          ),
        );
      expect(deliveryState.sort((left, right) => left.id.localeCompare(right.id))).toEqual(
        deliveries
          .map((delivery) => ({
            id: delivery.id,
            status: "canceled",
            encryptedPayload: null,
            payloadNonce: null,
            payloadTag: null,
            attemptId: null,
            attemptDeadline: null,
          }))
          .sort((left, right) => left.id.localeCompare(right.id)),
      );
      await expect(
        probeConnection.db
          .select({ deliveryId: schema.emailOutbox.deliveryId })
          .from(schema.emailOutbox)
          .where(
            inArray(
              schema.emailOutbox.deliveryId,
              deliveries.map((delivery) => delivery.id),
            ),
          ),
      ).resolves.toEqual([]);
      await expect(
        probeConnection.db
          .select({ invitationId: schema.tenantInvitationProfiles.invitationId })
          .from(schema.tenantInvitationProfiles)
          .where(inArray(schema.tenantInvitationProfiles.invitationId, invitationIds)),
      ).resolves.toEqual([]);
      const audits = await probeConnection.db
        .select({
          actorUserId: schema.tenantAuditEvents.actorUserId,
          targetId: schema.tenantAuditEvents.targetId,
          action: schema.tenantAuditEvents.action,
          outcome: schema.tenantAuditEvents.outcome,
          targetType: schema.tenantAuditEvents.targetType,
          before: schema.tenantAuditEvents.before,
          after: schema.tenantAuditEvents.after,
        })
        .from(schema.tenantAuditEvents)
        .where(
          and(
            eq(schema.tenantAuditEvents.organizationId, tenantId),
            eq(schema.tenantAuditEvents.action, "team.invitation.accepted"),
            inArray(schema.tenantAuditEvents.targetId, invitationIds),
          ),
        );
      const expectedAudits = invitationIds.map((invitationId, index) => {
        const recipient = recipients[index];
        if (!recipient) throw new Error(`Missing audit actor at index ${index}`);
        return {
          actorUserId: recipient.id,
          targetId: invitationId,
          action: "team.invitation.accepted",
          outcome: "success",
          targetType: "invitation",
          before: { status: "pending", role: "manager" },
          after: { status: "accepted", role: "manager" },
        };
      });
      const exactAudits = audits.map((audit) => {
        if (!audit.targetId) throw new Error("Invitation acceptance audit is missing targetId");
        return { ...audit, targetId: audit.targetId };
      });
      expect(
        exactAudits.sort((left, right) => left.targetId.localeCompare(right.targetId)),
      ).toEqual(expectedAudits.sort((left, right) => left.targetId.localeCompare(right.targetId)));

      const quotaProbe = await probe.query<{ locked: boolean }>(
        "select pg_try_advisory_lock(hashtext($1), $2) as locked",
        [`subscription-quota:${tenantId}`, 4],
      );
      expect(quotaProbe.rows).toEqual([{ locked: true }]);
      const deliveryLocks: string[] = [];
      try {
        for (const delivery of deliveries) {
          const deliveryProbe = await probe.query<{ locked: boolean }>(
            "select pg_try_advisory_lock(hashtextextended($1, 0)) as locked",
            [delivery.id],
          );
          expect(deliveryProbe.rows).toEqual([{ locked: true }]);
          deliveryLocks.push(delivery.id);
        }
      } finally {
        for (const deliveryId of deliveryLocks.reverse()) {
          await probe.query("select pg_advisory_unlock(hashtextextended($1, 0))", [deliveryId]);
        }
        await probe.query("select pg_advisory_unlock(hashtext($1), $2)", [
          `subscription-quota:${tenantId}`,
          4,
        ]);
      }
    } finally {
      if (quotaBarrierHeld) {
        await probe
          .query("select pg_advisory_unlock(hashtext($1), $2)", [
            `subscription-quota:${tenantId}`,
            4,
          ])
          .catch(() => undefined);
      }
      if (primaryPoolExpanded) setup.pool.options.max -= 1;
      probe.release();
      await app.close();
      try {
        const appSessions = await probeConnection.pool.query<{ count: number }>(
          "select count(*)::int as count from pg_stat_activity where application_name = $1",
          [applicationName],
        );
        expect(appSessions.rows).toEqual([{ count: 0 }]);
      } finally {
        await probeConnection.pool.end();
      }
    }
  }, 120_000);
});
