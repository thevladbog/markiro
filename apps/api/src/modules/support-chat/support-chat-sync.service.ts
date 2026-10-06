import { randomUUID } from "node:crypto";
import { Inject, Injectable } from "@nestjs/common";
import { and, eq, gt, inArray, lte, or } from "drizzle-orm";
import { schema, type Db } from "@markiro/db";
import { DB } from "../../auth/auth.module";
import { ChatwootClient } from "./chatwoot.client";
import type { ChatwootMapping, PublicChatwootMessage } from "./chatwoot-message.schema";

type ImportJob = typeof schema.supportChatJobs.$inferSelect;
// Historical consent is a stored snapshot, not a comparison with today's notice selector.
// Migration 0178 guards canonical inserts; newly supported versions must be added explicitly.
const supportedHistoricalNoticeVersions = new Set(["support-transcript-v1"]);
type ImportCheckpoint = {
  consentId: string;
  before?: number;
  initialComplete?: boolean;
  lastFullAt?: string;
  pagesDone?: number;
  full?: boolean;
  highWater?: number;
  cycleHighWater?: number;
  cycleStartedAt?: string;
};

function checkpoint(value: unknown): ImportCheckpoint | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const item = value as Record<string, unknown>;
  if (typeof item.consentId !== "string") return null;
  const validBoundary = (value: unknown): value is number =>
    typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
  return {
    consentId: item.consentId,
    ...(typeof item.before === "number" ? { before: item.before } : {}),
    ...(item.initialComplete === true ? { initialComplete: true } : {}),
    ...(typeof item.lastFullAt === "string" ? { lastFullAt: item.lastFullAt } : {}),
    ...(typeof item.pagesDone === "number" ? { pagesDone: item.pagesDone } : {}),
    ...(typeof item.full === "boolean" ? { full: item.full } : {}),
    ...(validBoundary(item.highWater) ? { highWater: item.highWater } : {}),
    ...(validBoundary(item.cycleHighWater) ? { cycleHighWater: item.cycleHighWater } : {}),
    ...(typeof item.cycleStartedAt === "string" && Number.isFinite(Date.parse(item.cycleStartedAt))
      ? { cycleStartedAt: item.cycleStartedAt }
      : {}),
  };
}

function retryDelay(count: number): number {
  return count >= 12 ? 15 * 60_000 : Math.min(5_000 * 2 ** Math.max(0, count - 1), 5 * 60_000);
}

/** PostgreSQL owns every import attempt; pg-boss only wakes due rows. */
@Injectable()
export class SupportChatSyncService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly chatwoot: ChatwootClient,
  ) {}

  async run(jobId: string, attemptToken = randomUUID()): Promise<boolean> {
    const now = new Date();
    const [job] = await this.db
      .update(schema.supportChatJobs)
      .set({
        state: "leased",
        attemptToken,
        leaseExpiresAt: new Date(now.getTime() + 60_000),
        updatedAt: now,
      })
      .where(
        and(
          eq(schema.supportChatJobs.id, jobId),
          eq(schema.supportChatJobs.kind, "import"),
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
      .returning();
    if (!job) return false;

    let lost = false;
    let heartbeating = false;
    const heartbeat = async () => {
      if (heartbeating || lost) return;
      heartbeating = true;
      try {
        const renewed = await this.db
          .update(schema.supportChatJobs)
          .set({
            leaseExpiresAt: new Date(Date.now() + 60_000),
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(schema.supportChatJobs.id, job.id),
              eq(schema.supportChatJobs.state, "leased"),
              eq(schema.supportChatJobs.attemptToken, attemptToken),
              gt(schema.supportChatJobs.leaseExpiresAt, new Date()),
            ),
          )
          .returning({ id: schema.supportChatJobs.id });
        if (!renewed.length) lost = true;
      } catch {
        lost = true;
      } finally {
        heartbeating = false;
      }
    };
    const timer = setInterval(() => {
      void heartbeat();
    }, 20_000);
    timer.unref();
    try {
      await this.import(job, attemptToken, () => lost);
      return true;
    } catch (error) {
      if (!lost)
        await this.fail(
          job,
          attemptToken,
          error instanceof Error && error.message === "consent_notice_unknown"
            ? "consent_notice_unknown"
            : "sync_failed",
        );
      return false;
    } finally {
      clearInterval(timer);
    }
  }

  private async import(job: ImportJob, attemptToken: string, lost: () => boolean): Promise<void> {
    const [linked] = await this.db
      .select({
        episode: schema.supportChatEpisodes,
        owner: schema.supportChatOwners,
      })
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
          eq(schema.supportChatEpisodes.tenantId, job.tenantId),
          eq(schema.supportChatEpisodes.id, job.episodeId),
        ),
      );
    if (
      !linked?.episode.requestId ||
      !linked.episode.remoteAccountId ||
      !linked.episode.remoteInboxId ||
      !linked.episode.remoteConversationId ||
      !linked.owner.remoteContactId
    )
      throw new Error("source_scope_unavailable");
    const state = checkpoint(job.checkpoint);
    if (!state) throw new Error("consent_notice_unknown");
    const [consent] = await this.db
      .select()
      .from(schema.supportChatConsents)
      .where(
        and(
          eq(schema.supportChatConsents.id, state.consentId),
          eq(schema.supportChatConsents.tenantId, job.tenantId),
          eq(schema.supportChatConsents.episodeId, job.episodeId),
          eq(schema.supportChatConsents.decision, "accept"),
        ),
      );
    if (
      !consent ||
      !consent.noticeLocale ||
      !consent.noticeText ||
      !consent.noticeText.trim() ||
      !["ru", "en"].includes(consent.noticeLocale) ||
      !supportedHistoricalNoticeVersions.has(consent.noticeVersion)
    ) {
      throw new Error("consent_notice_unknown");
    }
    const mapping: ChatwootMapping = {
      accountId: linked.episode.remoteAccountId,
      inboxId: linked.episode.remoteInboxId,
      conversationId: linked.episode.remoteConversationId,
      contactId: Number(linked.owner.remoteContactId),
    };
    if (!Number.isSafeInteger(mapping.contactId) || mapping.contactId <= 0)
      throw new Error("source_scope_unavailable");
    // Old checkpoints claimed completion without a raw high-water boundary.
    // Reconcile from the head rather than trusting their completion/cursor.
    const resume =
      state.highWater !== undefined &&
      state.cycleHighWater !== undefined &&
      state.cycleHighWater >= state.highWater &&
      state.cycleStartedAt !== undefined &&
      state.before !== undefined &&
      Number.isSafeInteger(state.before) &&
      state.before > 0 &&
      state.before <= state.cycleHighWater &&
      state.full !== undefined;
    let cursor = resume ? state.before : undefined;
    let pagesDone = resume ? (state.pagesDone ?? 0) : 0;
    const full = resume
      ? state.full!
      : state.highWater === undefined ||
        !state.initialComplete ||
        !state.lastFullAt ||
        !Number.isFinite(Date.parse(state.lastFullAt)) ||
        Date.now() - Date.parse(state.lastFullAt) >= 15 * 60_000;
    const highWater = state.highWater ?? 0;
    let cycleHighWater = resume ? state.cycleHighWater : undefined;
    const cycleStartedAt = resume ? state.cycleStartedAt! : new Date().toISOString();
    // Two verified raw pages bound each invocation; durable continuation owns the rest.
    for (let pagesThisRun = 1; pagesThisRun <= 2; pagesThisRun++) {
      if (lost()) throw new Error("lease_lost");
      const page = await this.chatwoot.verifiedMessagePage(mapping, cursor);
      if (lost()) throw new Error("lease_lost");
      if (
        page.rawCount > 0 &&
        (page.oldestRawId === null || (cursor !== undefined && page.oldestRawId >= cursor))
      ) {
        throw new Error("nonprogressing_remote_page");
      }
      pagesDone++;
      cycleHighWater ??= Math.max(highWater, page.newestRawId ?? 0);
      const complete =
        page.rawCount < 20 || (!full && page.oldestRawId !== null && page.oldestRawId <= highWater);
      const yieldRun = complete || pagesThisRun === 2;
      const next: ImportCheckpoint = {
        consentId: state.consentId,
        highWater: complete ? cycleHighWater : highWater,
        ...(complete ? {} : { before: page.oldestRawId!, cycleHighWater, cycleStartedAt }),
        initialComplete: complete || state.initialComplete === true,
        ...(complete && full
          ? { lastFullAt: cycleStartedAt }
          : state.lastFullAt
            ? { lastFullAt: state.lastFullAt }
            : {}),
        pagesDone: complete ? 0 : pagesDone,
        ...(complete ? {} : { full }),
      };
      await this.commitPage(
        job,
        attemptToken,
        mapping,
        page.publicMessages,
        next,
        complete,
        yieldRun,
        cycleStartedAt,
      );
      if (yieldRun) return;
      cursor = page.oldestRawId!;
    }
  }

  private async commitPage(
    job: ImportJob,
    attemptToken: string,
    mapping: ChatwootMapping,
    messages: PublicChatwootMessage[],
    next: ImportCheckpoint,
    complete: boolean,
    yieldRun: boolean,
    cycleStartedAt: string,
  ): Promise<void> {
    await this.db.transaction(async (tx) => {
      const [fenced] = await tx
        .update(schema.supportChatJobs)
        .set({
          checkpoint: next,
          updatedAt: new Date(),
          ...(yieldRun
            ? {
                state: "pending" as const,
                attemptToken: null,
                leaseExpiresAt: null,
                retryCount: 0,
                nextAttemptAt: new Date(Date.now() + (complete ? 30_000 : 1_000)),
                lastErrorCode: null,
              }
            : {}),
        })
        .where(
          and(
            eq(schema.supportChatJobs.id, job.id),
            eq(schema.supportChatJobs.state, "leased"),
            eq(schema.supportChatJobs.attemptToken, attemptToken),
            gt(schema.supportChatJobs.leaseExpiresAt, new Date()),
          ),
        )
        .returning({ id: schema.supportChatJobs.id });
      if (!fenced) throw new Error("lease_lost");
      for (const remote of [...messages].sort(
        (a, b) => a.occurredAt.getTime() - b.occurredAt.getTime() || a.remoteId - b.remoteId,
      )) {
        if (
          remote.sourceId &&
          /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
            remote.sourceId,
          )
        ) {
          const [intent] = await tx
            .select()
            .from(schema.supportChatMessages)
            .where(
              and(
                eq(schema.supportChatMessages.tenantId, job.tenantId),
                eq(schema.supportChatMessages.episodeId, job.episodeId),
                eq(schema.supportChatMessages.id, remote.sourceId),
              ),
            );
          if (intent) {
            if (
              intent.direction === remote.direction &&
              intent.text === remote.text &&
              (intent.remoteMessageId === null || intent.remoteMessageId === remote.remoteId)
            ) {
              if (intent.remoteMessageId === null)
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
                  .where(eq(schema.supportChatMessages.id, intent.id));
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
                    eq(schema.supportChatJobs.messageId, intent.id),
                    eq(schema.supportChatJobs.kind, "send"),
                  ),
                );
              continue;
            }
            // source_id is not unique in Chatwoot. Keep the conflicting remote
            // message as its own immutable fact; never rebind the local intent.
          }
        }
        await tx
          .insert(schema.supportChatMessages)
          .values({
            tenantId: job.tenantId,
            episodeId: job.episodeId,
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
      await tx
        .update(schema.supportChatEpisodes)
        .set({
          transcriptState: complete ? "healthy" : "pending",
          ...(complete ? { lastSyncedAt: new Date(cycleStartedAt) } : {}),
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(schema.supportChatEpisodes.tenantId, job.tenantId),
            eq(schema.supportChatEpisodes.id, job.episodeId),
          ),
        );
    });
  }

  private async fail(job: ImportJob, attemptToken: string, code: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      const count = job.retryCount + 1;
      const [fenced] = await tx
        .update(schema.supportChatJobs)
        .set({
          state: count >= 12 ? "failed" : "pending",
          attemptToken: null,
          leaseExpiresAt: null,
          retryCount: count,
          nextAttemptAt: new Date(Date.now() + retryDelay(count)),
          lastErrorCode: code,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(schema.supportChatJobs.id, job.id),
            eq(schema.supportChatJobs.state, "leased"),
            eq(schema.supportChatJobs.attemptToken, attemptToken),
            gt(schema.supportChatJobs.leaseExpiresAt, new Date()),
          ),
        )
        .returning({ id: schema.supportChatJobs.id });
      if (fenced)
        await tx
          .update(schema.supportChatEpisodes)
          .set({
            transcriptState: "error",
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(schema.supportChatEpisodes.tenantId, job.tenantId),
              eq(schema.supportChatEpisodes.id, job.episodeId),
            ),
          );
    });
  }
}
