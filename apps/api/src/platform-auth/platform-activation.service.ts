import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  Optional,
} from "@nestjs/common";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { hashPassword } from "better-auth/crypto";
import { schema, type Db, type PlatformRole } from "@markiro/db";
import { platformActivationCompleteRequestSchema } from "@markiro/platform-contracts";
import { z } from "zod";
import { DB } from "../auth/auth.module";
import { MailDeliveryService } from "../modules/mail/mail-delivery.service";
import { PlatformAuditService } from "./platform-audit.service";

export const PLATFORM_ACTIVATION_BASE_URL = "PLATFORM_ACTIVATION_BASE_URL";
export const PLATFORM_ACTIVATION_RUNTIME = "PLATFORM_ACTIVATION_RUNTIME";
const ACTIVATION_TTL_MS = 60 * 60 * 1_000;
const ACTIVE_DELIVERY_STATUSES = ["queued", "retrying", "failed", "canceled"] as const;
const hashCredentialPassword = hashPassword as unknown as (password: string) => Promise<string>;

const emailSchema = z
  .string()
  .transform((value) => value.trim().toLocaleLowerCase("en-US"))
  .pipe(z.email());
const passwordSchema = z.string().min(8).max(128);

export interface PlatformActivationRuntime {
  now?: () => Date;
  createId?: () => string;
  createToken?: () => string;
}

export interface InvitePlatformUserInput {
  actorPlatformUserId: string | null;
  actorRole: PlatformRole | null;
  email: string;
  role: PlatformRole;
  idempotent: boolean;
  auditAction?: string;
}

export interface PlatformActivationIssueResult {
  userId: string;
  deliveryId: string;
}

@Injectable()
export class PlatformActivationService {
  private readonly now: () => Date;
  private readonly createId: () => string;
  private readonly createToken: () => string;

  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly mail: MailDeliveryService,
    private readonly audit: PlatformAuditService,
    @Inject(PLATFORM_ACTIVATION_BASE_URL) private readonly activationBaseUrl: string,
    @Optional()
    @Inject(PLATFORM_ACTIVATION_RUNTIME)
    runtime?: PlatformActivationRuntime,
  ) {
    this.now = runtime?.now ?? (() => new Date());
    this.createId = runtime?.createId ?? randomUUID;
    this.createToken = runtime?.createToken ?? (() => randomBytes(24).toString("base64url"));
  }

  async invite(input: InvitePlatformUserInput): Promise<PlatformActivationIssueResult> {
    const email = emailSchema.parse(input.email);
    const result = await this.db.transaction(async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`platform-user-email:${email}`}, 0))`,
      );
      const [existing] = await tx
        .select({ id: schema.platformUsers.id, role: schema.platformUsers.role })
        .from(schema.platformUsers)
        .where(eq(schema.platformUsers.email, email))
        .limit(1);
      if (existing) {
        if (!input.idempotent || existing.role !== input.role) {
          await this.audit.record(tx, {
            actorPlatformUserId: input.actorPlatformUserId,
            actorRole: input.actorRole,
            action:
              input.auditAction === "platform.admin.provisioned"
                ? "platform.admin.provision_denied"
                : "platform.team.invitation_denied",
            outcome: "denied",
            tenantId: null,
            targetType: "platform_user",
            targetId: existing.id,
            reason: "platform_user_exists",
            before: { role: existing.role },
            after: { requestedRole: input.role },
            requestId: null,
          });
          return { kind: "denied" } as const;
        }
        const [delivery] = await tx
          .select({ id: schema.emailDeliveries.id })
          .from(schema.emailDeliveries)
          .where(eq(schema.emailDeliveries.platformUserId, existing.id))
          .orderBy(desc(schema.emailDeliveries.createdAt), desc(schema.emailDeliveries.id))
          .limit(1);
        if (!delivery) throw new ConflictException({ code: "platform_activation_missing" });
        return {
          kind: "success",
          value: { userId: existing.id, deliveryId: delivery.id },
        } as const;
      }

      const userId = this.createId();
      await tx.insert(schema.platformUsers).values({
        id: userId,
        name: email,
        email,
        emailVerified: false,
        role: input.role,
        status: "invited",
        twoFactorEnabled: false,
        createdAt: this.now(),
        updatedAt: this.now(),
      });
      const deliveryId = await this.issueInTransaction(tx, userId, email);
      await this.audit.record(tx, {
        actorPlatformUserId: input.actorPlatformUserId,
        actorRole: input.actorRole,
        action: input.auditAction ?? "platform.team.invited",
        outcome: "success",
        tenantId: null,
        targetType: "platform_user",
        targetId: userId,
        reason: null,
        before: null,
        after: { role: input.role, status: "invited" },
        requestId: null,
      });
      return { kind: "success", value: { userId, deliveryId } } as const;
    });
    if (result.kind === "denied") {
      throw new ConflictException({ code: "platform_user_exists" });
    }
    return result.value;
  }

  async renew(input: {
    actorPlatformUserId: string | null;
    actorRole: PlatformRole | null;
    userId: string;
  }): Promise<PlatformActivationIssueResult> {
    const result = await this.db.transaction(async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`platform-user:${input.userId}`}, 0))`,
      );
      const [user] = await tx
        .select({
          email: schema.platformUsers.email,
          role: schema.platformUsers.role,
          status: schema.platformUsers.status,
        })
        .from(schema.platformUsers)
        .where(eq(schema.platformUsers.id, input.userId))
        .limit(1);
      if (!user || user.status !== "invited") {
        await this.audit.record(tx, {
          actorPlatformUserId: input.actorPlatformUserId,
          actorRole: input.actorRole,
          action: "platform.team.activation_renewal_denied",
          outcome: "denied",
          tenantId: null,
          targetType: "platform_user",
          targetId: input.userId,
          reason: "platform_activation_not_renewable",
          before: user ? { role: user.role, status: user.status } : null,
          after: null,
          requestId: null,
        });
        return { kind: "denied", code: "platform_activation_not_renewable" } as const;
      }

      const sourceId = activationSourceId(input.userId);
      const deliveries = await tx
        .select({ id: schema.emailDeliveries.id, status: schema.emailDeliveries.status })
        .from(schema.emailDeliveries)
        .where(
          and(
            eq(schema.emailDeliveries.sourceId, sourceId),
            eq(schema.emailDeliveries.platformUserId, input.userId),
          ),
        )
        .orderBy(desc(schema.emailDeliveries.createdAt), desc(schema.emailDeliveries.id));
      for (const delivery of deliveries) {
        const lock = await tx.execute(
          sql<{
            locked: boolean;
          }>`select pg_try_advisory_xact_lock(hashtextextended(${delivery.id}, 0)) as locked`,
        );
        if (lock.rows[0]?.locked !== true || delivery.status === "sending") {
          await this.audit.record(tx, {
            actorPlatformUserId: input.actorPlatformUserId,
            actorRole: input.actorRole,
            action: "platform.team.activation_renewal_denied",
            outcome: "denied",
            tenantId: null,
            targetType: "platform_user",
            targetId: input.userId,
            reason: "delivery_in_flight",
            before: { role: user.role, status: user.status },
            after: null,
            requestId: null,
          });
          return { kind: "denied", code: "delivery_in_flight" } as const;
        }
      }
      const deliveryIds = deliveries.map((delivery) => delivery.id);
      if (deliveryIds.length > 0) {
        await tx
          .update(schema.emailDeliveries)
          .set({
            encryptedPayload: null,
            payloadNonce: null,
            payloadTag: null,
            updatedAt: this.now(),
          })
          .where(inArray(schema.emailDeliveries.id, deliveryIds));
        await tx
          .update(schema.emailDeliveries)
          .set({
            status: "canceled",
            attemptId: null,
            attemptDeadline: null,
            terminalAt: this.now(),
            updatedAt: this.now(),
          })
          .where(
            and(
              inArray(schema.emailDeliveries.id, deliveryIds),
              inArray(schema.emailDeliveries.status, ACTIVE_DELIVERY_STATUSES),
            ),
          );
        await tx
          .delete(schema.emailOutbox)
          .where(inArray(schema.emailOutbox.deliveryId, deliveryIds));
      }
      await tx
        .delete(schema.platformVerifications)
        .where(eq(schema.platformVerifications.value, activationSubject(input.userId)));

      const deliveryId = await this.issueInTransaction(tx, input.userId, user.email);
      await this.audit.record(tx, {
        actorPlatformUserId: input.actorPlatformUserId,
        actorRole: input.actorRole,
        action: "platform.team.activation_renewed",
        outcome: "success",
        tenantId: null,
        targetType: "platform_user",
        targetId: input.userId,
        reason: null,
        before: null,
        after: { status: "invited" },
        requestId: null,
      });
      return {
        kind: "success",
        value: { userId: input.userId, deliveryId },
      } as const;
    });
    if (result.kind === "denied") {
      throw new ConflictException({ code: result.code });
    }
    return result.value;
  }

  async complete(
    token: string,
    input: { password: string },
  ): Promise<{ twoFactorEnrollmentRequired: true }> {
    if (token.length < 16 || token.length > 512) {
      await this.db.transaction((tx) =>
        this.recordCompletionDenial(tx, {
          targetId: null,
          reason: "malformed_token",
          before: null,
        }),
      );
      throw new NotFoundException({ code: "activation_unavailable" });
    }
    const password = passwordSchema.parse(input.password);
    const identifier = activationIdentifier(token);
    const result = await this.db.transaction(async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`platform-activation:${identifier}`}, 0))`,
      );
      const [initialVerification] = await tx
        .select({
          value: schema.platformVerifications.value,
          expiresAt: schema.platformVerifications.expiresAt,
        })
        .from(schema.platformVerifications)
        .where(eq(schema.platformVerifications.identifier, identifier))
        .limit(1);
      const initialUserId = initialVerification
        ? parseActivationSubject(initialVerification.value)
        : null;
      if (!initialVerification || initialVerification.expiresAt <= this.now() || !initialUserId) {
        await this.recordCompletionDenial(tx, {
          targetId: initialUserId,
          reason: "activation_unavailable",
          before: null,
        });
        return { kind: "denied", code: "activation_unavailable" } as const;
      }

      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`platform-user:${initialUserId}`}, 0))`,
      );
      const [verification] = await tx
        .select({
          value: schema.platformVerifications.value,
          expiresAt: schema.platformVerifications.expiresAt,
        })
        .from(schema.platformVerifications)
        .where(eq(schema.platformVerifications.identifier, identifier))
        .limit(1);
      const reloadedUserId = verification ? parseActivationSubject(verification.value) : null;
      if (
        !verification ||
        verification.expiresAt <= this.now() ||
        reloadedUserId !== initialUserId
      ) {
        await this.recordCompletionDenial(tx, {
          targetId: initialUserId,
          reason: "activation_unavailable",
          before: null,
        });
        return { kind: "denied", code: "activation_unavailable" } as const;
      }

      const userId = initialUserId;
      const [user] = await tx
        .select({ status: schema.platformUsers.status })
        .from(schema.platformUsers)
        .where(eq(schema.platformUsers.id, userId))
        .limit(1);
      if (!user || user.status !== "invited") {
        await this.recordCompletionDenial(tx, {
          targetId: userId,
          reason: "platform_user_not_invited",
          before: user ? { status: user.status } : null,
        });
        return { kind: "denied", code: "activation_unavailable" } as const;
      }
      const [account] = await tx
        .select({ id: schema.platformAccounts.id, password: schema.platformAccounts.password })
        .from(schema.platformAccounts)
        .where(
          and(
            eq(schema.platformAccounts.userId, userId),
            eq(schema.platformAccounts.providerId, "credential"),
          ),
        )
        .limit(1);
      if (account?.password) {
        await this.recordCompletionDenial(tx, {
          targetId: userId,
          reason: "existing_credential",
          before: { status: user.status },
        });
        return { kind: "denied", code: "existing_credential" } as const;
      }
      const passwordHash = await hashCredentialPassword(password);
      const activated = await tx
        .update(schema.platformUsers)
        .set({
          status: "active",
          emailVerified: true,
          twoFactorEnabled: false,
          updatedAt: this.now(),
        })
        .where(and(eq(schema.platformUsers.id, userId), eq(schema.platformUsers.status, "invited")))
        .returning({ id: schema.platformUsers.id });
      if (activated.length !== 1) {
        await this.recordCompletionDenial(tx, {
          targetId: userId,
          reason: "platform_user_not_invited",
          before: { status: user.status },
        });
        return { kind: "denied", code: "activation_unavailable" } as const;
      }
      if (account) {
        await tx
          .update(schema.platformAccounts)
          .set({ password: passwordHash, updatedAt: this.now() })
          .where(eq(schema.platformAccounts.id, account.id));
      } else {
        await tx.insert(schema.platformAccounts).values({
          id: this.createId(),
          accountId: userId,
          providerId: "credential",
          userId,
          password: passwordHash,
          createdAt: this.now(),
          updatedAt: this.now(),
        });
      }
      await tx
        .delete(schema.platformVerifications)
        .where(eq(schema.platformVerifications.identifier, identifier));
      await this.audit.record(tx, {
        actorPlatformUserId: null,
        actorRole: null,
        action: "platform.activation.completed",
        outcome: "success",
        tenantId: null,
        targetType: "platform_user",
        targetId: userId,
        reason: null,
        before: { status: "invited" },
        after: { status: "active", twoFactorEnrollmentRequired: true },
        requestId: null,
      });
      return { kind: "success" } as const;
    });
    if (result.kind === "denied") {
      if (result.code === "existing_credential") {
        throw new BadRequestException({ code: result.code });
      }
      throw new NotFoundException({ code: "activation_unavailable" });
    }
    return { twoFactorEnrollmentRequired: true };
  }

  async completePublicRequest(input: unknown): Promise<{ twoFactorEnrollmentRequired: true }> {
    const parsed = platformActivationCompleteRequestSchema.safeParse(input);
    if (!parsed.success) {
      await this.db.transaction((tx) =>
        this.recordCompletionDenial(tx, {
          targetId: null,
          reason: "malformed_request",
          before: null,
        }),
      );
      throw new NotFoundException({ code: "activation_unavailable" });
    }
    return this.complete(parsed.data.token, { password: parsed.data.password });
  }

  private async recordCompletionDenial(
    tx: Parameters<Parameters<Db["transaction"]>[0]>[0],
    input: { targetId: string | null; reason: string; before: unknown },
  ): Promise<void> {
    await this.audit.record(tx, {
      actorPlatformUserId: null,
      actorRole: null,
      action: "platform.activation.denied",
      outcome: "denied",
      tenantId: null,
      targetType: "platform_user",
      targetId: input.targetId,
      reason: input.reason,
      before: input.before,
      after: null,
      requestId: null,
    });
  }

  private async issueInTransaction(
    tx: Parameters<Parameters<Db["transaction"]>[0]>[0],
    userId: string,
    email: string,
  ): Promise<string> {
    const token = this.createToken();
    const expiresAt = new Date(this.now().getTime() + ACTIVATION_TTL_MS);
    await tx.insert(schema.platformVerifications).values({
      id: this.createId(),
      identifier: activationIdentifier(token),
      value: activationSubject(userId),
      expiresAt,
      createdAt: this.now(),
      updatedAt: this.now(),
    });
    const actionUrl = new URL("/activate", this.activationBaseUrl);
    actionUrl.hash = new URLSearchParams({ token }).toString();
    return this.mail.enqueue(tx, {
      scope: { platformUserId: userId },
      recipient: email,
      sourceId: activationSourceId(userId),
      template: {
        kind: "platform-user-activation",
        recipientName: "Пользователь",
        actionUrl: actionUrl.toString(),
        expiresInMinutes: 60,
      },
    });
  }
}

function activationIdentifier(token: string): string {
  return `platform-user-activation:${createHash("sha256").update(token).digest("hex")}`;
}

function activationSubject(userId: string): string {
  return JSON.stringify({ userId });
}

function activationSourceId(userId: string): string {
  return `platform-activation:${userId}`;
}

function parseActivationSubject(value: string): string | null {
  try {
    const parsed = JSON.parse(value) as { userId?: unknown };
    if (typeof parsed.userId === "string") return parsed.userId;
  } catch {
    // The public error intentionally matches an unknown or expired token.
  }
  return null;
}
