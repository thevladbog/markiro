import { randomUUID } from "node:crypto";
import { BadRequestException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, eq, gt, sql } from "drizzle-orm";
import { hashPassword } from "better-auth/crypto";
import { schema, type Db } from "@markiro/db";
import { DB } from "../../auth/auth.module";
import type { CompleteTenantOwnerActivationDto, TenantOwnerActivationStatusDto } from "./dto";
import { activationIdentifier } from "./token";

const hashCredentialPassword = hashPassword as unknown as (password: string) => Promise<string>;

interface ActivationSubject {
  userId: string;
  tenantId: string;
}

@Injectable()
export class TenantOwnerActivationService {
  constructor(@Inject(DB) private readonly db: Db) {}

  async getStatus(token: string): Promise<TenantOwnerActivationStatusDto> {
    const subject = await this.requirePending(token);
    return { hasAccount: await this.hasCredential(subject.userId) };
  }

  async complete(
    token: string,
    input: Omit<CompleteTenantOwnerActivationDto, "token">,
  ): Promise<void> {
    const identifier = activationIdentifier(token);
    await this.db.transaction(async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`tenant-owner-activation:${identifier}`}, 0))`,
      );
      const [verification] = await tx
        .select({ value: schema.verification.value })
        .from(schema.verification)
        .where(
          and(
            eq(schema.verification.identifier, identifier),
            gt(schema.verification.expiresAt, new Date()),
          ),
        )
        .limit(1);
      if (!verification) throw new NotFoundException({ code: "activation_unavailable" });
      const subject = parseSubject(verification.value);
      const [owner] = await tx
        .select({ userId: schema.user.id })
        .from(schema.member)
        .innerJoin(schema.user, eq(schema.user.id, schema.member.userId))
        .where(
          and(
            eq(schema.member.organizationId, subject.tenantId),
            eq(schema.member.userId, subject.userId),
            eq(schema.member.role, "owner"),
          ),
        )
        .limit(1);
      if (!owner) throw new NotFoundException({ code: "activation_unavailable" });

      const [credential] = await tx
        .select({ id: schema.account.id, password: schema.account.password })
        .from(schema.account)
        .where(
          and(
            eq(schema.account.userId, subject.userId),
            eq(schema.account.providerId, "credential"),
          ),
        )
        .limit(1);
      const hasCredential = Boolean(credential?.password);
      if (!hasCredential && !input.password) {
        throw new BadRequestException({ code: "password_required" });
      }
      if (hasCredential && input.password) {
        throw new BadRequestException({ code: "existing_credential" });
      }
      if (!hasCredential) {
        const password = await hashCredentialPassword(input.password!);
        if (credential) {
          await tx
            .update(schema.account)
            .set({ password, updatedAt: new Date() })
            .where(eq(schema.account.id, credential.id));
        } else {
          await tx.insert(schema.account).values({
            id: randomUUID(),
            accountId: subject.userId,
            providerId: "credential",
            userId: subject.userId,
            password,
          });
        }
      }
      await tx
        .update(schema.user)
        .set({ emailVerified: true, updatedAt: new Date() })
        .where(eq(schema.user.id, subject.userId));
      await tx.delete(schema.verification).where(eq(schema.verification.identifier, identifier));
    });
  }

  private async requirePending(token: string): Promise<ActivationSubject> {
    const [verification] = await this.db
      .select({ value: schema.verification.value })
      .from(schema.verification)
      .where(
        and(
          eq(schema.verification.identifier, activationIdentifier(token)),
          gt(schema.verification.expiresAt, new Date()),
        ),
      )
      .limit(1);
    if (!verification) throw new NotFoundException({ code: "activation_unavailable" });
    return parseSubject(verification.value);
  }

  private async hasCredential(userId: string): Promise<boolean> {
    const [credential] = await this.db
      .select({ password: schema.account.password })
      .from(schema.account)
      .where(and(eq(schema.account.userId, userId), eq(schema.account.providerId, "credential")))
      .limit(1);
    return Boolean(credential?.password);
  }
}

function parseSubject(value: string): ActivationSubject {
  try {
    const parsed = JSON.parse(value) as Partial<ActivationSubject>;
    if (typeof parsed.userId === "string" && typeof parsed.tenantId === "string") {
      return { userId: parsed.userId, tenantId: parsed.tenantId };
    }
  } catch {
    // Deliberately return the same public state as an unknown or expired token.
  }
  throw new NotFoundException({ code: "activation_unavailable" });
}
