import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { and, desc, eq } from "drizzle-orm";
import { schema, type Db } from "@markiro/db";
import type { PlatformPrincipal, SupportProposal } from "@markiro/platform-contracts";
import { DB } from "../../auth/auth.module";
import { platformCapabilitiesForRole } from "../../platform-auth/platform-access-policy";
import { PlatformAuditService } from "../../platform-auth/platform-audit.service";
import { SupportChatService } from "./support-chat.service";
import {
  sameSupportOperatorAccessSnapshot,
  supportOperatorAccessAuditIds,
} from "./support-chat-operator-access";

@Injectable()
export class SupportChatProposalsService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly support: SupportChatService,
    private readonly audit: PlatformAuditService,
  ) {}

  async propose(
    actor: PlatformPrincipal,
    episodeId: string,
    input: { title: string; summary: string; idempotencyKey: string },
  ): Promise<SupportProposal> {
    this.support.requireEnabled();
    if (!actor.capabilities.includes("billing.write") || !actor.twoFactorReady)
      throw new ForbiddenException("Insufficient platform permissions");
    return this.db.transaction(async (tx) => {
      const [episode] = await tx
        .select()
        .from(schema.supportChatEpisodes)
        .where(eq(schema.supportChatEpisodes.id, episodeId))
        .for("update");
      if (!episode) throw new NotFoundException();
      const [latest] = await tx
        .select()
        .from(schema.supportChatProposals)
        .where(
          and(
            eq(schema.supportChatProposals.tenantId, episode.tenantId),
            eq(schema.supportChatProposals.episodeId, episode.id),
          ),
        )
        .orderBy(desc(schema.supportChatProposals.revision))
        .limit(1)
        .for("update");
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
      const operatorAccessAuditIds = await supportOperatorAccessAuditIds(tx, actor.userId);
      const [prior] = await tx
        .select()
        .from(schema.supportChatProposals)
        .where(
          and(
            eq(schema.supportChatProposals.tenantId, episode.tenantId),
            eq(schema.supportChatProposals.episodeId, episode.id),
            eq(schema.supportChatProposals.idempotencyKey, input.idempotencyKey),
          ),
        );
      if (prior) {
        if (
          prior.title !== input.title ||
          prior.summary !== input.summary ||
          prior.operatorId !== actor.userId
        )
          throw new ConflictException({ code: "idempotency_key_reused" });
        return publicProposal(prior);
      }
      if (episode.requestId) throw new ConflictException({ code: "episode_already_escalated" });
      if (latest?.state === "pending") {
        const [priorOperator] = await tx
          .select()
          .from(schema.platformUsers)
          .where(eq(schema.platformUsers.id, latest.operatorId))
          .for("share");
        const priorAccessAuditIds = await supportOperatorAccessAuditIds(tx, latest.operatorId);
        if (
          priorOperator &&
          priorOperator.status === "active" &&
          priorOperator.twoFactorEnabled &&
          platformCapabilitiesForRole(priorOperator.role).includes("billing.write") &&
          sameSupportOperatorAccessSnapshot(latest.operatorAccessAuditIds, priorAccessAuditIds)
        )
          throw new ConflictException({ code: "proposal_pending" });
        await tx
          .update(schema.supportChatProposals)
          .set({ state: "declined", decidedAt: new Date() })
          .where(eq(schema.supportChatProposals.id, latest.id));
        await this.audit.record(tx, {
          actorPlatformUserId: actor.userId,
          actorRole: operator.role,
          action: "support.proposal.superseded",
          outcome: "success",
          tenantId: episode.tenantId,
          targetType: "support_chat_proposal",
          targetId: latest.id,
          reason: "operator_access_changed",
          before: { revision: latest.revision },
          after: { nextRevision: latest.revision + 1 },
          requestId: null,
        });
      }
      const [proposal] = await tx
        .insert(schema.supportChatProposals)
        .values({
          tenantId: episode.tenantId,
          episodeId: episode.id,
          revision: (latest?.revision ?? 0) + 1,
          title: input.title,
          summary: input.summary,
          operatorId: actor.userId,
          operatorAccessAuditIds,
          idempotencyKey: input.idempotencyKey,
        })
        .returning();
      if (!proposal) throw new Error("Support proposal insert failed");
      await this.audit.record(tx, {
        actorPlatformUserId: actor.userId,
        actorRole: operator.role,
        action: "support.proposal.created",
        outcome: "success",
        tenantId: episode.tenantId,
        targetType: "support_chat_proposal",
        targetId: proposal.id,
        reason: null,
        before: null,
        after: { episodeId: episode.id, revision: proposal.revision },
        requestId: null,
      });
      return publicProposal(proposal);
    });
  }
}

export function publicProposal(
  row: typeof schema.supportChatProposals.$inferSelect,
): SupportProposal {
  return {
    id: row.id,
    revision: row.revision,
    title: row.title,
    summary: row.summary,
    noticeVersion: "support-transcript-v1",
    state: row.state,
  };
}
