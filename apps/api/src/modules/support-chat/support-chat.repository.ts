import { BadRequestException, ConflictException, Inject, Injectable } from "@nestjs/common";
import { and, asc, desc, eq, gt, isNull, lt, lte, or, sql } from "drizzle-orm";
import { schema, type Db } from "@markiro/db";
import { DB } from "../../auth/auth.module";
import type { SupportOwner } from "@markiro/platform-contracts";
import type { ChatwootMapping, PublicChatwootMessage } from "./chatwoot-message.schema";

export type EpisodeRow = typeof schema.supportChatEpisodes.$inferSelect;
export type OwnerRow = typeof schema.supportChatOwners.$inferSelect;
export type MessageRow = typeof schema.supportChatMessages.$inferSelect;
export type PrivateHistoryCheckpoint = {
  stage: "ready";
  before?: number;
  highWater?: number;
  target?: number;
  initialComplete?: boolean;
};

@Injectable()
export class SupportChatRepository {
  constructor(@Inject(DB) private readonly db: Db) {}

  async state(episode: EpisodeRow) {
    const [proposal] = await this.db
      .select()
      .from(schema.supportChatProposals)
      .where(
        and(
          eq(schema.supportChatProposals.tenantId, episode.tenantId),
          eq(schema.supportChatProposals.episodeId, episode.id),
        ),
      )
      .orderBy(desc(schema.supportChatProposals.revision))
      .limit(1);
    const [request] = episode.requestId
      ? await this.db
          .select({
            id: schema.tenantBillingRequests.id,
            number: schema.tenantBillingRequests.number,
            status: schema.tenantBillingRequests.status,
          })
          .from(schema.tenantBillingRequests)
          .where(
            and(
              eq(schema.tenantBillingRequests.tenantId, episode.tenantId),
              eq(schema.tenantBillingRequests.id, episode.requestId),
            ),
          )
      : [];
    return {
      proposal: proposal
        ? {
            id: proposal.id,
            revision: proposal.revision,
            title: proposal.title,
            summary: proposal.summary,
            noticeVersion: "support-transcript-v1" as const,
            state: proposal.state,
          }
        : null,
      request: request ?? null,
    };
  }

  async sync(episode: EpisodeRow) {
    const [job] =
      episode.transcriptState === "error"
        ? await this.db
            .select({ lastErrorCode: schema.supportChatJobs.lastErrorCode })
            .from(schema.supportChatJobs)
            .where(
              and(
                eq(schema.supportChatJobs.tenantId, episode.tenantId),
                eq(schema.supportChatJobs.episodeId, episode.id),
                eq(schema.supportChatJobs.kind, "import"),
              ),
            )
            .orderBy(desc(schema.supportChatJobs.createdAt), desc(schema.supportChatJobs.id))
            .limit(1)
        : [];
    return {
      state: episode.transcriptState as "pending" | "healthy" | "error",
      lastSyncedAt: episode.lastSyncedAt?.toISOString() ?? null,
      errorCode:
        episode.transcriptState === "error"
          ? job?.lastErrorCode === "consent_notice_unknown"
            ? ("consent_notice_unknown" as const)
            : ("sync_failed" as const)
          : null,
    };
  }

  async owner(scope: SupportOwner): Promise<OwnerRow> {
    await this.db.insert(schema.supportChatOwners).values(scope).onConflictDoNothing();
    const [row] = await this.db
      .select()
      .from(schema.supportChatOwners)
      .where(
        and(
          eq(schema.supportChatOwners.tenantId, scope.tenantId),
          eq(schema.supportChatOwners.userId, scope.userId),
        ),
      );
    if (!row) throw new Error("Support owner unavailable");
    return row;
  }

  async createEpisode(scope: SupportOwner, creationKey: string): Promise<EpisodeRow> {
    const owner = await this.owner(scope);
    return this.db.transaction(async (tx) => {
      await tx
        .insert(schema.supportChatEpisodes)
        .values({ tenantId: scope.tenantId, ownerId: owner.id, creationKey })
        .onConflictDoNothing();
      const [episode] = await tx
        .select()
        .from(schema.supportChatEpisodes)
        .where(
          and(
            eq(schema.supportChatEpisodes.tenantId, scope.tenantId),
            eq(schema.supportChatEpisodes.ownerId, owner.id),
            eq(schema.supportChatEpisodes.creationKey, creationKey),
          ),
        );
      if (!episode) throw new Error("Support episode unavailable");
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${episode.id}))`);
      const [job] = await tx
        .select({ id: schema.supportChatJobs.id })
        .from(schema.supportChatJobs)
        .where(
          and(
            eq(schema.supportChatJobs.episodeId, episode.id),
            eq(schema.supportChatJobs.kind, "reconcile"),
          ),
        );
      if (!job)
        await tx
          .insert(schema.supportChatJobs)
          .values({ tenantId: episode.tenantId, episodeId: episode.id, kind: "reconcile" });
      return episode;
    });
  }

  async findEpisode(scope: SupportOwner, id: string): Promise<EpisodeRow | null> {
    const [episode] = await this.db
      .select({ episode: schema.supportChatEpisodes })
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
          eq(schema.supportChatEpisodes.tenantId, scope.tenantId),
          eq(schema.supportChatEpisodes.id, id),
          eq(schema.supportChatOwners.userId, scope.userId),
        ),
      );
    return episode?.episode ?? null;
  }

  async episodeById(id: string): Promise<{ episode: EpisodeRow; owner: OwnerRow } | null> {
    const [row] = await this.db
      .select({ episode: schema.supportChatEpisodes, owner: schema.supportChatOwners })
      .from(schema.supportChatEpisodes)
      .innerJoin(
        schema.supportChatOwners,
        and(
          eq(schema.supportChatOwners.tenantId, schema.supportChatEpisodes.tenantId),
          eq(schema.supportChatOwners.id, schema.supportChatEpisodes.ownerId),
        ),
      )
      .where(eq(schema.supportChatEpisodes.id, id));
    return row ?? null;
  }

  async listEpisodes(scope: SupportOwner, limit: number, cursor?: string): Promise<EpisodeRow[]> {
    const owner = await this.owner(scope);
    const [after] = cursor
      ? await this.db
          .select()
          .from(schema.supportChatEpisodes)
          .where(
            and(
              eq(schema.supportChatEpisodes.tenantId, scope.tenantId),
              eq(schema.supportChatEpisodes.ownerId, owner.id),
              eq(schema.supportChatEpisodes.id, cursor),
            ),
          )
      : [];
    if (cursor && !after) throw new BadRequestException("Invalid support episode cursor");
    const cursorTime = after
      ? sql<Date>`(select created_at from support_chat_episodes
      where tenant_id = ${scope.tenantId} and owner_id = ${owner.id} and id = ${after.id})`
      : null;
    return this.db
      .select()
      .from(schema.supportChatEpisodes)
      .where(
        and(
          eq(schema.supportChatEpisodes.tenantId, scope.tenantId),
          eq(schema.supportChatEpisodes.ownerId, owner.id),
          cursorTime && after
            ? or(
                gt(schema.supportChatEpisodes.createdAt, cursorTime),
                and(
                  eq(schema.supportChatEpisodes.createdAt, cursorTime),
                  gt(schema.supportChatEpisodes.id, after.id),
                ),
              )
            : undefined,
        ),
      )
      .orderBy(asc(schema.supportChatEpisodes.createdAt), asc(schema.supportChatEpisodes.id))
      .limit(limit);
  }

  async messageIntent(
    episode: EpisodeRow,
    text: string,
    key: string,
  ): Promise<{ row: MessageRow; created: boolean }> {
    return this.db.transaction(async (tx) => {
      const [inserted] = await tx
        .insert(schema.supportChatMessages)
        .values({
          tenantId: episode.tenantId,
          episodeId: episode.id,
          direction: "customer",
          text,
          occurredAt: new Date(),
          delivery: "pending",
          idempotencyKey: key,
        })
        .onConflictDoNothing()
        .returning();
      const [row] = inserted
        ? [inserted]
        : await tx
            .select()
            .from(schema.supportChatMessages)
            .where(
              and(
                eq(schema.supportChatMessages.tenantId, episode.tenantId),
                eq(schema.supportChatMessages.episodeId, episode.id),
                eq(schema.supportChatMessages.idempotencyKey, key),
              ),
            );
      if (!row) throw new Error("Support message intent unavailable");
      if (row.text !== text) throw new ConflictException({ code: "idempotency_key_reused" });
      if (inserted)
        await tx.insert(schema.supportChatJobs).values({
          tenantId: episode.tenantId,
          episodeId: episode.id,
          kind: "send",
          messageId: row.id,
        });
      return { row, created: Boolean(inserted) };
    });
  }

  async claimSend(message: MessageRow, attemptToken: string): Promise<boolean> {
    const claimed = await this.db
      .update(schema.supportChatJobs)
      .set({
        state: "leased",
        attemptToken,
        leaseExpiresAt: new Date(Date.now() + 20_000),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(schema.supportChatJobs.tenantId, message.tenantId),
          eq(schema.supportChatJobs.episodeId, message.episodeId),
          eq(schema.supportChatJobs.messageId, message.id),
          eq(schema.supportChatJobs.state, "pending"),
          isNull(schema.supportChatJobs.attemptToken),
          sql`exists (select 1 from support_chat_episodes e
            join support_chat_owners o on o.id = e.owner_id and o.tenant_id = e.tenant_id
            join member m on m.organization_id = o.tenant_id and m.user_id = o.user_id
            where e.id = ${message.episodeId} and e.tenant_id = ${message.tenantId})`,
        ),
      )
      .returning({ id: schema.supportChatJobs.id });
    return claimed.length === 1;
  }

  private async currentMessage(message: MessageRow): Promise<MessageRow> {
    const [current] = await this.db
      .select()
      .from(schema.supportChatMessages)
      .where(
        and(
          eq(schema.supportChatMessages.tenantId, message.tenantId),
          eq(schema.supportChatMessages.id, message.id),
        ),
      );
    if (!current) throw new Error("Support message unavailable");
    return current;
  }

  async expireStaleSend(message: MessageRow): Promise<MessageRow> {
    await this.db.transaction(async (tx) => {
      const [expired] = await tx
        .update(schema.supportChatJobs)
        .set({
          state: "failed",
          attemptToken: null,
          leaseExpiresAt: null,
          lastErrorCode: "remote_outcome_uncertain",
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(schema.supportChatJobs.tenantId, message.tenantId),
            eq(schema.supportChatJobs.episodeId, message.episodeId),
            eq(schema.supportChatJobs.messageId, message.id),
            eq(schema.supportChatJobs.state, "leased"),
            lte(schema.supportChatJobs.leaseExpiresAt, new Date()),
          ),
        )
        .returning({ id: schema.supportChatJobs.id });
      if (expired)
        await tx
          .update(schema.supportChatMessages)
          .set({ delivery: "uncertain" })
          .where(
            and(
              eq(schema.supportChatMessages.tenantId, message.tenantId),
              eq(schema.supportChatMessages.id, message.id),
              eq(schema.supportChatMessages.delivery, "pending"),
            ),
          );
    });
    return this.currentMessage(message);
  }

  async markSent(
    message: MessageRow,
    mapping: ChatwootMapping,
    remote: PublicChatwootMessage,
    attemptToken: string,
  ): Promise<MessageRow> {
    const updated = await this.db.transaction(async (tx) => {
      const [claimed] = await tx
        .update(schema.supportChatJobs)
        .set({
          state: "completed",
          attemptToken: null,
          leaseExpiresAt: null,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(schema.supportChatJobs.tenantId, message.tenantId),
            eq(schema.supportChatJobs.episodeId, message.episodeId),
            eq(schema.supportChatJobs.messageId, message.id),
            eq(schema.supportChatJobs.state, "leased"),
            eq(schema.supportChatJobs.attemptToken, attemptToken),
            gt(schema.supportChatJobs.leaseExpiresAt, new Date()),
          ),
        )
        .returning({ id: schema.supportChatJobs.id });
      if (!claimed) return null;
      const [updated] = await tx
        .update(schema.supportChatMessages)
        .set({
          delivery: "sent",
          occurredAt: remote.occurredAt,
          remoteAccountId: mapping.accountId,
          remoteInboxId: mapping.inboxId,
          remoteConversationId: mapping.conversationId,
          remoteMessageId: remote.remoteId,
        })
        .where(
          and(
            eq(schema.supportChatMessages.tenantId, message.tenantId),
            eq(schema.supportChatMessages.id, message.id),
            eq(schema.supportChatMessages.delivery, "pending"),
          ),
        )
        .returning();
      if (!updated) throw new Error("Support message unavailable");
      return updated;
    });
    return updated ?? this.expireStaleSend(message);
  }

  async markUncertain(message: MessageRow, attemptToken: string): Promise<MessageRow> {
    const updated = await this.db.transaction(async (tx) => {
      const [claimed] = await tx
        .update(schema.supportChatJobs)
        .set({
          state: "failed",
          attemptToken: null,
          leaseExpiresAt: null,
          lastErrorCode: "remote_outcome_uncertain",
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(schema.supportChatJobs.tenantId, message.tenantId),
            eq(schema.supportChatJobs.episodeId, message.episodeId),
            eq(schema.supportChatJobs.messageId, message.id),
            eq(schema.supportChatJobs.state, "leased"),
            eq(schema.supportChatJobs.attemptToken, attemptToken),
          ),
        )
        .returning({ id: schema.supportChatJobs.id });
      if (!claimed) return null;
      const [updated] = await tx
        .update(schema.supportChatMessages)
        .set({ delivery: "uncertain" })
        .where(
          and(
            eq(schema.supportChatMessages.tenantId, message.tenantId),
            eq(schema.supportChatMessages.id, message.id),
            eq(schema.supportChatMessages.delivery, "pending"),
          ),
        )
        .returning();
      if (!updated) throw new Error("Support message unavailable");
      return updated;
    });
    return updated ?? this.expireStaleSend(message);
  }

  async messages(episode: EpisodeRow, limit: number, cursor?: string): Promise<MessageRow[]> {
    const expired = await this.db
      .select({ messageId: schema.supportChatJobs.messageId })
      .from(schema.supportChatJobs)
      .where(
        and(
          eq(schema.supportChatJobs.tenantId, episode.tenantId),
          eq(schema.supportChatJobs.episodeId, episode.id),
          eq(schema.supportChatJobs.kind, "send"),
          eq(schema.supportChatJobs.state, "leased"),
          lte(schema.supportChatJobs.leaseExpiresAt, new Date()),
        ),
      );
    for (const job of expired) {
      if (!job.messageId) continue;
      const [message] = await this.db
        .select()
        .from(schema.supportChatMessages)
        .where(
          and(
            eq(schema.supportChatMessages.tenantId, episode.tenantId),
            eq(schema.supportChatMessages.id, job.messageId),
          ),
        );
      if (message) await this.expireStaleSend(message);
    }
    const [after] = cursor
      ? await this.db
          .select()
          .from(schema.supportChatMessages)
          .where(
            and(
              eq(schema.supportChatMessages.tenantId, episode.tenantId),
              eq(schema.supportChatMessages.episodeId, episode.id),
              eq(schema.supportChatMessages.id, cursor),
            ),
          )
      : [];
    if (cursor && !after) throw new BadRequestException("Invalid support message cursor");
    const cursorTime = after
      ? sql<Date>`(select occurred_at from support_chat_messages
      where tenant_id = ${episode.tenantId} and episode_id = ${episode.id} and id = ${after.id})`
      : null;
    return this.db
      .select()
      .from(schema.supportChatMessages)
      .where(
        and(
          eq(schema.supportChatMessages.tenantId, episode.tenantId),
          eq(schema.supportChatMessages.episodeId, episode.id),
          cursorTime && after
            ? or(
                lt(schema.supportChatMessages.occurredAt, cursorTime),
                and(
                  eq(schema.supportChatMessages.occurredAt, cursorTime),
                  lt(schema.supportChatMessages.id, after.id),
                ),
              )
            : undefined,
        ),
      )
      .orderBy(desc(schema.supportChatMessages.occurredAt), desc(schema.supportChatMessages.id))
      .limit(limit);
  }

  async importRemote(
    episode: EpisodeRow,
    mapping: ChatwootMapping,
    remote: PublicChatwootMessage,
  ): Promise<void> {
    await this.db.transaction(async (tx) => this.writeRemote(tx, episode, mapping, remote));
  }

  private async writeRemote(
    tx: Pick<Db, "select" | "insert" | "update">,
    episode: EpisodeRow,
    mapping: ChatwootMapping,
    remote: PublicChatwootMessage,
  ): Promise<void> {
    const candidateId = remote.sourceId;
    if (
      candidateId &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(candidateId)
    ) {
      const [intent] = await tx
        .select()
        .from(schema.supportChatMessages)
        .where(
          and(
            eq(schema.supportChatMessages.tenantId, episode.tenantId),
            eq(schema.supportChatMessages.episodeId, episode.id),
            eq(schema.supportChatMessages.id, candidateId),
          ),
        );
      if (intent) {
        if (
          intent.direction !== "customer" ||
          remote.direction !== "customer" ||
          intent.text !== remote.text ||
          (intent.remoteMessageId !== null && intent.remoteMessageId !== remote.remoteId)
        ) {
          throw new Error("Chatwoot message correlation mismatch");
        }
        await tx
          .update(schema.supportChatMessages)
          .set({
            delivery: "sent",
            occurredAt: remote.occurredAt,
            remoteAccountId: mapping.accountId,
            remoteInboxId: mapping.inboxId,
            remoteConversationId: mapping.conversationId,
            remoteMessageId: remote.remoteId,
            importedAt: new Date(),
          })
          .where(
            and(
              eq(schema.supportChatMessages.tenantId, episode.tenantId),
              eq(schema.supportChatMessages.id, intent.id),
            ),
          );
        await tx
          .update(schema.supportChatJobs)
          .set({
            state: "completed",
            attemptToken: null,
            leaseExpiresAt: null,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(schema.supportChatJobs.tenantId, episode.tenantId),
              eq(schema.supportChatJobs.messageId, intent.id),
            ),
          );
        return;
      }
    }
    await tx
      .insert(schema.supportChatMessages)
      .values({
        tenantId: episode.tenantId,
        episodeId: episode.id,
        direction: remote.direction,
        text: remote.text,
        occurredAt: remote.occurredAt,
        delivery: "sent",
        remoteAccountId: mapping.accountId,
        remoteInboxId: mapping.inboxId,
        remoteConversationId: mapping.conversationId,
        remoteMessageId: remote.remoteId,
        importedAt: new Date(),
      })
      .onConflictDoNothing();
  }

  async setSync(episode: EpisodeRow, state: "healthy" | "error"): Promise<void> {
    await this.db
      .update(schema.supportChatEpisodes)
      .set({
        transcriptState: state,
        ...(state === "healthy" ? { lastSyncedAt: new Date() } : {}),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(schema.supportChatEpisodes.tenantId, episode.tenantId),
          eq(schema.supportChatEpisodes.id, episode.id),
          isNull(schema.supportChatEpisodes.requestId),
        ),
      );
  }

  async setContact(owner: OwnerRow, contactId: number, sourceId: string): Promise<void> {
    await this.db
      .update(schema.supportChatOwners)
      .set({ remoteContactId: String(contactId), remoteContactSourceId: sourceId })
      .where(
        and(
          eq(schema.supportChatOwners.tenantId, owner.tenantId),
          eq(schema.supportChatOwners.id, owner.id),
          sql`${schema.supportChatOwners.remoteContactId} is null`,
        ),
      );
  }

  async setConversation(episode: EpisodeRow, mapping: ChatwootMapping): Promise<void> {
    await this.db
      .update(schema.supportChatEpisodes)
      .set({
        remoteAccountId: mapping.accountId,
        remoteInboxId: mapping.inboxId,
        remoteConversationId: mapping.conversationId,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(schema.supportChatEpisodes.tenantId, episode.tenantId),
          eq(schema.supportChatEpisodes.id, episode.id),
          sql`${schema.supportChatEpisodes.remoteConversationId} is null`,
        ),
      );
  }

  async provisioningCheckpoint(episode: EpisodeRow): Promise<string | null> {
    const [job] = await this.db
      .select()
      .from(schema.supportChatJobs)
      .where(
        and(
          eq(schema.supportChatJobs.tenantId, episode.tenantId),
          eq(schema.supportChatJobs.episodeId, episode.id),
          eq(schema.supportChatJobs.kind, "reconcile"),
        ),
      )
      .orderBy(asc(schema.supportChatJobs.createdAt))
      .limit(1);
    const checkpoint = job?.checkpoint;
    return typeof checkpoint === "string"
      ? checkpoint
      : checkpoint &&
          typeof checkpoint === "object" &&
          "stage" in checkpoint &&
          checkpoint.stage === "ready"
        ? "ready"
        : null;
  }

  async ensureProvisioningJob(episode: EpisodeRow): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${episode.id}))`);
      const [existing] = await tx
        .select({ id: schema.supportChatJobs.id })
        .from(schema.supportChatJobs)
        .where(
          and(
            eq(schema.supportChatJobs.episodeId, episode.id),
            eq(schema.supportChatJobs.kind, "reconcile"),
          ),
        );
      if (!existing)
        await tx
          .insert(schema.supportChatJobs)
          .values({ tenantId: episode.tenantId, episodeId: episode.id, kind: "reconcile" });
    });
  }

  async privateHistoryCheckpoint(episode: EpisodeRow): Promise<PrivateHistoryCheckpoint> {
    const [job] = await this.db
      .select()
      .from(schema.supportChatJobs)
      .where(
        and(
          eq(schema.supportChatJobs.episodeId, episode.id),
          eq(schema.supportChatJobs.kind, "reconcile"),
        ),
      );
    const state = job?.checkpoint;
    return state && typeof state === "object" && "stage" in state && state.stage === "ready"
      ? (state as PrivateHistoryCheckpoint)
      : { stage: "ready" };
  }

  async commitPrivatePage(
    episode: EpisodeRow,
    mapping: ChatwootMapping,
    messages: PublicChatwootMessage[],
    expected: PrivateHistoryCheckpoint,
    next: PrivateHistoryCheckpoint,
    complete: boolean,
  ): Promise<boolean> {
    return this.db.transaction(async (tx) => {
      const [current] = await tx
        .select()
        .from(schema.supportChatEpisodes)
        .where(
          and(
            eq(schema.supportChatEpisodes.id, episode.id),
            eq(schema.supportChatEpisodes.tenantId, episode.tenantId),
          ),
        )
        .for("update");
      if (!current || current.requestId) return false;
      const [job] = await tx
        .select()
        .from(schema.supportChatJobs)
        .where(
          and(
            eq(schema.supportChatJobs.episodeId, episode.id),
            eq(schema.supportChatJobs.kind, "reconcile"),
          ),
        )
        .for("update");
      if (!job) return false;
      const checkpoint =
        job.checkpoint && typeof job.checkpoint === "object" ? job.checkpoint : { stage: "ready" };
      if (JSON.stringify(checkpoint) !== JSON.stringify(expected)) return false;
      for (const message of messages) await this.writeRemote(tx, current, mapping, message);
      await tx
        .update(schema.supportChatJobs)
        .set({ checkpoint: next, updatedAt: new Date() })
        .where(eq(schema.supportChatJobs.id, job.id));
      await tx
        .update(schema.supportChatEpisodes)
        .set({
          transcriptState: complete ? "healthy" : "pending",
          ...(complete ? { lastSyncedAt: new Date() } : {}),
          updatedAt: new Date(),
        })
        .where(eq(schema.supportChatEpisodes.id, episode.id));
      return true;
    });
  }

  async setProvisioningCheckpoint(episode: EpisodeRow, checkpoint: string): Promise<void> {
    const [job] = await this.db
      .select()
      .from(schema.supportChatJobs)
      .where(
        and(
          eq(schema.supportChatJobs.tenantId, episode.tenantId),
          eq(schema.supportChatJobs.episodeId, episode.id),
          eq(schema.supportChatJobs.kind, "reconcile"),
        ),
      )
      .limit(1);
    if (job)
      await this.db
        .update(schema.supportChatJobs)
        .set({
          checkpoint:
            checkpoint === "ready"
              ? sql`case when jsonb_typeof(${schema.supportChatJobs.checkpoint}) = 'object'
                  then ${schema.supportChatJobs.checkpoint} else '"ready"'::jsonb end`
              : checkpoint,
          updatedAt: new Date(),
          ...(checkpoint === "ready"
            ? { state: "completed", attemptToken: null, leaseExpiresAt: null, lastErrorCode: null }
            : {}),
        })
        .where(eq(schema.supportChatJobs.id, job.id));
    else
      await this.db.insert(schema.supportChatJobs).values({
        tenantId: episode.tenantId,
        episodeId: episode.id,
        kind: "reconcile",
        checkpoint,
        ...(checkpoint === "ready" ? { state: "completed" as const } : {}),
      });
  }

  async beginProvisioningStage(
    episode: EpisodeRow,
    expected: string | null,
    stage: string,
  ): Promise<boolean> {
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${episode.id}))`);
      const [job] = await tx
        .select()
        .from(schema.supportChatJobs)
        .where(
          and(
            eq(schema.supportChatJobs.tenantId, episode.tenantId),
            eq(schema.supportChatJobs.episodeId, episode.id),
            eq(schema.supportChatJobs.kind, "reconcile"),
          ),
        )
        .limit(1);
      const current = typeof job?.checkpoint === "string" ? job.checkpoint : null;
      if (current !== expected) return false;
      if (job)
        await tx
          .update(schema.supportChatJobs)
          .set({ checkpoint: stage, updatedAt: new Date() })
          .where(eq(schema.supportChatJobs.id, job.id));
      else
        await tx.insert(schema.supportChatJobs).values({
          tenantId: episode.tenantId,
          episodeId: episode.id,
          kind: "reconcile",
          checkpoint: stage,
        });
      return true;
    });
  }
}
