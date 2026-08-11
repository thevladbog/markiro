import { ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, eq, sql } from "drizzle-orm";
import { schema, type Db, type PlatformRole } from "@markiro/db";
import { DB } from "../auth/auth.module";
import type { PlatformPrincipal } from "./platform-access-policy";
import { PlatformActivationService } from "./platform-activation.service";
import { PlatformAuditService } from "./platform-audit.service";

@Injectable()
export class PlatformTeamService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly activation: PlatformActivationService,
    private readonly audit: PlatformAuditService,
  ) {}

  list() {
    return this.db
      .select({
        id: schema.platformUsers.id,
        name: schema.platformUsers.name,
        email: schema.platformUsers.email,
        role: schema.platformUsers.role,
        status: schema.platformUsers.status,
        twoFactorReady: schema.platformUsers.twoFactorEnabled,
        createdAt: schema.platformUsers.createdAt,
      })
      .from(schema.platformUsers)
      .orderBy(schema.platformUsers.email);
  }

  invite(actor: PlatformPrincipal, input: { email: string; role: PlatformRole }) {
    return this.activation.invite({
      actorPlatformUserId: actor.userId,
      actorRole: actor.role,
      email: input.email,
      role: input.role,
      idempotent: false,
    });
  }

  renewActivation(actor: PlatformPrincipal, userId: string) {
    return this.activation.renew({
      actorPlatformUserId: actor.userId,
      actorRole: actor.role,
      userId,
    });
  }

  async changeRole(actor: PlatformPrincipal, userId: string, role: PlatformRole): Promise<void> {
    const outcome = await this.db.transaction(async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`platform-user:${userId}`}, 0))`,
      );
      const [target] = await tx
        .select({ role: schema.platformUsers.role, status: schema.platformUsers.status })
        .from(schema.platformUsers)
        .where(eq(schema.platformUsers.id, userId))
        .limit(1);
      if (!target) {
        await this.audit.record(
          tx,
          teamAudit(
            actor,
            userId,
            "platform.team.role_change_denied",
            "denied",
            null,
            { role },
            "platform_user_not_found",
          ),
        );
        return "not_found" as const;
      }
      if (target.role === "platform_admin" && target.status === "active" && role !== target.role) {
        await lockActiveAdminInvariant(tx);
        if ((await activeAdminCount(tx)) <= 1) {
          await this.audit.record(
            tx,
            teamAudit(actor, userId, "platform.team.role_change_denied", "denied", target, {
              role,
            }),
          );
          return "last_admin" as const;
        }
      }
      await tx
        .update(schema.platformUsers)
        .set({ role, updatedAt: new Date() })
        .where(eq(schema.platformUsers.id, userId));
      await this.audit.record(
        tx,
        teamAudit(actor, userId, "platform.team.role_changed", "success", target, {
          role,
          status: target.status,
        }),
      );
      return "success" as const;
    });
    if (outcome === "last_admin") throw new ConflictException({ code: "last_active_admin" });
    if (outcome === "not_found") {
      throw new NotFoundException({ code: "platform_user_not_found" });
    }
  }

  async suspend(actor: PlatformPrincipal, userId: string): Promise<void> {
    const outcome = await this.db.transaction(async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`platform-user:${userId}`}, 0))`,
      );
      const [target] = await tx
        .select({ role: schema.platformUsers.role, status: schema.platformUsers.status })
        .from(schema.platformUsers)
        .where(eq(schema.platformUsers.id, userId))
        .limit(1);
      if (!target) {
        await this.audit.record(
          tx,
          teamAudit(
            actor,
            userId,
            "platform.team.suspension_denied",
            "denied",
            null,
            { status: "suspended" },
            "platform_user_not_found",
          ),
        );
        return "not_found" as const;
      }
      if (target.role === "platform_admin" && target.status === "active") {
        await lockActiveAdminInvariant(tx);
        if ((await activeAdminCount(tx)) <= 1) {
          await this.audit.record(
            tx,
            teamAudit(actor, userId, "platform.team.suspension_denied", "denied", target, {
              status: "suspended",
            }),
          );
          return "last_admin" as const;
        }
      }
      await tx
        .update(schema.platformUsers)
        .set({ status: "suspended", updatedAt: new Date() })
        .where(eq(schema.platformUsers.id, userId));
      await tx.delete(schema.platformSessions).where(eq(schema.platformSessions.userId, userId));
      await this.audit.record(
        tx,
        teamAudit(actor, userId, "platform.team.suspended", "success", target, {
          role: target.role,
          status: "suspended",
        }),
      );
      return "success" as const;
    });
    if (outcome === "last_admin") throw new ConflictException({ code: "last_active_admin" });
    if (outcome === "not_found") {
      throw new NotFoundException({ code: "platform_user_not_found" });
    }
  }

  async recoverTwoFactor(actor: PlatformPrincipal, userId: string): Promise<void> {
    const outcome = await this.db.transaction(async (tx) => {
      const [target] = await tx
        .select({ role: schema.platformUsers.role, status: schema.platformUsers.status })
        .from(schema.platformUsers)
        .where(eq(schema.platformUsers.id, userId))
        .limit(1);
      if (!target) {
        await this.audit.record(
          tx,
          teamAudit(
            actor,
            userId,
            "platform.team.two_factor_recovery_denied",
            "denied",
            null,
            { twoFactorReady: false },
            "platform_user_not_found",
          ),
        );
        return "not_found" as const;
      }
      await tx
        .delete(schema.platformTwoFactors)
        .where(eq(schema.platformTwoFactors.userId, userId));
      await tx.delete(schema.platformSessions).where(eq(schema.platformSessions.userId, userId));
      await tx
        .update(schema.platformUsers)
        .set({ twoFactorEnabled: false, updatedAt: new Date() })
        .where(eq(schema.platformUsers.id, userId));
      await this.audit.record(
        tx,
        teamAudit(actor, userId, "platform.team.two_factor_recovered", "success", target, {
          role: target.role,
          status: target.status,
          twoFactorReady: false,
        }),
      );
      return "success" as const;
    });
    if (outcome === "not_found") {
      throw new NotFoundException({ code: "platform_user_not_found" });
    }
  }
}

async function lockActiveAdminInvariant(tx: Parameters<Parameters<Db["transaction"]>[0]>[0]) {
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended('platform-active-admin-invariant', 0))`,
  );
}

async function activeAdminCount(tx: Parameters<Parameters<Db["transaction"]>[0]>[0]) {
  const [row] = await tx
    .select({ count: sql<number>`count(*)::int` })
    .from(schema.platformUsers)
    .where(
      and(
        eq(schema.platformUsers.role, "platform_admin"),
        eq(schema.platformUsers.status, "active"),
      ),
    );
  return row?.count ?? 0;
}

function teamAudit(
  actor: PlatformPrincipal,
  targetId: string,
  action: string,
  outcome: string,
  before: unknown,
  after: unknown,
  deniedReason?: string,
) {
  return {
    actorPlatformUserId: actor.userId,
    actorRole: actor.role,
    action,
    outcome,
    tenantId: null,
    targetType: "platform_user",
    targetId,
    reason: outcome === "denied" ? (deniedReason ?? "last_active_admin") : null,
    before,
    after,
    requestId: null,
  };
}
