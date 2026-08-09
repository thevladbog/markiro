import { randomBytes, randomUUID } from "node:crypto";
import { join } from "node:path";
import { BadRequestException, ConflictException, NotFoundException } from "@nestjs/common";
import { createDb, schema, type PlatformRole } from "@markiro/db";
import { and, eq, sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MailCryptoService } from "../src/modules/mail/mail-crypto.service";
import { MailDeliveryService } from "../src/modules/mail/mail-delivery.service";
import type { PlatformPrincipal } from "../src/platform-auth/platform-access-policy";
import { PlatformActivationService } from "../src/platform-auth/platform-activation.service";
import { PlatformAuditService } from "../src/platform-auth/platform-audit.service";
import { PlatformTeamService } from "../src/platform-auth/platform-team.service";

const ready = Boolean(process.env.DATABASE_URL);

describe.skipIf(!ready)("platform activation and team management", () => {
  const audit = new PlatformAuditService();
  const tokens: string[] = [];
  const databaseName = `markiro_platform_team_${randomUUID().replaceAll("-", "_")}`;
  const maintenanceUrl = process.env.DATABASE_URL ?? "postgres://invalid";
  const scratchUrl = new URL(maintenanceUrl);
  scratchUrl.pathname = `/${databaseName}`;
  scratchUrl.search = "";
  const maintenanceConnection = createDb(maintenanceUrl);
  let connection: ReturnType<typeof createDb>;
  let activation: PlatformActivationService;
  let team: PlatformTeamService;
  let currentTime = new Date("2026-08-09T12:00:00Z");
  let activationBarrierInstalled = false;

  beforeAll(async () => {
    await maintenanceConnection.pool.query(`CREATE DATABASE "${databaseName}"`);
    connection = createDb(scratchUrl.toString());
    await migrate(connection.db, {
      migrationsFolder: join(__dirname, "../../../packages/db/migrations"),
    });
    activation = new PlatformActivationService(
      connection.db,
      new MailDeliveryService(new MailCryptoService(Buffer.alloc(32, 0x6a))),
      audit,
      "https://saas.example.test",
      {
        now: () => currentTime,
        createId: randomUUID,
        createToken: () => {
          const token = randomBytes(24).toString("base64url");
          tokens.push(token);
          return token;
        },
      },
    );
    team = new PlatformTeamService(connection.db, activation, audit);
  }, 120_000);

  afterAll(async () => {
    await connection.pool.end();
    await maintenanceConnection.pool.query(`DROP DATABASE "${databaseName}"`);
    await maintenanceConnection.pool.end();
  });

  function principal(userId: string, role: PlatformRole = "platform_admin"): PlatformPrincipal {
    return {
      userId,
      role,
      capabilities: ["platformTeam.write"],
      twoFactorReady: true,
    };
  }

  async function holdActivationUpdateBarrier(): Promise<() => Promise<void>> {
    if (!activationBarrierInstalled) {
      await connection.pool.query(
        "CREATE TABLE platform_activation_test_barrier (lock_key text NOT NULL)",
      );
      await connection.pool.query(`
        CREATE FUNCTION wait_for_platform_activation_test_barrier() RETURNS trigger
        LANGUAGE plpgsql AS $$
        DECLARE current_key text;
        BEGIN
          SELECT lock_key INTO current_key FROM platform_activation_test_barrier LIMIT 1;
          IF current_key IS NOT NULL THEN
            PERFORM pg_advisory_xact_lock(hashtextextended(current_key, 0));
          END IF;
          RETURN NEW;
        END
        $$
      `);
      await connection.pool.query(`
        CREATE TRIGGER wait_for_platform_activation_test_barrier
        BEFORE INSERT ON platform_accounts
        FOR EACH ROW
        WHEN (new.provider_id = 'credential')
        EXECUTE FUNCTION wait_for_platform_activation_test_barrier()
      `);
      activationBarrierInstalled = true;
    }

    const lockKey = `platform-activation-test-barrier:${randomUUID()}`;
    await connection.pool.query("TRUNCATE platform_activation_test_barrier");
    await connection.pool.query(
      "INSERT INTO platform_activation_test_barrier (lock_key) VALUES ($1)",
      [lockKey],
    );
    const client = await connection.pool.connect();
    await client.query("SELECT pg_advisory_lock(hashtextextended($1, 0))", [lockKey]);
    return async () => {
      await client.query("SELECT pg_advisory_unlock(hashtextextended($1, 0))", [lockKey]);
      client.release();
    };
  }

  async function advisoryWaiterCount(): Promise<number> {
    const result = await connection.pool.query<{ count: number }>(`
      SELECT count(*)::int AS count
      FROM pg_locks
      WHERE locktype = 'advisory'
        AND granted = false
        AND database = (SELECT oid FROM pg_database WHERE datname = current_database())
    `);
    return result.rows[0]?.count ?? 0;
  }

  async function waitUntil(predicate: () => Promise<boolean>): Promise<void> {
    for (let attempt = 0; attempt < 500; attempt += 1) {
      if (await predicate()) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error("Timed out waiting for a deterministic database race boundary");
  }

  it("consumes activation once and leaves the user requiring TOTP enrollment", async () => {
    const email = `activation-${randomUUID()}@example.invalid`;
    const issued = await activation.invite({
      actorPlatformUserId: null,
      actorRole: null,
      email,
      role: "support",
      idempotent: false,
    });
    const token = tokens.at(-1)!;
    const password = randomBytes(24).toString("base64url");

    await expect(activation.complete(token, { password })).resolves.toEqual({
      twoFactorEnrollmentRequired: true,
    });
    await expect(activation.complete(token, { password })).rejects.toBeInstanceOf(
      NotFoundException,
    );

    const [user] = await connection.db
      .select({
        status: schema.platformUsers.status,
        emailVerified: schema.platformUsers.emailVerified,
        twoFactorEnabled: schema.platformUsers.twoFactorEnabled,
      })
      .from(schema.platformUsers)
      .where(eq(schema.platformUsers.id, issued.userId));
    expect(user).toEqual({ status: "active", emailVerified: true, twoFactorEnabled: false });
    const [account] = await connection.db
      .select({ password: schema.platformAccounts.password })
      .from(schema.platformAccounts)
      .where(eq(schema.platformAccounts.userId, issued.userId));
    expect(account?.password).toBeTruthy();
    expect(account?.password).not.toBe(password);

    const [delivery] = await connection.db
      .select({
        platformUserId: schema.emailDeliveries.platformUserId,
        tenantId: schema.emailDeliveries.tenantId,
        userId: schema.emailDeliveries.userId,
        encryptedPayload: schema.emailDeliveries.encryptedPayload,
      })
      .from(schema.emailDeliveries)
      .where(eq(schema.emailDeliveries.id, issued.deliveryId));
    expect(delivery).toMatchObject({
      platformUserId: issued.userId,
      tenantId: null,
      userId: null,
    });
    expect(delivery?.encryptedPayload).toBeInstanceOf(Buffer);
    expect(delivery?.encryptedPayload?.includes(Buffer.from(token))).toBe(false);
  });

  it("rejects an expired activation and invalidates it when renewal issues a new token", async () => {
    currentTime = new Date("2026-08-09T12:00:00Z");
    const issued = await activation.invite({
      actorPlatformUserId: null,
      actorRole: null,
      email: `renew-${randomUUID()}@example.invalid`,
      role: "accountant",
      idempotent: false,
    });
    const expiredToken = tokens.at(-1)!;
    currentTime = new Date("2026-08-09T13:00:01Z");
    await expect(
      activation.complete(expiredToken, { password: randomBytes(24).toString("base64url") }),
    ).rejects.toBeInstanceOf(NotFoundException);

    const renewed = await activation.renew({
      actorPlatformUserId: null,
      actorRole: null,
      userId: issued.userId,
    });
    const renewedToken = tokens.at(-1)!;
    expect(renewed.deliveryId).not.toBe(issued.deliveryId);
    await expect(
      activation.complete(expiredToken, { password: randomBytes(24).toString("base64url") }),
    ).rejects.toBeInstanceOf(NotFoundException);
    await expect(
      activation.complete(renewedToken, { password: randomBytes(24).toString("base64url") }),
    ).resolves.toEqual({ twoFactorEnrollmentRequired: true });
  });

  it("renews only deliveries scoped to the target platform user when source IDs collide", async () => {
    currentTime = new Date("2026-08-09T14:00:00Z");
    const issued = await activation.invite({
      actorPlatformUserId: null,
      actorRole: null,
      email: `scoped-renew-${randomUUID()}@example.invalid`,
      role: "support",
      idempotent: false,
    });
    const unrelatedUserId = randomUUID();
    const unrelatedDeliveryId = randomUUID();
    await connection.db.insert(schema.platformUsers).values({
      id: unrelatedUserId,
      name: "Unrelated platform user",
      email: `unrelated-${randomUUID()}@example.invalid`,
      emailVerified: false,
      role: "accountant",
      status: "invited",
      twoFactorEnabled: false,
    });
    await connection.db.insert(schema.emailDeliveries).values({
      id: unrelatedDeliveryId,
      platformUserId: unrelatedUserId,
      recipient: "unrelated@example.invalid",
      kind: "platform-user-activation",
      sourceId: `platform-activation:${issued.userId}`,
      status: "queued",
      encryptedPayload: Buffer.from("unrelated-encrypted-payload"),
      payloadNonce: Buffer.alloc(12, 0x31),
      payloadTag: Buffer.alloc(16, 0x32),
    });
    await connection.db.insert(schema.emailOutbox).values({ deliveryId: unrelatedDeliveryId });

    await activation.renew({
      actorPlatformUserId: null,
      actorRole: null,
      userId: issued.userId,
    });

    const [unrelatedDelivery] = await connection.db
      .select({
        status: schema.emailDeliveries.status,
        encryptedPayload: schema.emailDeliveries.encryptedPayload,
      })
      .from(schema.emailDeliveries)
      .where(eq(schema.emailDeliveries.id, unrelatedDeliveryId));
    const unrelatedOutbox = await connection.db
      .select({ deliveryId: schema.emailOutbox.deliveryId })
      .from(schema.emailOutbox)
      .where(eq(schema.emailOutbox.deliveryId, unrelatedDeliveryId));
    expect(unrelatedDelivery).toEqual({
      status: "queued",
      encryptedPayload: Buffer.from("unrelated-encrypted-payload"),
    });
    expect(unrelatedOutbox).toEqual([{ deliveryId: unrelatedDeliveryId }]);
  });

  it("serializes activation before a concurrent suspension so suspension remains final", async () => {
    currentTime = new Date("2026-08-09T15:00:00Z");
    const issued = await activation.invite({
      actorPlatformUserId: null,
      actorRole: null,
      email: `activation-suspension-${randomUUID()}@example.invalid`,
      role: "support",
      idempotent: false,
    });
    const token = tokens.at(-1)!;
    const releaseBarrier = await holdActivationUpdateBarrier();
    const completion = activation.complete(token, {
      password: randomBytes(24).toString("base64url"),
    });
    let outcomes: Promise<PromiseSettledResult<unknown>[]> | undefined;
    try {
      await waitUntil(async () => (await advisoryWaiterCount()) >= 1);

      let suspensionSettled = false;
      const suspension = team
        .suspend(principal(issued.userId), issued.userId)
        .finally(() => (suspensionSettled = true));
      outcomes = Promise.allSettled([completion, suspension]);
      await waitUntil(async () => suspensionSettled || (await advisoryWaiterCount()) >= 2);
    } finally {
      await releaseBarrier();
    }

    if (!outcomes) throw new Error("Suspension race did not reach the mutation boundary");
    expect((await outcomes).map((result) => result.status)).toEqual(["fulfilled", "fulfilled"]);
    const [user] = await connection.db
      .select({ status: schema.platformUsers.status })
      .from(schema.platformUsers)
      .where(eq(schema.platformUsers.id, issued.userId));
    expect(user?.status).toBe("suspended");
  }, 15_000);

  it("serializes activation before renewal so an active user gets no replacement", async () => {
    currentTime = new Date("2026-08-09T16:00:00Z");
    const issued = await activation.invite({
      actorPlatformUserId: null,
      actorRole: null,
      email: `activation-renewal-${randomUUID()}@example.invalid`,
      role: "accountant",
      idempotent: false,
    });
    const token = tokens.at(-1)!;
    const releaseBarrier = await holdActivationUpdateBarrier();
    const completion = activation.complete(token, {
      password: randomBytes(24).toString("base64url"),
    });
    let outcomes: Promise<PromiseSettledResult<unknown>[]> | undefined;
    try {
      await waitUntil(async () => (await advisoryWaiterCount()) >= 1);

      let renewalSettled = false;
      const renewal = activation
        .renew({ actorPlatformUserId: null, actorRole: null, userId: issued.userId })
        .finally(() => (renewalSettled = true));
      outcomes = Promise.allSettled([completion, renewal]);
      await waitUntil(async () => renewalSettled || (await advisoryWaiterCount()) >= 2);
    } finally {
      await releaseBarrier();
    }

    if (!outcomes) throw new Error("Renewal race did not reach the mutation boundary");
    const [completionOutcome, renewalOutcome] = await outcomes;
    expect(completionOutcome?.status).toBe("fulfilled");
    expect(renewalOutcome?.status).toBe("rejected");
    if (renewalOutcome?.status === "rejected") {
      expect(renewalOutcome.reason).toBeInstanceOf(ConflictException);
    }
    const deliveries = await connection.db
      .select({ id: schema.emailDeliveries.id })
      .from(schema.emailDeliveries)
      .where(eq(schema.emailDeliveries.platformUserId, issued.userId));
    expect(deliveries).toEqual([{ id: issued.deliveryId }]);
  }, 15_000);

  it("audits malformed, unavailable, wrong-state, and credential activation denials", async () => {
    const credentialValues: string[] = [];

    const malformedToken = randomBytes(4).toString("base64url");
    const malformedPassword = randomBytes(24).toString("base64url");
    credentialValues.push(malformedToken, malformedPassword);
    await expect(
      activation.complete(malformedToken, { password: malformedPassword }),
    ).rejects.toBeInstanceOf(NotFoundException);

    currentTime = new Date("2026-08-09T17:00:00Z");
    await activation.invite({
      actorPlatformUserId: null,
      actorRole: null,
      email: `expired-denial-${randomUUID()}@example.invalid`,
      role: "support",
      idempotent: false,
    });
    const expiredToken = tokens.at(-1)!;
    const expiredPassword = randomBytes(24).toString("base64url");
    credentialValues.push(expiredToken, expiredPassword);
    currentTime = new Date("2026-08-09T18:00:01Z");
    await expect(
      activation.complete(expiredToken, { password: expiredPassword }),
    ).rejects.toBeInstanceOf(NotFoundException);

    currentTime = new Date("2026-08-09T18:30:00Z");
    await activation.invite({
      actorPlatformUserId: null,
      actorRole: null,
      email: `consumed-denial-${randomUUID()}@example.invalid`,
      role: "support",
      idempotent: false,
    });
    const consumedToken = tokens.at(-1)!;
    const consumedPassword = randomBytes(24).toString("base64url");
    credentialValues.push(consumedToken, consumedPassword);
    await activation.complete(consumedToken, { password: consumedPassword });
    await expect(
      activation.complete(consumedToken, { password: consumedPassword }),
    ).rejects.toBeInstanceOf(NotFoundException);

    currentTime = new Date("2026-08-09T19:00:00Z");
    const wrongState = await activation.invite({
      actorPlatformUserId: null,
      actorRole: null,
      email: `wrong-state-denial-${randomUUID()}@example.invalid`,
      role: "accountant",
      idempotent: false,
    });
    const wrongStateToken = tokens.at(-1)!;
    const wrongStatePassword = randomBytes(24).toString("base64url");
    credentialValues.push(wrongStateToken, wrongStatePassword);
    await connection.db
      .update(schema.platformUsers)
      .set({ status: "suspended" })
      .where(eq(schema.platformUsers.id, wrongState.userId));
    await expect(
      activation.complete(wrongStateToken, { password: wrongStatePassword }),
    ).rejects.toBeInstanceOf(NotFoundException);

    const existingCredential = await activation.invite({
      actorPlatformUserId: null,
      actorRole: null,
      email: `credential-denial-${randomUUID()}@example.invalid`,
      role: "support",
      idempotent: false,
    });
    const credentialToken = tokens.at(-1)!;
    const credentialPassword = randomBytes(24).toString("base64url");
    credentialValues.push(credentialToken, credentialPassword);
    await connection.db.insert(schema.platformAccounts).values({
      id: randomUUID(),
      accountId: existingCredential.userId,
      providerId: "credential",
      userId: existingCredential.userId,
      password: "existing-hash-test-value",
    });
    await expect(
      activation.complete(credentialToken, { password: credentialPassword }),
    ).rejects.toBeInstanceOf(BadRequestException);

    const denials = await connection.db
      .select({
        reason: schema.platformAuditEvents.reason,
        before: schema.platformAuditEvents.before,
        after: schema.platformAuditEvents.after,
      })
      .from(schema.platformAuditEvents)
      .where(eq(schema.platformAuditEvents.action, "platform.activation.denied"));
    expect(denials.map((event) => event.reason)).toEqual(
      expect.arrayContaining([
        "malformed_token",
        "activation_unavailable",
        "platform_user_not_invited",
        "existing_credential",
      ]),
    );
    expect(
      denials.filter((event) => event.reason === "activation_unavailable").length,
    ).toBeGreaterThanOrEqual(2);
    const serializedDenials = JSON.stringify(denials);
    expect(credentialValues.some((value) => serializedDenials.includes(value))).toBe(false);
  });

  it("keeps at least one active platform admin while supporting suspension and 2FA recovery", async () => {
    const soleAdminId = randomUUID();
    await connection.db.insert(schema.platformUsers).values({
      id: soleAdminId,
      name: "Sole admin",
      email: `sole-admin-${randomUUID()}@example.invalid`,
      emailVerified: true,
      role: "platform_admin",
      status: "active",
      twoFactorEnabled: true,
    });
    await connection.db.insert(schema.platformTwoFactors).values({
      id: randomUUID(),
      userId: soleAdminId,
      secret: "encrypted-test-value",
      backupCodes: "encrypted-test-value",
      verified: true,
    });

    await expect(team.suspend(principal(soleAdminId), soleAdminId)).rejects.toBeInstanceOf(
      ConflictException,
    );
    await expect(
      team.changeRole(principal(soleAdminId), soleAdminId, "support"),
    ).rejects.toBeInstanceOf(ConflictException);

    const secondAdminId = randomUUID();
    await connection.db.insert(schema.platformUsers).values({
      id: secondAdminId,
      name: "Second admin",
      email: `second-admin-${randomUUID()}@example.invalid`,
      emailVerified: true,
      role: "platform_admin",
      status: "active",
      twoFactorEnabled: true,
    });
    await expect(team.suspend(principal(secondAdminId), soleAdminId)).resolves.toBeUndefined();
    await expect(
      team.recoverTwoFactor(principal(secondAdminId), secondAdminId),
    ).resolves.toBeUndefined();

    const [recovered] = await connection.db
      .select({ twoFactorEnabled: schema.platformUsers.twoFactorEnabled })
      .from(schema.platformUsers)
      .where(eq(schema.platformUsers.id, secondAdminId));
    expect(recovered?.twoFactorEnabled).toBe(false);
    const remainingFactors = await connection.db
      .select({ id: schema.platformTwoFactors.id })
      .from(schema.platformTwoFactors)
      .where(eq(schema.platformTwoFactors.userId, secondAdminId));
    expect(remainingFactors).toEqual([]);

    const denials = await connection.db
      .select({
        action: schema.platformAuditEvents.action,
        outcome: schema.platformAuditEvents.outcome,
      })
      .from(schema.platformAuditEvents)
      .where(
        and(
          eq(schema.platformAuditEvents.actorPlatformUserId, soleAdminId),
          eq(schema.platformAuditEvents.outcome, "denied"),
        ),
      );
    expect(denials.map((event) => event.action)).toEqual(
      expect.arrayContaining([
        "platform.team.suspension_denied",
        "platform.team.role_change_denied",
      ]),
    );

    const duplicateEmail = `duplicate-${randomUUID()}@example.invalid`;
    await team.invite(principal(secondAdminId), {
      email: duplicateEmail,
      role: "support",
    });
    await expect(
      team.invite(principal(secondAdminId), { email: duplicateEmail, role: "support" }),
    ).rejects.toBeInstanceOf(ConflictException);
    const duplicateDenials = await connection.db
      .select({ action: schema.platformAuditEvents.action })
      .from(schema.platformAuditEvents)
      .where(
        and(
          eq(schema.platformAuditEvents.actorPlatformUserId, secondAdminId),
          eq(schema.platformAuditEvents.outcome, "denied"),
        ),
      );
    expect(duplicateDenials.map((event) => event.action)).toContain(
      "platform.team.invitation_denied",
    );
  });

  it("serializes concurrent admin suspensions so one active admin remains", async () => {
    const [currentAdmin] = await connection.db
      .select({ id: schema.platformUsers.id })
      .from(schema.platformUsers)
      .where(
        and(
          eq(schema.platformUsers.role, "platform_admin"),
          eq(schema.platformUsers.status, "active"),
        ),
      );
    if (!currentAdmin) throw new Error("Expected an active platform admin from the prior scenario");
    const firstAdminId = currentAdmin.id;
    const secondAdminId = randomUUID();
    await connection.db.insert(schema.platformUsers).values({
      id: secondAdminId,
      name: "Concurrent admin two",
      email: `concurrent-admin-two-${randomUUID()}@example.invalid`,
      emailVerified: true,
      role: "platform_admin",
      status: "active",
      twoFactorEnabled: true,
    });
    await connection.db.execute(sql`
      create function delay_platform_admin_suspension() returns trigger
      language plpgsql as $$
      begin
        perform pg_sleep(0.25);
        return new;
      end
      $$
    `);
    await connection.db.execute(sql`
      create trigger delay_platform_admin_suspension
      before update on platform_users
      for each row
      when (new.status = 'suspended' and old.status = 'active')
      execute function delay_platform_admin_suspension()
    `);

    const results = await Promise.allSettled([
      team.suspend(principal(firstAdminId), firstAdminId),
      team.suspend(principal(secondAdminId), secondAdminId),
    ]);
    expect(results.map((result) => result.status).sort()).toEqual(["fulfilled", "rejected"]);
    const rejection = results.find((result) => result.status === "rejected");
    expect(rejection?.reason).toBeInstanceOf(ConflictException);
    const [remaining] = await connection.db
      .select({ count: sql<number>`count(*)::int` })
      .from(schema.platformUsers)
      .where(
        and(
          eq(schema.platformUsers.role, "platform_admin"),
          eq(schema.platformUsers.status, "active"),
        ),
      );
    expect(remaining?.count).toBe(1);
  });

  it("audits rejected team mutations for an unknown target", async () => {
    const [actor] = await connection.db
      .select({ id: schema.platformUsers.id })
      .from(schema.platformUsers)
      .where(
        and(
          eq(schema.platformUsers.role, "platform_admin"),
          eq(schema.platformUsers.status, "active"),
        ),
      );
    if (!actor) throw new Error("Expected an active platform admin");
    const missingUserId = randomUUID();
    await expect(
      team.changeRole(principal(actor.id), missingUserId, "support"),
    ).rejects.toBeInstanceOf(NotFoundException);
    await expect(team.suspend(principal(actor.id), missingUserId)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    await expect(team.recoverTwoFactor(principal(actor.id), missingUserId)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    await expect(team.renewActivation(principal(actor.id), missingUserId)).rejects.toBeInstanceOf(
      ConflictException,
    );

    const denials = await connection.db
      .select({
        action: schema.platformAuditEvents.action,
        reason: schema.platformAuditEvents.reason,
      })
      .from(schema.platformAuditEvents)
      .where(
        and(
          eq(schema.platformAuditEvents.actorPlatformUserId, actor.id),
          eq(schema.platformAuditEvents.targetId, missingUserId),
          eq(schema.platformAuditEvents.outcome, "denied"),
        ),
      );
    expect(denials).toEqual(
      expect.arrayContaining([
        { action: "platform.team.role_change_denied", reason: "platform_user_not_found" },
        { action: "platform.team.suspension_denied", reason: "platform_user_not_found" },
        {
          action: "platform.team.two_factor_recovery_denied",
          reason: "platform_user_not_found",
        },
        {
          action: "platform.team.activation_renewal_denied",
          reason: "platform_activation_not_renewable",
        },
      ]),
    );
  });
});
