import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { and, asc, desc, eq, inArray, isNull, lte, or } from "drizzle-orm";
import { schema, type Db } from "@markiro/db";
import type { PlatformPrincipal, SupportEpisodeView } from "@markiro/platform-contracts";
import { DB } from "../../auth/auth.module";
import { platformCapabilitiesForRole } from "../../platform-auth/platform-access-policy";
import { PlatformAuditService } from "../../platform-auth/platform-audit.service";
import { SupportChatService } from "./support-chat.service";
import { SupportChatSyncService } from "./support-chat-sync.service";
import { SupportChatRepository } from "./support-chat.repository";
import { ChatwootClient } from "./chatwoot.client";
import { AuthorizationService } from "../../authorization/authorization.service";

@Injectable()
export class SupportChatJobsService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly support: SupportChatService,
    private readonly audit: PlatformAuditService,
    private readonly sync: SupportChatSyncService,
    private readonly repository: SupportChatRepository,
    private readonly chatwoot: ChatwootClient,
    private readonly authorization: AuthorizationService,
  ) {}

  /** Best-effort transport; the immutable job row is still due after a lost wake. */
  async repairAndWake(send: (jobId: string) => Promise<unknown>): Promise<number> {
    const now = new Date();
    const rows = await this.db
      .select({ id: schema.supportChatJobs.id })
      .from(schema.supportChatJobs)
      .where(
        and(
          or(
            inArray(schema.supportChatJobs.kind, ["import", "reconcile"]),
            and(
              eq(schema.supportChatJobs.kind, "send"),
              eq(schema.supportChatJobs.state, "pending"),
              isNull(schema.supportChatJobs.attemptToken),
            ),
          ),
          or(
            and(
              inArray(schema.supportChatJobs.state, ["pending", "failed"]),
              lte(schema.supportChatJobs.nextAttemptAt, now),
            ),
            and(
              eq(schema.supportChatJobs.state, "leased"),
              lte(schema.supportChatJobs.leaseExpiresAt, now),
            ),
          ),
        ),
      )
      .orderBy(asc(schema.supportChatJobs.nextAttemptAt), asc(schema.supportChatJobs.id))
      .limit(100);
    for (const row of rows) {
      try {
        await send(row.id);
      } catch {
        /* the next tick re-discovers this row */
      }
    }
    return rows.length;
  }

  /** Provisioning, definitely unclaimed sends and accepted imports have distinct lifecycles. */
  async run(jobId: string): Promise<boolean> {
    this.support.requireEnabled();
    const [job] = await this.db
      .select()
      .from(schema.supportChatJobs)
      .where(eq(schema.supportChatJobs.id, jobId));
    if (!job || job.state === "completed") return false;
    if (job.kind === "import") return this.sync.run(job.id);
    const found = await this.repository.episodeById(job.episodeId);
    if (
      !found ||
      !(await this.authorization.resolvePrincipal(found.owner.userId, found.episode.tenantId))
    )
      return false;
    if (job.kind === "send") {
      if (job.state !== "pending" || job.attemptToken || !job.messageId) return false;
      const [message] = await this.db
        .select()
        .from(schema.supportChatMessages)
        .where(
          and(
            eq(schema.supportChatMessages.id, job.messageId),
            eq(schema.supportChatMessages.episodeId, job.episodeId),
            eq(schema.supportChatMessages.tenantId, job.tenantId),
          ),
        );
      if (!message?.idempotencyKey || message.delivery !== "pending") return false;
      const result = await this.support.send(
        { tenantId: job.tenantId, userId: found.owner.userId },
        job.episodeId,
        { text: message.text, idempotencyKey: message.idempotencyKey },
      );
      if (result.delivery === "pending") await this.defer(job.id);
      return result.delivery === "sent";
    }
    try {
      const mapping = await this.chatwoot.ensureConversation(job.episodeId);
      if (mapping) return true;
    } catch {
      /* provisioning checkpoint prevents a blind retry of an ambiguous POST */
    }
    await this.defer(job.id);
    return false;
  }

  private async defer(jobId: string): Promise<void> {
    await this.db
      .update(schema.supportChatJobs)
      .set({ nextAttemptAt: new Date(Date.now() + 30_000), updatedAt: new Date() })
      .where(
        and(
          eq(schema.supportChatJobs.id, jobId),
          eq(schema.supportChatJobs.state, "pending"),
          isNull(schema.supportChatJobs.attemptToken),
        ),
      );
  }

  async retrySync(actor: PlatformPrincipal, episodeId: string): Promise<SupportEpisodeView> {
    this.support.requireEnabled();
    if (!actor.capabilities.includes("billing.write") || !actor.twoFactorReady)
      throw new ForbiddenException("Insufficient platform permissions");
    const episode = await this.db.transaction(async (tx) => {
      const [operator] = await tx
        .select()
        .from(schema.platformUsers)
        .where(eq(schema.platformUsers.id, actor.userId))
        .for("share");
      if (
        !operator ||
        operator.status !== "active" ||
        !operator.twoFactorEnabled ||
        !platformCapabilitiesForRole(operator.role).includes("billing.write")
      )
        throw new ForbiddenException("Insufficient platform permissions");
      const [verified] = await tx
        .select({ id: schema.platformTwoFactors.id })
        .from(schema.platformTwoFactors)
        .where(
          and(
            eq(schema.platformTwoFactors.userId, actor.userId),
            eq(schema.platformTwoFactors.verified, true),
          ),
        )
        .for("share");
      if (!verified) throw new ForbiddenException("Insufficient platform permissions");
      const [found] = await tx
        .select()
        .from(schema.supportChatEpisodes)
        .where(eq(schema.supportChatEpisodes.id, episodeId))
        .for("update");
      if (!found?.requestId) throw new NotFoundException();
      const [consent] = await tx
        .select()
        .from(schema.supportChatConsents)
        .where(
          and(
            eq(schema.supportChatConsents.tenantId, found.tenantId),
            eq(schema.supportChatConsents.episodeId, found.id),
            eq(schema.supportChatConsents.decision, "accept"),
          ),
        );
      if (!consent?.noticeLocale || !consent.noticeText)
        throw new ConflictException({ code: "consent_notice_unknown" });
      const [job] = await tx
        .select()
        .from(schema.supportChatJobs)
        .where(
          and(
            eq(schema.supportChatJobs.tenantId, found.tenantId),
            eq(schema.supportChatJobs.episodeId, found.id),
            eq(schema.supportChatJobs.kind, "import"),
          ),
        )
        .orderBy(desc(schema.supportChatJobs.createdAt), desc(schema.supportChatJobs.id))
        .limit(1)
        .for("update");
      if (!job) throw new ConflictException({ code: "import_job_missing" });
      const active =
        job.state === "leased" && job.leaseExpiresAt !== null && job.leaseExpiresAt > new Date();
      if (!active)
        await tx
          .update(schema.supportChatJobs)
          .set({
            state: "pending",
            attemptToken: null,
            leaseExpiresAt: null,
            retryCount: 0,
            nextAttemptAt: new Date(),
            lastErrorCode: null,
            checkpoint: { consentId: consent.id, initialComplete: false },
            updatedAt: new Date(),
          })
          .where(eq(schema.supportChatJobs.id, job.id));
      if (!active)
        await tx
          .update(schema.supportChatEpisodes)
          .set({
            transcriptState: "pending",
            updatedAt: new Date(),
          })
          .where(eq(schema.supportChatEpisodes.id, found.id));
      await this.audit.record(tx, {
        actorPlatformUserId: actor.userId,
        actorRole: operator.role,
        action: "support.transcript.retry_requested",
        outcome: "success",
        tenantId: found.tenantId,
        targetType: "support_chat_episode",
        targetId: found.id,
        reason: null,
        before: { state: job.state, retryCount: job.retryCount },
        after: { scheduled: !active, jobId: job.id },
        requestId: null,
      });
      return active ? found : { ...found, transcriptState: "pending" };
    });
    return this.support.view(episode);
  }
}
