import { randomBytes, randomUUID } from "node:crypto";
import { join } from "node:path";
import { ConflictException, NotFoundException } from "@nestjs/common";
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
