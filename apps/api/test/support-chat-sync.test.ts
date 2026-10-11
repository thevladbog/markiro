import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { schema } from "@markiro/db";
import * as platformContracts from "@markiro/platform-contracts";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { SupportChatSyncService } from "../src/modules/support-chat/support-chat-sync.service";
import { ChatwootClient } from "../src/modules/support-chat/chatwoot.client";
import { SupportChatRepository } from "../src/modules/support-chat/support-chat.repository";
import { createSupportChatFixture, type SupportChatFixture } from "./support/support-chat-fixture";

const ready =
  process.env.SUPPORT_CHAT_ISOLATED_DB === "1" &&
  Boolean(process.env.SUPPORT_CHAT_TEST_MAINTENANCE_URL);

describe.skipIf(!ready)("durable support transcript import", () => {
  let fixture: SupportChatFixture;
  let operatorId: string;
  beforeAll(async () => {
    fixture = await createSupportChatFixture();
    const [operator] = await fixture.db.select().from(schema.platformUsers).limit(1);
    if (!operator) throw new Error("Expected operator");
    operatorId = operator.id;
    await fixture.db
      .update(schema.platformUsers)
      .set({ role: "platform_admin", status: "active", twoFactorEnabled: true })
      .where(eq(schema.platformUsers.id, operatorId));
    await fixture.db.insert(schema.platformTwoFactors).values({
      id: randomUUID(),
      userId: operatorId,
      secret: "test-only-totp",
      backupCodes: "[]",
      verified: true,
    });
  }, 120_000);
  afterAll(async () => {
    await fixture?.cleanup();
  });

  async function acceptedEpisode() {
    const id = (
      await fixture.customerB
        .post("/support-chat/episodes")
        .send({ idempotencyKey: randomUUID() })
        .expect(201)
    ).body.id as string;
    const proposal = (
      await fixture.platform
        .post(`/platform/support-chat/episodes/${id}/proposals`)
        .set("Cookie", fixture.platformCookie)
        .send({ title: "Line stopped", summary: "Need help", idempotencyKey: randomUUID() })
        .expect(201)
    ).body as { id: string; revision: number; noticeVersion: string };
    const decision = await fixture.customerB
      .post(`/support-chat/episodes/${id}/proposals/${proposal.id}/decision`)
      .send({
        decision: "accept",
        revision: proposal.revision,
        noticeVersion: proposal.noticeVersion,
        noticeLocale: "en",
        idempotencyKey: randomUUID(),
      })
      .expect(201);
    const [episode] = await fixture.db
      .select()
      .from(schema.supportChatEpisodes)
      .where(eq(schema.supportChatEpisodes.id, id));
    const [job] = await fixture.db
      .select()
      .from(schema.supportChatJobs)
      .where(
        and(eq(schema.supportChatJobs.episodeId, id), eq(schema.supportChatJobs.kind, "import")),
      );
    if (!episode?.remoteConversationId || !job || !decision.body.request?.id)
      throw new Error("Expected accepted mapped episode");
    return {
      id,
      requestId: decision.body.request.id as string,
      conversationId: episode.remoteConversationId,
      jobId: job.id,
    };
  }

  it("continues a mixed incremental burst across bounded runs and a restart", async () => {
    const linked = await acceptedEpisode();
    const add = (id: number, kind: "public" | "private" | "activity" = "public") =>
      fixture.upstream.addMessage({
        id,
        conversation_id: linked.conversationId,
        inbox_id: 17,
        content: `incremental-${id}`,
        content_type: "text",
        message_type: kind === "activity" ? 2 : 1,
        private: kind === "private",
        created_at: 1_700_000_000 + id,
        source_id: null,
      });
    const run = async () => {
      await fixture.db
        .update(schema.supportChatJobs)
        .set({ nextAttemptAt: new Date(0) })
        .where(eq(schema.supportChatJobs.id, linked.jobId));
      return new SupportChatSyncService(fixture.db, fixture.app.get(ChatwootClient)).run(
        linked.jobId,
        randomUUID(),
      );
    };
    const read = async () =>
      (
        await fixture.db
          .select()
          .from(schema.supportChatEpisodes)
          .where(eq(schema.supportChatEpisodes.id, linked.id))
      )[0]!;
    add(2000);
    expect(await run()).toBe(true);
    const initial = await read();
    expect(initial.transcriptState).toBe("healthy");
    for (let id = 2001; id <= 2085; id++)
      add(id, id >= 2046 ? (id % 2 ? "private" : "activity") : "public");
    expect(await run()).toBe(true);
    const partial = await read();
    expect(partial.transcriptState).toBe("pending");
    expect(partial.lastSyncedAt).toEqual(initial.lastSyncedAt);
    const [job] = await fixture.db
      .select()
      .from(schema.supportChatJobs)
      .where(eq(schema.supportChatJobs.id, linked.jobId));
    expect(job?.state).toBe("pending");
    expect(job?.checkpoint).toMatchObject({ before: 2046 });
    add(2086);
    expect(await run()).toBe(true);
    expect((await read()).transcriptState).toBe("pending");
    expect(await run()).toBe(true);
    expect((await read()).transcriptState).toBe("healthy");
    // The arrival above the captured boundary is found in the next cycle.
    expect(await run()).toBe(true);
    const rows = await fixture.db
      .select()
      .from(schema.supportChatMessages)
      .where(eq(schema.supportChatMessages.episodeId, linked.id));
    expect(rows.map((row) => row.remoteMessageId).sort((a, b) => (a ?? 0) - (b ?? 0))).toEqual([
      ...Array.from({ length: 46 }, (_, i) => 2000 + i),
      2086,
    ]);
    expect(new Set(rows.map((row) => row.remoteMessageId)).size).toBe(47);
  });

  it("backfills long public text across private-only pages and survives a repeat", async () => {
    const linked = await acceptedEpisode();
    const longText = "A".repeat(4_500);
    for (let id = 101; id <= 145; id++)
      fixture.upstream.addMessage({
        id,
        conversation_id: linked.conversationId,
        inbox_id: 17,
        content: id === 101 ? longText : `public-${id}`,
        content_type: "text",
        message_type: id % 2 === 0 ? 2 : 1,
        private: id > 101 && id < 143,
        created_at: 1_700_000_000 + id,
        source_id: null,
      });
    const sync = fixture.app.get(SupportChatSyncService);
    await fixture.db
      .update(schema.supportChatJobs)
      .set({ nextAttemptAt: new Date(0) })
      .where(eq(schema.supportChatJobs.id, linked.jobId));
    expect(await sync.run(linked.jobId, randomUUID())).toBe(true);
    await fixture.db
      .update(schema.supportChatJobs)
      .set({ nextAttemptAt: new Date(0) })
      .where(eq(schema.supportChatJobs.id, linked.jobId));
    await sync.run(linked.jobId, randomUUID());
    const rows = await fixture.db
      .select()
      .from(schema.supportChatMessages)
      .where(eq(schema.supportChatMessages.episodeId, linked.id));
    expect(rows.map((row) => row.text).sort()).toEqual(
      [longText, "public-143", "public-145"].sort(),
    );
    const [episode] = await fixture.db
      .select()
      .from(schema.supportChatEpisodes)
      .where(eq(schema.supportChatEpisodes.id, linked.id));
    expect(episode?.transcriptState).toBe("healthy");
    expect(episode?.lastSyncedAt).not.toBeNull();
  });

  it("reconciles a legacy completed checkpoint instead of inventing its high-water", async () => {
    const linked = await acceptedEpisode();
    const [job] = await fixture.db
      .select()
      .from(schema.supportChatJobs)
      .where(eq(schema.supportChatJobs.id, linked.jobId));
    const previous = job!.checkpoint as { consentId: string };
    await fixture.db
      .update(schema.supportChatJobs)
      .set({
        nextAttemptAt: new Date(0),
        checkpoint: {
          consentId: previous.consentId,
          initialComplete: true,
          lastFullAt: new Date().toISOString(),
          before: 3005,
          full: false,
          pagesDone: 1,
        },
      })
      .where(eq(schema.supportChatJobs.id, linked.jobId));
    for (let id = 3001; id <= 3045; id++)
      fixture.upstream.addMessage({
        id,
        conversation_id: linked.conversationId,
        inbox_id: 17,
        content: `legacy-${id}`,
        content_type: "text",
        message_type: 1,
        private: false,
        created_at: 1_700_000_000 + id,
        source_id: null,
      });
    const sync = fixture.app.get(SupportChatSyncService);
    expect(await sync.run(linked.jobId, randomUUID())).toBe(true);
    const [partial] = await fixture.db
      .select()
      .from(schema.supportChatEpisodes)
      .where(eq(schema.supportChatEpisodes.id, linked.id));
    expect(partial).toMatchObject({ transcriptState: "pending", lastSyncedAt: null });
    await fixture.db
      .update(schema.supportChatJobs)
      .set({ nextAttemptAt: new Date(0) })
      .where(eq(schema.supportChatJobs.id, linked.jobId));
    expect(await sync.run(linked.jobId, randomUUID())).toBe(true);
    const rows = await fixture.db
      .select()
      .from(schema.supportChatMessages)
      .where(eq(schema.supportChatMessages.episodeId, linked.id));
    expect(rows.map((row) => row.remoteMessageId).sort((a, b) => (a ?? 0) - (b ?? 0))).toEqual(
      Array.from({ length: 45 }, (_, i) => 3001 + i),
    );
  });

  it("discovers a new arrival after a proven empty import", async () => {
    const linked = await acceptedEpisode();
    const run = async () => {
      await fixture.db
        .update(schema.supportChatJobs)
        .set({ nextAttemptAt: new Date(0) })
        .where(eq(schema.supportChatJobs.id, linked.jobId));
      expect(await fixture.app.get(SupportChatSyncService).run(linked.jobId, randomUUID())).toBe(
        true,
      );
    };
    await run();
    const [empty] = await fixture.db
      .select()
      .from(schema.supportChatJobs)
      .where(eq(schema.supportChatJobs.id, linked.jobId));
    expect(empty?.checkpoint).toMatchObject({ highWater: 0, initialComplete: true });
    fixture.upstream.addMessage({
      id: 4001,
      conversation_id: linked.conversationId,
      inbox_id: 17,
      content: "first after empty",
      content_type: "text",
      message_type: 1,
      private: false,
      created_at: 1_700_004_001,
      source_id: null,
    });
    await run();
    const rows = await fixture.db
      .select()
      .from(schema.supportChatMessages)
      .where(eq(schema.supportChatMessages.episodeId, linked.id));
    expect(rows.map((row) => row.text)).toEqual(["first after empty"]);
  });

  it("keeps an accepted transcript pending until the full snapshot finishes", async () => {
    const linked = await acceptedEpisode();
    for (let id = 301; id <= 325; id++)
      fixture.upstream.addMessage({
        id,
        conversation_id: linked.conversationId,
        inbox_id: 17,
        content: `message-${id}`,
        content_type: "text",
        message_type: 1,
        private: false,
        created_at: 1_700_000_000 + id,
        source_id: null,
      });
    const detail = await fixture.customerB.get(`/support-chat/episodes/${linked.id}`).expect(200);
    expect(detail.body.sync).toEqual({ state: "pending", lastSyncedAt: null, errorCode: null });
    const [episode] = await fixture.db
      .select()
      .from(schema.supportChatEpisodes)
      .where(eq(schema.supportChatEpisodes.id, linked.id));
    expect(episode?.lastSyncedAt).toBeNull();
  });

  it("resumes a committed raw-page cursor after a worker failure", async () => {
    const linked = await acceptedEpisode();
    for (let id = 501; id <= 545; id++)
      fixture.upstream.addMessage({
        id,
        conversation_id: linked.conversationId,
        inbox_id: 17,
        content: `backfill-${id}`,
        content_type: "text",
        message_type: 1,
        private: id % 3 !== 0,
        created_at: 1_700_000_000 + id,
        source_id: null,
      });
    fixture.upstream.failMessageListAfter(1);
    await fixture.db
      .update(schema.supportChatJobs)
      .set({ nextAttemptAt: new Date(0) })
      .where(eq(schema.supportChatJobs.id, linked.jobId));
    const firstWorker = fixture.app.get(SupportChatSyncService);
    const firstResult = await firstWorker.run(linked.jobId, randomUUID());
    expect(firstResult).toBe(false);
    const [partial] = await fixture.db
      .select()
      .from(schema.supportChatJobs)
      .where(eq(schema.supportChatJobs.id, linked.jobId));
    expect(partial?.checkpoint).toMatchObject({ before: 526, pagesDone: 1 });
    expect(partial?.lastErrorCode).toBe("sync_failed");
    const [pending] = await fixture.db
      .select()
      .from(schema.supportChatEpisodes)
      .where(eq(schema.supportChatEpisodes.id, linked.id));
    expect(pending?.lastSyncedAt).toBeNull();
    await fixture.db
      .update(schema.supportChatJobs)
      .set({ nextAttemptAt: new Date(0) })
      .where(eq(schema.supportChatJobs.id, linked.jobId));
    const restartedWorker = new SupportChatSyncService(fixture.db, fixture.app.get(ChatwootClient));
    expect(await restartedWorker.run(linked.jobId, randomUUID())).toBe(true);
    const rows = await fixture.db
      .select()
      .from(schema.supportChatMessages)
      .where(eq(schema.supportChatMessages.episodeId, linked.id));
    expect(rows.map((row) => row.remoteMessageId).sort((a, b) => (a ?? 0) - (b ?? 0))).toEqual([
      501, 504, 507, 510, 513, 516, 519, 522, 525, 528, 531, 534, 537, 540, 543,
    ]);
  });

  it("fences an expired worker after HTTP so only its successor commits", async () => {
    const linked = await acceptedEpisode();
    fixture.upstream.addMessage({
      id: 701,
      conversation_id: linked.conversationId,
      inbox_id: 17,
      content: "winner",
      content_type: "text",
      message_type: 1,
      private: false,
      created_at: 1_700_000_701,
      source_id: null,
    });
    const gate = fixture.upstream.holdNextMessageList();
    const sync = fixture.app.get(SupportChatSyncService);
    await fixture.db
      .update(schema.supportChatJobs)
      .set({ nextAttemptAt: new Date(0) })
      .where(eq(schema.supportChatJobs.id, linked.jobId));
    const first = sync.run(linked.jobId, randomUUID());
    await gate.seen;
    expect(await sync.run(linked.jobId, randomUUID())).toBe(false);
    await fixture.db
      .update(schema.supportChatJobs)
      .set({ leaseExpiresAt: new Date(0) })
      .where(eq(schema.supportChatJobs.id, linked.jobId));
    const second = sync.run(linked.jobId, randomUUID());
    gate.release();
    expect(await second).toBe(true);
    expect(await first).toBe(false);
    const rows = await fixture.db
      .select()
      .from(schema.supportChatMessages)
      .where(eq(schema.supportChatMessages.episodeId, linked.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.text).toBe("winner");
    const [job] = await fixture.db
      .select()
      .from(schema.supportChatJobs)
      .where(eq(schema.supportChatJobs.id, linked.jobId));
    expect(job).toMatchObject({ state: "pending", retryCount: 0, lastErrorCode: null });
  });

  it("fails closed when the historical consent checkpoint is unknown", async () => {
    const linked = await acceptedEpisode();
    await fixture.db
      .update(schema.supportChatJobs)
      .set({ checkpoint: null })
      .where(eq(schema.supportChatJobs.id, linked.jobId));
    await fixture.db
      .update(schema.supportChatJobs)
      .set({ nextAttemptAt: new Date(0) })
      .where(eq(schema.supportChatJobs.id, linked.jobId));
    const sync = fixture.app.get(SupportChatSyncService);
    expect(await sync.run(linked.jobId, randomUUID())).toBe(false);
    const [job] = await fixture.db
      .select()
      .from(schema.supportChatJobs)
      .where(eq(schema.supportChatJobs.id, linked.jobId));
    expect(job).toMatchObject({ lastErrorCode: "consent_notice_unknown", retryCount: 1 });
    const [episode] = await fixture.db
      .select()
      .from(schema.supportChatEpisodes)
      .where(eq(schema.supportChatEpisodes.id, linked.id));
    expect(episode).toMatchObject({ transcriptState: "error", lastSyncedAt: null });
    const operatorView = await fixture.platform
      .get(`/platform/support-chat/episodes/${linked.id}`)
      .set("Cookie", fixture.platformCookie)
      .expect(200);
    expect(operatorView.body.sync).toEqual({
      state: "error",
      lastSyncedAt: null,
      errorCode: "consent_notice_unknown",
    });
  });

  it("imports an accepted historical notice when the current warning text changes", async () => {
    const linked = await acceptedEpisode();
    const [consent] = await fixture.db
      .select()
      .from(schema.supportChatConsents)
      .where(eq(schema.supportChatConsents.episodeId, linked.id));
    expect(consent?.noticeLocale).toBe("en");
    expect(consent?.noticeText).toBeTruthy();
    const originalNotice = platformContracts.supportTranscriptNotice;
    const currentNotice = vi.spyOn(platformContracts, "supportTranscriptNotice").mockImplementation(
      (locale) =>
        ({
          ...originalNotice(locale),
          text: "A future revision of the transcript warning.",
        }) as unknown as ReturnType<typeof originalNotice>,
    );
    try {
      expect(consent?.noticeText).not.toBe(platformContracts.supportTranscriptNotice("en").text);
      fixture.upstream.addMessage({
        id: 1501,
        conversation_id: linked.conversationId,
        inbox_id: 17,
        content: "Historical consent remains valid",
        content_type: "text",
        message_type: 1,
        private: false,
        created_at: 1_700_001_501,
        source_id: null,
      });
      await fixture.db
        .update(schema.supportChatJobs)
        .set({ nextAttemptAt: new Date(0) })
        .where(eq(schema.supportChatJobs.id, linked.jobId));
      expect(await fixture.app.get(SupportChatSyncService).run(linked.jobId, randomUUID())).toBe(
        true,
      );
      const [stored] = await fixture.db
        .select()
        .from(schema.supportChatMessages)
        .where(eq(schema.supportChatMessages.episodeId, linked.id));
      expect(stored?.text).toBe("Historical consent remains valid");
      const [episode] = await fixture.db
        .select()
        .from(schema.supportChatEpisodes)
        .where(eq(schema.supportChatEpisodes.id, linked.id));
      expect(episode?.transcriptState).toBe("healthy");
      expect(episode?.lastSyncedAt).not.toBeNull();
    } finally {
      currentNotice.mockRestore();
    }
  });

  it("correlates a send only with exact content and preserves its first remote timestamp", async () => {
    const linked = await acceptedEpisode();
    const [episode] = await fixture.db
      .select()
      .from(schema.supportChatEpisodes)
      .where(eq(schema.supportChatEpisodes.id, linked.id));
    if (!episode) throw new Error("Expected episode");
    const intent = await fixture.app
      .get(SupportChatRepository)
      .messageIntent(episode, "exact customer text", randomUUID());
    const remote = {
      id: 901,
      conversation_id: linked.conversationId,
      inbox_id: 17,
      content: "exact customer text",
      content_type: "text",
      message_type: 0,
      private: false,
      created_at: 1_700_000_901,
      source_id: intent.row.id,
    };
    fixture.upstream.addMessage(remote);
    await fixture.db
      .update(schema.supportChatJobs)
      .set({ nextAttemptAt: new Date(0) })
      .where(eq(schema.supportChatJobs.id, linked.jobId));
    const sync = fixture.app.get(SupportChatSyncService);
    expect(await sync.run(linked.jobId, randomUUID())).toBe(true);
    remote.created_at = 1_700_010_901;
    await fixture.db
      .update(schema.supportChatJobs)
      .set({ nextAttemptAt: new Date(0) })
      .where(eq(schema.supportChatJobs.id, linked.jobId));
    expect(await sync.run(linked.jobId, randomUUID())).toBe(true);
    const [stored] = await fixture.db
      .select()
      .from(schema.supportChatMessages)
      .where(eq(schema.supportChatMessages.id, intent.row.id));
    expect(stored).toMatchObject({
      delivery: "sent",
      remoteMessageId: 901,
      occurredAt: new Date(1_700_000_901_000),
    });
  });

  it("rejects a changed remote contact before persisting public or private payload", async () => {
    const linked = await acceptedEpisode();
    fixture.upstream.addMessage({
      id: 1001,
      conversation_id: linked.conversationId,
      inbox_id: 17,
      content: "foreign public",
      content_type: "text",
      message_type: 1,
      private: false,
      created_at: 1_700_001_001,
      source_id: null,
    });
    fixture.upstream.changeConversationContact(linked.conversationId, 9999);
    await fixture.db
      .update(schema.supportChatJobs)
      .set({ nextAttemptAt: new Date(0) })
      .where(eq(schema.supportChatJobs.id, linked.jobId));
    expect(await fixture.app.get(SupportChatSyncService).run(linked.jobId, randomUUID())).toBe(
      false,
    );
    const rows = await fixture.db
      .select()
      .from(schema.supportChatMessages)
      .where(eq(schema.supportChatMessages.episodeId, linked.id));
    expect(rows).toHaveLength(0);
    const [episode] = await fixture.db
      .select()
      .from(schema.supportChatEpisodes)
      .where(eq(schema.supportChatEpisodes.id, linked.id));
    expect(episode).toMatchObject({ transcriptState: "error", lastSyncedAt: null });
  });

  it("finds a delayed older message on the scheduled full reconciliation", async () => {
    const linked = await acceptedEpisode();
    for (let id = 1101; id <= 1181; id += 2)
      fixture.upstream.addMessage({
        id,
        conversation_id: linked.conversationId,
        inbox_id: 17,
        content: `original-${id}`,
        content_type: "text",
        message_type: 1,
        private: false,
        created_at: 1_700_000_000 + id,
        source_id: null,
      });
    const sync = fixture.app.get(SupportChatSyncService);
    await fixture.db
      .update(schema.supportChatJobs)
      .set({ nextAttemptAt: new Date(0) })
      .where(eq(schema.supportChatJobs.id, linked.jobId));
    expect(await sync.run(linked.jobId, randomUUID())).toBe(true);
    const [partial] = await fixture.db
      .select()
      .from(schema.supportChatEpisodes)
      .where(eq(schema.supportChatEpisodes.id, linked.id));
    expect(partial?.transcriptState).toBe("pending");
    expect(partial?.lastSyncedAt).toBeNull();
    await fixture.db
      .update(schema.supportChatJobs)
      .set({ nextAttemptAt: new Date(0) })
      .where(eq(schema.supportChatJobs.id, linked.jobId));
    expect(await sync.run(linked.jobId, randomUUID())).toBe(true);
    fixture.upstream.addMessage({
      id: 1102,
      conversation_id: linked.conversationId,
      inbox_id: 17,
      content: "delayed public",
      content_type: "text",
      message_type: 1,
      private: false,
      created_at: 1_700_001_102,
      source_id: null,
    });
    const [job] = await fixture.db
      .select()
      .from(schema.supportChatJobs)
      .where(eq(schema.supportChatJobs.id, linked.jobId));
    if (!job || !job.checkpoint || typeof job.checkpoint !== "object")
      throw new Error("Expected checkpoint");
    await fixture.db
      .update(schema.supportChatJobs)
      .set({
        nextAttemptAt: new Date(0),
        checkpoint: { ...job.checkpoint, lastFullAt: new Date(0).toISOString() },
      })
      .where(eq(schema.supportChatJobs.id, linked.jobId));
    expect(await sync.run(linked.jobId, randomUUID())).toBe(true);
    const [reconciling] = await fixture.db
      .select()
      .from(schema.supportChatEpisodes)
      .where(eq(schema.supportChatEpisodes.id, linked.id));
    expect(reconciling?.transcriptState).toBe("pending");
    await fixture.db
      .update(schema.supportChatJobs)
      .set({ nextAttemptAt: new Date(0) })
      .where(eq(schema.supportChatJobs.id, linked.jobId));
    expect(await sync.run(linked.jobId, randomUUID())).toBe(true);
    const rows = await fixture.db
      .select()
      .from(schema.supportChatMessages)
      .where(eq(schema.supportChatMessages.episodeId, linked.id));
    expect(rows).toHaveLength(42);
    expect(rows.map((row) => row.text)).toContain("delayed public");
  });

  it("finishes a backfill whose final page has exactly twenty raw messages", async () => {
    const linked = await acceptedEpisode();
    for (let id = 1201; id <= 1240; id++)
      fixture.upstream.addMessage({
        id,
        conversation_id: linked.conversationId,
        inbox_id: 17,
        content: `boundary-${id}`,
        content_type: "text",
        message_type: 1,
        private: id % 2 === 0,
        created_at: 1_700_000_000 + id,
        source_id: null,
      });
    await fixture.db
      .update(schema.supportChatJobs)
      .set({ nextAttemptAt: new Date(0) })
      .where(eq(schema.supportChatJobs.id, linked.jobId));
    expect(await fixture.app.get(SupportChatSyncService).run(linked.jobId, randomUUID())).toBe(
      true,
    );
    const [partial] = await fixture.db
      .select()
      .from(schema.supportChatEpisodes)
      .where(eq(schema.supportChatEpisodes.id, linked.id));
    expect(partial).toMatchObject({ transcriptState: "pending", lastSyncedAt: null });
    await fixture.db
      .update(schema.supportChatJobs)
      .set({ nextAttemptAt: new Date(0) })
      .where(eq(schema.supportChatJobs.id, linked.jobId));
    expect(await fixture.app.get(SupportChatSyncService).run(linked.jobId, randomUUID())).toBe(
      true,
    );
    const rows = await fixture.db
      .select()
      .from(schema.supportChatMessages)
      .where(eq(schema.supportChatMessages.episodeId, linked.id));
    expect(rows).toHaveLength(20);
    expect(rows.map((row) => row.remoteMessageId).sort((a, b) => (a ?? 0) - (b ?? 0))).toEqual(
      Array.from({ length: 20 }, (_, index) => 1201 + index * 2),
    );
    const [episode] = await fixture.db
      .select()
      .from(schema.supportChatEpisodes)
      .where(eq(schema.supportChatEpisodes.id, linked.id));
    expect(episode).toMatchObject({ transcriptState: "healthy" });
  });

  it("does not rebind a local intent when Chatwoot repeats a non-unique source ID", async () => {
    const linked = await acceptedEpisode();
    const [episode] = await fixture.db
      .select()
      .from(schema.supportChatEpisodes)
      .where(eq(schema.supportChatEpisodes.id, linked.id));
    if (!episode) throw new Error("Expected episode");
    const intent = await fixture.app
      .get(SupportChatRepository)
      .messageIntent(episode, "same source text", randomUUID());
    for (const id of [1301, 1302])
      fixture.upstream.addMessage({
        id,
        conversation_id: linked.conversationId,
        inbox_id: 17,
        content: "same source text",
        content_type: "text",
        message_type: 0,
        private: false,
        created_at: 1_700_000_000 + id,
        source_id: intent.row.id,
      });
    await fixture.db
      .update(schema.supportChatJobs)
      .set({ nextAttemptAt: new Date(0) })
      .where(eq(schema.supportChatJobs.id, linked.jobId));
    expect(await fixture.app.get(SupportChatSyncService).run(linked.jobId, randomUUID())).toBe(
      true,
    );
    const rows = await fixture.db
      .select()
      .from(schema.supportChatMessages)
      .where(eq(schema.supportChatMessages.episodeId, linked.id));
    expect(rows.map((row) => row.remoteMessageId).sort()).toEqual([1301, 1302]);
    const local = rows.find((row) => row.id === intent.row.id);
    expect(local).toMatchObject({ delivery: "sent", remoteMessageId: 1301 });
  });

  it("continues the same episode after the linked request is completed without changing its status", async () => {
    const linked = await acceptedEpisode();
    await fixture.db
      .update(schema.tenantBillingRequests)
      .set({ status: "completed" })
      .where(eq(schema.tenantBillingRequests.id, linked.requestId));
    fixture.upstream.addMessage({
      id: 1401,
      conversation_id: linked.conversationId,
      inbox_id: 17,
      content: "follow-up after completion",
      content_type: "text",
      message_type: 1,
      private: false,
      created_at: 1_700_001_401,
      source_id: null,
    });
    await fixture.db
      .update(schema.supportChatJobs)
      .set({ nextAttemptAt: new Date(0) })
      .where(eq(schema.supportChatJobs.id, linked.jobId));
    expect(await fixture.app.get(SupportChatSyncService).run(linked.jobId, randomUUID())).toBe(
      true,
    );
    const [request] = await fixture.db
      .select()
      .from(schema.tenantBillingRequests)
      .where(eq(schema.tenantBillingRequests.id, linked.requestId));
    expect(request?.status).toBe("completed");
    const rows = await fixture.db
      .select()
      .from(schema.supportChatMessages)
      .where(eq(schema.supportChatMessages.episodeId, linked.id));
    expect(rows.map((row) => row.text)).toContain("follow-up after completion");
  });
});
