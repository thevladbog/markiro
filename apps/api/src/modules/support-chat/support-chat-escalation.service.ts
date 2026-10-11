import { ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, eq, sql } from "drizzle-orm";
import { schema, type Db } from "@markiro/db";
import {
  supportTranscriptNotice,
  type SupportEpisodeView,
  type SupportOwner,
  type SupportTranscriptNoticeLocale,
} from "@markiro/platform-contracts";
import { DB } from "../../auth/auth.module";
import { platformCapabilitiesForRole } from "../../platform-auth/platform-access-policy";
import { PlatformAuditService } from "../../platform-auth/platform-audit.service";
import { SupportChatRepository } from "./support-chat.repository";
import { SupportChatService } from "./support-chat.service";
import {
  sameSupportOperatorAccessSnapshot,
  supportOperatorAccessAuditIds,
} from "./support-chat-operator-access";

export interface SupportDecisionInput {
  decision: "accept" | "decline";
  revision: number;
  noticeVersion: string;
  noticeLocale: SupportTranscriptNoticeLocale;
  idempotencyKey: string;
}

@Injectable()
export class SupportChatEscalationService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly support: SupportChatService,
    private readonly repository: SupportChatRepository,
    private readonly audit: PlatformAuditService,
  ) {}

  async decide(
    owner: SupportOwner,
    episodeId: string,
    proposalId: string,
    input: SupportDecisionInput,
  ): Promise<SupportEpisodeView> {
    this.support.requireEnabled();
    const notice = supportTranscriptNotice(input.noticeLocale);
    if (input.noticeVersion !== notice.version)
      throw new ConflictException({ code: "notice_version_stale" });
    await this.db.transaction(async (tx) => {
      // Membership is locked first so revocation cannot race a successful consent.
      const [membership] = await tx
        .select({ id: schema.member.id })
        .from(schema.member)
        .where(
          and(
            eq(schema.member.organizationId, owner.tenantId),
            eq(schema.member.userId, owner.userId),
          ),
        )
        .for("share");
      if (!membership) throw new NotFoundException();
      const [linked] = await tx
        .select({ episode: schema.supportChatEpisodes, owner: schema.supportChatOwners })
        .from(schema.supportChatEpisodes)
        .innerJoin(
          schema.supportChatOwners,
          and(
            eq(schema.supportChatOwners.tenantId, schema.supportChatEpisodes.tenantId),
            eq(schema.supportChatOwners.id, schema.supportChatEpisodes.ownerId),
          ),
        )
        .where(
          and(
            eq(schema.supportChatEpisodes.tenantId, owner.tenantId),
            eq(schema.supportChatEpisodes.id, episodeId),
            eq(schema.supportChatOwners.userId, owner.userId),
          ),
        )
        .for("update", { of: schema.supportChatEpisodes });
      if (!linked) throw new NotFoundException();
      const [proposal] = await tx
        .select()
        .from(schema.supportChatProposals)
        .where(
          and(
            eq(schema.supportChatProposals.tenantId, owner.tenantId),
            eq(schema.supportChatProposals.episodeId, episodeId),
            eq(schema.supportChatProposals.id, proposalId),
          ),
        )
        .for("update");
      if (!proposal) throw new NotFoundException();
      const [existingByKey] = await tx
        .select()
        .from(schema.supportChatConsents)
        .where(
          and(
            eq(schema.supportChatConsents.tenantId, owner.tenantId),
            eq(schema.supportChatConsents.episodeId, episodeId),
            eq(schema.supportChatConsents.idempotencyKey, input.idempotencyKey),
          ),
        );
      if (existingByKey) {
        if (
          existingByKey.proposalId !== proposalId ||
          existingByKey.revision !== input.revision ||
          existingByKey.decision !== input.decision ||
          existingByKey.noticeVersion !== input.noticeVersion ||
          existingByKey.noticeLocale !== input.noticeLocale
        )
          throw new ConflictException({ code: "idempotency_key_reused" });
        return;
      }
      if (
        proposal.state !== "pending" ||
        proposal.revision !== input.revision ||
        proposal.noticeVersion !== input.noticeVersion ||
        linked.episode.requestId
      )
        throw new ConflictException({ code: "proposal_stale" });
      // A refusal never widens access; operator revalidation applies to acceptance only.
      const [operator] =
        input.decision === "accept"
          ? await tx
              .select()
              .from(schema.platformUsers)
              .where(eq(schema.platformUsers.id, proposal.operatorId))
              .for("share")
          : [];
      if (input.decision === "accept") {
        const currentAccessAuditIds = await supportOperatorAccessAuditIds(tx, proposal.operatorId);
        if (
          !operator ||
          operator.status !== "active" ||
          !operator.twoFactorEnabled ||
          !platformCapabilitiesForRole(operator.role).includes("billing.write") ||
          !sameSupportOperatorAccessSnapshot(proposal.operatorAccessAuditIds, currentAccessAuditIds)
        )
          throw new ConflictException({ code: "proposal_operator_revoked" });
        const [verified] = await tx
          .select({ id: schema.platformTwoFactors.id })
          .from(schema.platformTwoFactors)
          .where(
            and(
              eq(schema.platformTwoFactors.userId, operator.id),
              eq(schema.platformTwoFactors.verified, true),
            ),
          )
          .for("share");
        if (!verified) throw new ConflictException({ code: "proposal_operator_revoked" });
      }
      const now = new Date();
      const [consent] = await tx
        .insert(schema.supportChatConsents)
        .values({
          tenantId: owner.tenantId,
          episodeId,
          proposalId,
          revision: proposal.revision,
          userId: owner.userId,
          decision: input.decision,
          noticeVersion: notice.version,
          noticeLocale: notice.locale,
          noticeText: notice.text,
          acceptedTitle: proposal.title,
          acceptedSummary: proposal.summary,
          operatorId: proposal.operatorId,
          idempotencyKey: input.idempotencyKey,
          snapshotThrough: input.decision === "accept" ? now : null,
        })
        .returning();
      if (!consent) throw new Error("Support consent insert failed");
      await tx
        .update(schema.supportChatProposals)
        .set({ state: input.decision === "accept" ? "accepted" : "declined", decidedAt: now })
        .where(eq(schema.supportChatProposals.id, proposalId));
      await tx.insert(schema.tenantAuditEvents).values({
        organizationId: owner.tenantId,
        actorUserId: owner.userId,
        action:
          input.decision === "accept" ? "support.consent.accepted" : "support.consent.declined",
        outcome: "success",
        targetType: "support_chat_proposal",
        targetId: proposalId,
        before: { revision: proposal.revision },
        after: {
          consentId: consent.id,
          noticeVersion: notice.version,
          noticeLocale: notice.locale,
          initiatedByUserId: owner.userId,
          proposedByPlatformUserId: proposal.operatorId,
        },
      });
      if (input.decision === "decline") return;
      const sequence = await tx.execute<{ value: string }>(
        sql`select nextval('tenant_billing_request_number_seq')::text as value`,
      );
      const value = sequence.rows[0]?.value;
      if (!value) throw new Error("Billing request sequence unavailable");
      const number = `BR-${value.padStart(6, "0")}`;
      const [request] = await tx
        .insert(schema.tenantBillingRequests)
        .values({
          tenantId: owner.tenantId,
          number,
          type: "support",
          description: proposal.summary,
          contextType: "support_chat_episode",
          contextId: episodeId,
          idempotencyKey: proposal.id,
          createdByUserId: owner.userId,
        })
        .returning();
      if (!request) throw new Error("Support billing request insert failed");
      await tx.insert(schema.tenantBillingRequestEvents).values({
        tenantId: owner.tenantId,
        requestId: request.id,
        kind: "created",
        actorKind: "platform_user",
        actorPlatformUserId: proposal.operatorId,
        idempotencyKey: proposal.id,
        metadata: {
          type: "support",
          source: "support_chat_consent",
          consentId: consent.id,
          initiatedByUserId: owner.userId,
          proposedByPlatformUserId: proposal.operatorId,
        },
      });
      await tx
        .update(schema.supportChatEpisodes)
        .set({ requestId: request.id, transcriptState: "pending", updatedAt: now })
        .where(
          and(
            eq(schema.supportChatEpisodes.tenantId, owner.tenantId),
            eq(schema.supportChatEpisodes.id, episodeId),
          ),
        );
      await tx.insert(schema.supportChatJobs).values({
        tenantId: owner.tenantId,
        episodeId,
        kind: "import",
        checkpoint: { consentId: consent.id, snapshotThrough: now.toISOString() },
      });
      await this.audit.record(tx, {
        actorPlatformUserId: proposal.operatorId,
        actorRole: operator!.role,
        action: "support.escalation.created",
        outcome: "success",
        tenantId: owner.tenantId,
        targetType: "tenant_billing_request",
        targetId: request.id,
        reason: null,
        before: null,
        after: {
          episodeId,
          proposalId,
          consentId: consent.id,
          initiatedByUserId: owner.userId,
          proposedByPlatformUserId: proposal.operatorId,
        },
        requestId: null,
      });
    });
    const episode = await this.repository.findEpisode(owner, episodeId);
    if (!episode) throw new NotFoundException();
    return this.support.view(episode);
  }
}
