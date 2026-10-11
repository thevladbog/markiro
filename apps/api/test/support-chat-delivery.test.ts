import { randomUUID } from "node:crypto";
import { schema } from "@markiro/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createSupportChatFixture } from "./support/support-chat-fixture";
import { SupportChatRepository } from "../src/modules/support-chat/support-chat.repository";

const ready =
  process.env.SUPPORT_CHAT_ISOLATED_DB === "1" &&
  Boolean(process.env.SUPPORT_CHAT_TEST_MAINTENANCE_URL);

describe.skipIf(!ready)("support chat durable delivery", () => {
  let fixture: Awaited<ReturnType<typeof createSupportChatFixture>>;
  beforeAll(async () => {
    fixture = await createSupportChatFixture();
  }, 120_000);
  afterAll(async () => {
    await fixture?.cleanup();
  });

  it("commits the local message and send job before the upstream POST", async () => {
    const created = await fixture.customerA
      .post("/support-chat/episodes")
      .send({ idempotencyKey: randomUUID() })
      .expect(201);
    let observed = false;
    fixture.upstream.inspectBeforeMessagePost(async (body) => {
      const id = body.source_id;
      if (typeof id !== "string") throw new Error("Expected correlation id");
      const [message] = await fixture.db
        .select()
        .from(schema.supportChatMessages)
        .where(eq(schema.supportChatMessages.id, id));
      const [job] = await fixture.db
        .select()
        .from(schema.supportChatJobs)
        .where(eq(schema.supportChatJobs.messageId, id));
      expect(message).toMatchObject({ delivery: "pending", episodeId: created.body.id });
      expect(job).toMatchObject({ state: "leased", kind: "send" });
      observed = true;
    });
    const sent = await fixture.customerA
      .post(`/support-chat/episodes/${created.body.id}/messages`)
      .send({ text: "Need help", idempotencyKey: randomUUID() })
      .expect(201);
    expect(observed).toBe(true);
    expect(sent.body).toMatchObject({ text: "Need help", delivery: "sent" });
    const [stored] = await fixture.db
      .select()
      .from(schema.supportChatMessages)
      .where(eq(schema.supportChatMessages.id, sent.body.id));
    expect(stored?.remoteMessageId).toBeTypeOf("number");
  });

  it("sends a previously queued intent once when its conversation becomes ready", async () => {
    const created = await fixture.customerA
      .post("/support-chat/episodes")
      .send({ idempotencyKey: randomUUID() })
      .expect(201);
    const [episode] = await fixture.db
      .select()
      .from(schema.supportChatEpisodes)
      .where(eq(schema.supportChatEpisodes.id, created.body.id));
    if (!episode) throw new Error("Expected episode");
    const key = randomUUID();
    const repository = fixture.app.get(SupportChatRepository);
    const intent = await repository.messageIntent(episode, "queued text", key);
    expect(intent.row.delivery).toBe("pending");
    const before = fixture.upstream.requests.filter(
      (entry) => entry.method === "POST" && /\/conversations\/\d+\/messages$/.test(entry.path),
    ).length;
    const sent = await fixture.customerA
      .post(`/support-chat/episodes/${episode.id}/messages`)
      .send({ text: "queued text", idempotencyKey: key })
      .expect(201);
    expect(sent.body).toMatchObject({ id: intent.row.id, delivery: "sent" });
    expect(
      fixture.upstream.requests.filter(
        (entry) => entry.method === "POST" && /\/conversations\/\d+\/messages$/.test(entry.path),
      ),
    ).toHaveLength(before + 1);
  });

  it("turns an expired in-flight send uncertain and fences its late response", async () => {
    const created = await fixture.customerA
      .post("/support-chat/episodes")
      .send({ idempotencyKey: randomUUID() })
      .expect(201);
    const [episode] = await fixture.db
      .select()
      .from(schema.supportChatEpisodes)
      .where(eq(schema.supportChatEpisodes.id, created.body.id));
    if (!episode) throw new Error("Expected episode");
    const repository = fixture.app.get(SupportChatRepository);
    const key = randomUUID();
    const intent = await repository.messageIntent(episode, "late response", key);
    const attemptToken = randomUUID();
    expect(await repository.claimSend(intent.row, attemptToken)).toBe(true);
    await fixture.db
      .update(schema.supportChatJobs)
      .set({ leaseExpiresAt: new Date(Date.now() - 1000) })
      .where(eq(schema.supportChatJobs.messageId, intent.row.id));
    const detail = await fixture.customerA.get(`/support-chat/episodes/${episode.id}`).expect(200);
    expect(detail.body.messages).toContainEqual(
      expect.objectContaining({
        id: intent.row.id,
        delivery: "uncertain",
      }),
    );
    const postsBefore = fixture.upstream.requests.filter(
      (entry) => entry.method === "POST" && /\/conversations\/\d+\/messages$/.test(entry.path),
    ).length;
    const retry = await fixture.customerA
      .post(`/support-chat/episodes/${episode.id}/messages`)
      .send({ text: "late response", idempotencyKey: key })
      .expect(201);
    expect(retry.body).toMatchObject({ id: intent.row.id, delivery: "uncertain" });
    expect(
      fixture.upstream.requests.filter(
        (entry) => entry.method === "POST" && /\/conversations\/\d+\/messages$/.test(entry.path),
      ),
    ).toHaveLength(postsBefore);
    const [owner] = await fixture.db
      .select()
      .from(schema.supportChatOwners)
      .where(eq(schema.supportChatOwners.id, episode.ownerId));
    if (
      !owner?.remoteContactId ||
      !episode.remoteAccountId ||
      !episode.remoteInboxId ||
      !episode.remoteConversationId
    ) {
      throw new Error("Expected mapping");
    }
    const late = await repository.markSent(
      intent.row,
      {
        accountId: episode.remoteAccountId,
        inboxId: episode.remoteInboxId,
        conversationId: episode.remoteConversationId,
        contactId: Number(owner.remoteContactId),
      },
      {
        remoteId: 777,
        direction: "customer",
        text: "late response",
        occurredAt: new Date(),
        sourceId: intent.row.id,
      },
      attemptToken,
    );
    expect(late.delivery).toBe("uncertain");
    const [stored] = await fixture.db
      .select()
      .from(schema.supportChatMessages)
      .where(eq(schema.supportChatMessages.id, intent.row.id));
    expect(stored).toMatchObject({ delivery: "uncertain", remoteMessageId: null });
  });
});
