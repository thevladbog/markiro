import {
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from "@nestjs/common";
import { and, desc, eq, gt, isNull, sql } from "drizzle-orm";
import { schema, type Db } from "@markiro/db";
import { DB } from "../../auth/auth.module";
import { loadEnv } from "../../env";
import { generateDeviceToken, hashDeviceToken, hashPairingCode } from "../../pickup/device-token";
import {
  mintPairingCode,
  PAIR_CODE_MAX_ATTEMPTS,
  PAIRING_TTL_MS,
  pairAttemptWindowStart,
} from "../device-pairing/pairing-policy";
import { PairAttemptsService } from "../device-pairing/pair-attempts.service";
import { JournalService } from "../integrations/journal.service";
import { CHZ_CHANNEL_TYPE, CHZ_TOKEN_REFRESH_LEAD_MS } from "./chz-constants";
import type {
  IssueSignerPairingCodeResultDto,
  PairSignerAgentResultDto,
  SignerAgentsOverviewDto,
  SignerTokenStatusDto,
} from "./dto";

const MINT_ATTEMPTS = 5;

class PairingCodeHashCollisionError extends Error {}

@Injectable()
export class SignerAgentsService {
  private readonly logger = new Logger(SignerAgentsService.name);

  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly pairAttempts: PairAttemptsService,
    private readonly journal: JournalService,
  ) {}

  async overview(tenantId: string): Promise<SignerAgentsOverviewDto> {
    const agents = await this.db
      .select()
      .from(schema.chzSignerAgents)
      .where(eq(schema.chzSignerAgents.tenantId, tenantId))
      .orderBy(desc(schema.chzSignerAgents.createdAt));
    const [token] = await this.db
      .select()
      .from(schema.chzApiTokens)
      .where(eq(schema.chzApiTokens.tenantId, tenantId));
    return {
      agents: agents.map((a) => ({
        id: a.id,
        name: a.name,
        appVersion: a.appVersion,
        status: a.status as "active" | "revoked",
        certThumbprint: a.certThumbprint,
        certSubject: a.certSubject,
        certInn: a.certInn,
        certNotAfter: a.certNotAfter?.toISOString() ?? null,
        lastSeenAt: a.lastSeenAt?.toISOString() ?? null,
        createdAt: a.createdAt.toISOString(),
      })),
      token: this.tokenStatus(token ?? null),
    };
  }

  private tokenStatus(token: typeof schema.chzApiTokens.$inferSelect | null): SignerTokenStatusDto {
    if (!token) {
      return { status: "none", obtainedAt: null, expiresAt: null, certThumbprint: null };
    }
    const now = Date.now();
    const expiresAt = token.expiresAt.getTime();
    const status =
      expiresAt <= now
        ? "expired"
        : expiresAt <= now + CHZ_TOKEN_REFRESH_LEAD_MS
          ? "expiring"
          : "active";
    return {
      status,
      obtainedAt: token.obtainedAt.toISOString(),
      expiresAt: token.expiresAt.toISOString(),
      certThumbprint: token.certThumbprint,
    };
  }

  async issuePairingCode(
    tenantId: string,
    userId: string,
  ): Promise<IssueSignerPairingCodeResultDto> {
    const expiresAt = new Date(Date.now() + PAIRING_TTL_MS);
    const pepper = loadEnv().PAIRING_CODE_PEPPER;
    for (let attempt = 0; attempt < MINT_ATTEMPTS; attempt++) {
      const code = mintPairingCode();
      const codeHash = hashPairingCode(code, pepper);
      try {
        await this.db.transaction(async (tx) => {
          await tx
            .update(schema.chzSignerPairingCodes)
            .set({ usedAt: new Date() })
            .where(
              and(
                eq(schema.chzSignerPairingCodes.tenantId, tenantId),
                isNull(schema.chzSignerPairingCodes.usedAt),
              ),
            );
          const [clash] = await tx
            .select({ id: schema.chzSignerPairingCodes.id })
            .from(schema.chzSignerPairingCodes)
            .where(
              and(
                eq(schema.chzSignerPairingCodes.codeHash, codeHash),
                isNull(schema.chzSignerPairingCodes.usedAt),
              ),
            );
          if (clash) throw new PairingCodeHashCollisionError();
          await tx.insert(schema.chzSignerPairingCodes).values({
            tenantId,
            codeHash,
            expiresAt,
            issuedByUserId: userId,
          });
        });
      } catch (error) {
        if (error instanceof PairingCodeHashCollisionError || this.isUniqueViolation(error)) {
          continue;
        }
        throw error;
      }
      return { code, expiresAt };
    }
    throw new Error("Could not mint a unique signer pairing code");
  }

  /**
   * 23505 detection mirroring station-pairing.service.ts's `constraint()`
   * helper, simplified: any unique violation here (either the code-hash-live
   * backstop or a same-tenant race on the one-live-code index) must re-mint,
   * never surface to the caller.
   */
  private isUniqueViolation(error: unknown): boolean {
    const err = error as { code?: string; cause?: { code?: string } };
    return err?.code === "23505" || err?.cause?.code === "23505";
  }

  async revoke(tenantId: string, agentId: string): Promise<void> {
    // Отзыв агента = отзыв доступа: чистим токен тенанта (спека, §Security). The
    // agent UPDATE and token DELETE must be atomic — otherwise a failure between
    // them leaves the agent revoked but the tenant's True API token alive, with no
    // way to retry (the UPDATE's WHERE status='active' no longer matches).
    const revoked = await this.db.transaction(async (tx) => {
      const [revoked] = await tx
        .update(schema.chzSignerAgents)
        .set({ status: "revoked", revokedAt: new Date() })
        .where(
          and(
            eq(schema.chzSignerAgents.tenantId, tenantId),
            eq(schema.chzSignerAgents.id, agentId),
            eq(schema.chzSignerAgents.status, "active"),
          ),
        )
        .returning({ id: schema.chzSignerAgents.id, name: schema.chzSignerAgents.name });
      if (!revoked) throw new NotFoundException();
      await tx.delete(schema.chzApiTokens).where(eq(schema.chzApiTokens.tenantId, tenantId));
      return revoked;
    });
    // Post-commit side effect: the revoke has already been committed, so a journal
    // failure here must never throw and must never turn into a 500.
    await this.journal
      .append({
        tenantId,
        channelType: CHZ_CHANNEL_TYPE,
        sessionId: null,
        direction: "local",
        outcome: "warn",
        grain: "session",
        message: `Signer agent revoked: ${revoked.name}`,
      })
      .catch((e) => this.logger.warn(`signer agent revoke journal append failed: ${e}`));
  }

  async pair(
    code: string,
    source: string,
    hostname: string,
    appVersion: string,
  ): Promise<PairSignerAgentResultDto> {
    const now = new Date();
    const windowStart = pairAttemptWindowStart(now);
    await this.pairAttempts.assertUnderPairRateLimit(source, windowStart);
    const result = await this.attemptPair(code, now, hostname, appVersion);
    await this.pairAttempts
      .refundPairAttempt(source, windowStart)
      .catch((e) => this.logger.warn(`pair attempt refund failed: ${e}`));
    // Post-commit side effect: the pairing has already been committed (code spent,
    // agent row inserted) and the one-time agentSecret must reach the caller, so a
    // journal failure here must never throw and must never turn into a 500.
    await this.journal
      .append({
        tenantId: result.tenantId,
        channelType: CHZ_CHANNEL_TYPE,
        sessionId: null,
        direction: "in",
        outcome: "ok",
        grain: "session",
        message: `Signer agent paired: ${hostname}`,
      })
      .catch((e) => this.logger.warn(`signer agent pair journal append failed: ${e}`));
    return result.dto;
  }

  private async attemptPair(
    code: string,
    now: Date,
    hostname: string,
    appVersion: string,
  ): Promise<{ tenantId: string; dto: PairSignerAgentResultDto }> {
    const pepper = loadEnv().PAIRING_CODE_PEPPER;
    const codeHash = hashPairingCode(code, pepper);
    const rows = await this.db
      .select({
        id: schema.chzSignerPairingCodes.id,
        tenantId: schema.chzSignerPairingCodes.tenantId,
        expiresAt: schema.chzSignerPairingCodes.expiresAt,
        usedAt: schema.chzSignerPairingCodes.usedAt,
        attempts: schema.chzSignerPairingCodes.attempts,
        tenantName: schema.organization.name,
      })
      .from(schema.chzSignerPairingCodes)
      .innerJoin(
        schema.organization,
        eq(schema.organization.id, schema.chzSignerPairingCodes.tenantId),
      )
      .where(eq(schema.chzSignerPairingCodes.codeHash, codeHash))
      .orderBy(desc(schema.chzSignerPairingCodes.createdAt));
    const live = rows.filter((r) => r.usedAt === null && r.expiresAt > now);
    if (live.length > 1) throw new UnauthorizedException(); // кросс-тенантная коллизия hash — отказ, не угадывание
    const candidate = live[0] ?? rows[0];
    if (!candidate) throw new UnauthorizedException();
    if (candidate.attempts >= PAIR_CODE_MAX_ATTEMPTS) throw new UnauthorizedException();
    if (candidate.usedAt !== null || candidate.expiresAt <= now) {
      await this.db
        .update(schema.chzSignerPairingCodes)
        .set({ attempts: candidate.attempts + 1 })
        .where(eq(schema.chzSignerPairingCodes.id, candidate.id));
      throw new UnauthorizedException();
    }

    const secret = generateDeviceToken();
    const secretHash = hashDeviceToken(secret);
    const agentId = await this.db.transaction(async (tx) => {
      const [claimed] = await tx
        .update(schema.chzSignerPairingCodes)
        .set({ usedAt: new Date() })
        .where(
          and(
            eq(schema.chzSignerPairingCodes.id, candidate.id),
            isNull(schema.chzSignerPairingCodes.usedAt),
            gt(schema.chzSignerPairingCodes.expiresAt, sql`now()`),
          ),
        )
        .returning({ id: schema.chzSignerPairingCodes.id });
      if (!claimed) throw new UnauthorizedException();
      const [agent] = await tx
        .insert(schema.chzSignerAgents)
        .values({ tenantId: candidate.tenantId, name: hostname, appVersion, secretHash })
        .returning({ id: schema.chzSignerAgents.id });
      if (!agent) throw new Error("Signer agent insert returned no row");
      return agent.id;
    });
    return {
      tenantId: candidate.tenantId,
      dto: { agentId, agentSecret: secret, tenantName: candidate.tenantName },
    };
  }
}
