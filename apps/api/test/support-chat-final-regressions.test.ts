import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { schema } from "@markiro/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SupportChatJobsService } from "../src/modules/support-chat/support-chat-jobs.service";
import { SupportChatRepository } from "../src/modules/support-chat/support-chat.repository";
import { createSupportChatFixture, type SupportChatFixture } from "./support/support-chat-fixture";

const ready =
  process.env.SUPPORT_CHAT_ISOLATED_DB === "1" &&
  Boolean(process.env.SUPPORT_CHAT_TEST_MAINTENANCE_URL);
describe.skipIf(!ready)("support chat final lifecycle regressions", () => {
  let f: SupportChatFixture;
  beforeAll(async () => {
    f = await createSupportChatFixture();
    const [operator] = await f.db.select().from(schema.platformUsers).limit(1);
    if (!operator) throw Error("Expected operator");
    await f.db
      .update(schema.platformUsers)
      .set({ role: "platform_admin", status: "active", twoFactorEnabled: true })
      .where(eq(schema.platformUsers.id, operator.id));
    await f.db.insert(schema.platformTwoFactors).values({
      id: randomUUID(),
      userId: operator.id,
      secret: "test-only",
      backupCodes: "[]",
      verified: true,
    });
  }, 120_000);
  afterAll(async () => {
    await f?.cleanup();
  });
  async function create() {
    const response = await f.customerB
      .post("/support-chat/episodes")
      .send({ idempotencyKey: randomUUID() })
      .expect(201);
    const [row] = await f.db
      .select()
      .from(schema.supportChatEpisodes)
      .where(eq(schema.supportChatEpisodes.id, response.body.id));
    if (!row) throw Error("Expected episode");
    return row;
  }
  async function propose(id: string) {
    return (
      await f.platform
        .post(`/platform/support-chat/episodes/${id}/proposals`)
        .set("Cookie", f.platformCookie)
        .send({ title: "Help", summary: "Current issue", idempotencyKey: randomUUID() })
        .expect(201)
    ).body;
  }
  async function decide(
    id: string,
    proposal: { id: string; revision: number; noticeVersion: string },
    decision = "accept",
  ) {
    return f.customerB
      .post(`/support-chat/episodes/${id}/proposals/${proposal.id}/decision`)
      .send({
        decision,
        revision: proposal.revision,
        noticeVersion: proposal.noticeVersion,
        noticeLocale: "en",
        idempotencyKey: randomUUID(),
      })
      .expect(201);
  }
  async function executeDue() {
    // Advance the persisted scheduling boundary, without sleeping or depending on host/PG clock skew.
    await f.db
      .update(schema.supportChatJobs)
      .set({ nextAttemptAt: new Date(0) })
      .where(eq(schema.supportChatJobs.state, "pending"));
    const jobs = f.app.get(SupportChatJobsService);
    await jobs.repairAndWake(async (id) => {
      await jobs.run(id);
    });
  }
  function add(conversationId: number, id: number, privateMessage = false, activity = false) {
    f.upstream.addMessage({
      id,
      conversation_id: conversationId,
      inbox_id: 17,
      content: `remote-${id}`,
      content_type: "text",
      message_type: activity ? 2 : 1,
      private: privateMessage,
      created_at: 1_700_000_000 + id,
      source_id: null,
    });
  }
  it("repairs provisioning interrupted before any remote POST", async () => {
    f.upstream.setUnavailable(true);
    let id: string;
    try {
      id = (
        await f.customerA
          .post("/support-chat/episodes")
          .send({ idempotencyKey: randomUUID() })
          .expect(201)
      ).body.id;
    } finally {
      f.upstream.setUnavailable(false);
    }
    await executeDue();
    const [mapped] = await f.db
      .select()
      .from(schema.supportChatEpisodes)
      .where(eq(schema.supportChatEpisodes.id, id));
    expect(mapped?.remoteConversationId).toBeTypeOf("number");
    const [job] = await f.db
      .select()
      .from(schema.supportChatJobs)
      .where(eq(schema.supportChatJobs.episodeId, id));
    expect(job).toMatchObject({ kind: "reconcile", state: "completed" });
  });
  it("repairs an episode committed before its initial transport wakeup", async () => {
    const episode = await f.app
      .get(SupportChatRepository)
      .createEpisode({ tenantId: f.tenantId, userId: f.userA }, randomUUID());
    await executeDue();
    const [mapped] = await f.db
      .select()
      .from(schema.supportChatEpisodes)
      .where(eq(schema.supportChatEpisodes.id, episode.id));
    expect(mapped?.remoteConversationId).toBeTypeOf("number");
  });
  it("completes real provisioning without dispatching it as a consent import before or after consent", async () => {
    const episode = await create();
    await executeDue();
    const jobs = await f.db
      .select()
      .from(schema.supportChatJobs)
      .where(eq(schema.supportChatJobs.episodeId, episode.id));
    expect(jobs.filter((j) => j.kind === "reconcile")).toEqual([
      expect.objectContaining({ state: "completed", lastErrorCode: null }),
    ]);
    await decide(episode.id, await propose(episode.id));
    await executeDue();
    const detail = await f.customerB.get(`/support-chat/episodes/${episode.id}`).expect(200);
    expect(detail.body.sync.state).toBe("healthy");
  });
  it("fails closed for preconsent reads and sends after an upstream contact reassignment", async () => {
    const episode = await create();
    add(episode.remoteConversationId!, 21001);
    f.upstream.changeConversationContact(episode.remoteConversationId!, 99999);
    const start = f.upstream.requests.length;
    const detail = await f.customerB.get(`/support-chat/episodes/${episode.id}`).expect(200);
    expect(detail.body.messages).toEqual([]);
    expect(detail.body.sync.state).toBe("error");
    const response = await f.customerB
      .post(`/support-chat/episodes/${episode.id}/messages`)
      .send({ text: "Must not escape", idempotencyKey: randomUUID() })
      .expect(201);
    expect(response.body.delivery).toBe("pending");
    expect(f.upstream.requests.slice(start).filter((r) => r.path.endsWith("/messages"))).toEqual(
      [],
    );
  });
  it("recovers an unavailable upstream and a definitely unclaimed send with exactly one eventual POST", async () => {
    const episode = await create();
    f.upstream.setUnavailable(true);
    let pending;
    try {
      pending = await f.customerB
        .post(`/support-chat/episodes/${episode.id}/messages`)
        .send({ text: "Recover me", idempotencyKey: randomUUID() })
        .expect(201);
      expect(pending.body.delivery).toBe("pending");
    } finally {
      f.upstream.setUnavailable(false);
    }
    await executeDue();
    await executeDue();
    const [mapping] = await f.db
      .select()
      .from(schema.supportChatEpisodes)
      .where(eq(schema.supportChatEpisodes.id, episode.id));
    expect(mapping?.remoteConversationId).not.toBeNull();
    const [stored] = await f.db
      .select()
      .from(schema.supportChatMessages)
      .where(eq(schema.supportChatMessages.id, pending.body.id));
    expect(stored?.delivery).toBe("sent");
    expect(f.upstream.messages.filter((m) => m.source_id === pending.body.id)).toHaveLength(1);
  });
  it("returns the latest fifty, exhausts backward history, and polls a later reply", async () => {
    const episode = await create();
    await f.db.insert(schema.supportChatMessages).values(
      Array.from({ length: 65 }, (_, i) => ({
        tenantId: f.tenantId,
        episodeId: episode.id,
        direction: "operator" as const,
        text: `stored-${i}`,
        occurredAt: new Date(1_700_000_000_000 + i * 1000),
        delivery: "sent" as const,
        remoteAccountId: 13,
        remoteInboxId: 17,
        remoteConversationId: episode.remoteConversationId!,
        remoteMessageId: 20000 + i,
      })),
    );
    const first = await f.customerB.get(`/support-chat/episodes/${episode.id}`).expect(200);
    expect(first.body.messages.map((m: { text: string }) => m.text)).toContain("stored-64");
    expect(first.body.messages.map((m: { text: string }) => m.text)).not.toContain("stored-0");
    const older = await f.customerB
      .get(`/support-chat/episodes/${episode.id}`)
      .query({ cursor: first.body.nextCursor })
      .expect(200);
    expect(older.body.messages).toHaveLength(15);
    expect(older.body.nextCursor).toBeNull();
    add(episode.remoteConversationId!, 22001);
    const poll = await f.customerB.get(`/support-chat/episodes/${episode.id}`).expect(200);
    expect(poll.body.messages.map((m: { text: string }) => m.text)).toContain("remote-22001");
  });
  it("does not recover sends after membership revocation or replay uncertain POSTs", async () => {
    const episode = await create();
    const input = { text: "Pending admission", idempotencyKey: randomUUID() };
    f.upstream.setUnavailable(true);
    try {
      await f.customerB
        .post(`/support-chat/episodes/${episode.id}/messages`)
        .send(input)
        .expect(201);
    } finally {
      f.upstream.setUnavailable(false);
    }
    const [member] = await f.db
      .select()
      .from(schema.member)
      .where(and(eq(schema.member.organizationId, f.tenantId), eq(schema.member.userId, f.userB)));
    if (!member) throw Error("Expected membership");
    await f.db.delete(schema.member).where(eq(schema.member.id, member.id));
    const before = f.upstream.requests.length;
    try {
      await executeDue();
      expect(f.upstream.requests.slice(before).filter((r) => r.method === "POST")).toEqual([]);
    } finally {
      await f.db.insert(schema.member).values(member);
    }
    await executeDue();
    f.upstream.abortAfterSaveOnce();
    const uncertain = await f.customerB
      .post(`/support-chat/episodes/${episode.id}/messages`)
      .send({ text: "Ambiguous", idempotencyKey: randomUUID() })
      .expect(201);
    expect(uncertain.body.delivery).toBe("uncertain");
    await executeDue();
    expect(f.upstream.messages.filter((m) => m.source_id === uncertain.body.id)).toHaveLength(1);
  });
  it("continues a large burst from its durable cursor without rescanning old complete history", async () => {
    const episode = await create();
    add(episode.remoteConversationId!, 25001);
    await f.customerB.get(`/support-chat/episodes/${episode.id}`).expect(200);
    for (let id = 25002; id <= 25081; id++) add(episode.remoteConversationId!, id);
    for (let poll = 0; poll < 3; poll++)
      await f.customerB.get(`/support-chat/episodes/${episode.id}`).expect(200);
    const stored = await f.db
      .select()
      .from(schema.supportChatMessages)
      .where(eq(schema.supportChatMessages.episodeId, episode.id));
    expect(stored).toHaveLength(81);
    const before = f.upstream.requests.length;
    await f.customerB.get(`/support-chat/episodes/${episode.id}`).expect(200);
    expect(
      f.upstream.requests.slice(before).filter((r) => r.path.endsWith("/messages")),
    ).toHaveLength(1);
  });
  it("persists bounded raw-page progress through private-only pages for offline private history", async () => {
    const episode = await create();
    for (let id = 23001; id <= 23125; id++)
      add(episode.remoteConversationId!, id, id > 23020 && id <= 23080, id % 5 === 0);
    for (let poll = 0; poll < 8; poll++) {
      const start = f.upstream.requests.length;
      await f.customerB.get(`/support-chat/episodes/${episode.id}`).expect(200);
      expect(
        f.upstream.requests.slice(start).filter((r) => r.path.endsWith("/messages")).length,
      ).toBeLessThanOrEqual(3);
    }
    f.upstream.setUnavailable(true);
    try {
      const texts: string[] = [];
      let cursor: string | null = null;
      do {
        const response: { body: { messages: { text: string }[]; nextCursor: string | null } } =
          await f.customerB
            .get(`/support-chat/episodes/${episode.id}`)
            .query(cursor ? { cursor, limit: 10 } : { limit: 10 })
            .expect(200);
        texts.push(...response.body.messages.map((m: { text: string }) => m.text));
        cursor = response.body.nextCursor;
      } while (cursor);
      expect(texts).toHaveLength(52);
      expect(texts).toContain("remote-23001");
      expect(texts).toContain("remote-23124");
      expect(texts).not.toContain("remote-23041");
      expect(texts).not.toContain("remote-23005");
      const [stored] = await f.db
        .select()
        .from(schema.supportChatEpisodes)
        .where(eq(schema.supportChatEpisodes.id, episode.id));
      expect(stored?.requestId).toBeNull();
    } finally {
      f.upstream.setUnavailable(false);
    }
  });
  it.each([false, true])(
    "fences preconsent persistence across acceptance with upstream failure=%s",
    async (fail) => {
      const episode = await create();
      add(episode.remoteConversationId!, fail ? 24001 : 24002);
      const proposal = await propose(episode.id);
      const gate = f.upstream.holdNextMessageList();
      const detailPromise = f.customerB.get(`/support-chat/episodes/${episode.id}`).then((r) => r);
      await gate.seen;
      try {
        await decide(episode.id, proposal);
        if (fail) f.upstream.failMessageListAfter(0);
      } finally {
        gate.release();
      }
      await detailPromise;
      const [current] = await f.db
        .select()
        .from(schema.supportChatEpisodes)
        .where(eq(schema.supportChatEpisodes.id, episode.id));
      expect(current).toMatchObject({ transcriptState: "pending", lastSyncedAt: null });
      const rows = await f.db
        .select()
        .from(schema.supportChatMessages)
        .where(eq(schema.supportChatMessages.episodeId, episode.id));
      expect(rows).toEqual([]);
      const [job] = await f.db
        .select()
        .from(schema.supportChatJobs)
        .where(
          and(
            eq(schema.supportChatJobs.episodeId, episode.id),
            eq(schema.supportChatJobs.kind, "import"),
          ),
        );
      expect(job?.state).toBe("pending");
    },
  );
  it("accepts a fresh revision after a decline and keeps its accepted request immutable", async () => {
    const episode = await create();
    await decide(episode.id, await propose(episode.id), "decline");
    const revision = await propose(episode.id);
    expect(revision.revision).toBe(2);
    const accepted = await decide(episode.id, revision);
    expect(accepted.body.request.number).toMatch(/^BR-/);
    await f.platform
      .post(`/platform/support-chat/episodes/${episode.id}/proposals`)
      .set("Cookie", f.platformCookie)
      .send({ title: "Replacement", summary: "No", idempotencyKey: randomUUID() })
      .expect(409);
  });
});
