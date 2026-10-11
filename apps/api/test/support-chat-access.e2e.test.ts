import { randomUUID } from "node:crypto";
import { schema } from "@markiro/db";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createSupportChatFixture } from "./support/support-chat-fixture";
import { createTestStationDevice } from "./support/auth";
import { createManagedSubscription } from "./support/subscription-fixtures";
import { EntitlementsService } from "../src/subscriptions/entitlements.service";

const ready =
  process.env.SUPPORT_CHAT_ISOLATED_DB === "1" &&
  Boolean(process.env.SUPPORT_CHAT_TEST_MAINTENANCE_URL);

describe.skipIf(!ready)("private support chat access", () => {
  let fixture: Awaited<ReturnType<typeof createSupportChatFixture>>;
  beforeAll(async () => {
    fixture = await createSupportChatFixture();
  }, 120_000);
  afterAll(async () => {
    await fixture?.cleanup();
  });

  it("creates only the caller's episode and hides it from another member", async () => {
    const created = await fixture.customerA
      .post("/support-chat/episodes")
      .send({ idempotencyKey: randomUUID() });
    expect(created.status).toBe(201);
    expect(created.body.id).toMatch(/^[0-9a-f-]{36}$/);
    const upstreamBeforeForeignRead = fixture.upstream.requests.length;
    const foreign = await fixture.customerB.get(`/support-chat/episodes/${created.body.id}`);
    expect(foreign.status).toBe(404);
    expect(foreign.headers["cache-control"]).toBe("private, no-store");
    expect(fixture.upstream.requests).toHaveLength(upstreamBeforeForeignRead);
  });

  it("keeps the same user's episodes separate after switching tenants", async () => {
    const first = await fixture.customerA
      .post("/support-chat/episodes")
      .send({ idempotencyKey: randomUUID() })
      .expect(201);
    const secondOrg = await fixture.customerA
      .post("/api/auth/organization/create")
      .send({ name: "Second support tenant", slug: `support-${randomUUID()}` })
      .expect(200);
    try {
      await fixture.customerA
        .post("/api/auth/organization/set-active")
        .send({ organizationId: secondOrg.body.id })
        .expect(200);
      const second = await fixture.customerA
        .post("/support-chat/episodes")
        .send({ idempotencyKey: randomUUID() })
        .expect(201);
      const list = await fixture.customerA.get("/support-chat/episodes").expect(200);
      expect(list.body.items.map((item: { id: string }) => item.id)).toContain(second.body.id);
      expect(list.body.items.map((item: { id: string }) => item.id)).not.toContain(first.body.id);
      await fixture.customerA.get(`/support-chat/episodes/${first.body.id}`).expect(404);
    } finally {
      await fixture.customerA
        .post("/api/auth/organization/set-active")
        .send({ organizationId: fixture.tenantId })
        .expect(200);
    }
  });

  it("advances the episode cursor without repeating the previous row", async () => {
    const one = await fixture.customerA
      .post("/support-chat/episodes")
      .send({ idempotencyKey: randomUUID() })
      .expect(201);
    const two = await fixture.customerA
      .post("/support-chat/episodes")
      .send({ idempotencyKey: randomUUID() })
      .expect(201);
    const seen = new Set<string>();
    let cursor: string | null = null;
    for (let page = 0; page < 20; page += 1) {
      const response: { body: { items: Array<{ id: string }>; nextCursor: string | null } } =
        await fixture.customerA
          .get("/support-chat/episodes")
          .query(cursor ? { limit: 1, cursor } : { limit: 1 })
          .expect(200);
      for (const item of response.body.items as Array<{ id: string }>) {
        expect(seen.has(item.id)).toBe(false);
        seen.add(item.id);
      }
      cursor = response.body.nextCursor;
      if (!cursor) break;
    }
    expect(seen.has(one.body.id)).toBe(true);
    expect(seen.has(two.body.id)).toBe(true);
  });

  it("rejects real station credentials and a real platform session", async () => {
    const station = await createTestStationDevice(
      fixture.app,
      fixture.customerA,
      "Support auth probe",
    );
    await fixture.anonymous
      .get("/support-chat/episodes")
      .set("x-api-key", station.apiKey)
      .expect(403);
    await fixture.platform.get("/support-chat/episodes").expect(401);
  });

  it("allows chat creation and send during a read-only subscription", async () => {
    const readOnly = await createSupportChatFixture();
    try {
      await createManagedSubscription(readOnly.db, {
        tenantId: readOnly.tenantId,
        status: "active",
        startsAt: new Date(Date.now() - 7_200_000),
        endsAt: new Date(Date.now() - 3_600_000),
      });
      const entitlements = readOnly.app.get(EntitlementsService);
      expect((await entitlements.resolve(readOnly.tenantId, undefined, new Date())).access).toBe(
        "read_only",
      );
      const created = await readOnly.customerA
        .post("/support-chat/episodes")
        .send({ idempotencyKey: randomUUID() })
        .expect(201);
      const sent = await readOnly.customerA
        .post(`/support-chat/episodes/${created.body.id}/messages`)
        .send({ text: "Help while read only", idempotencyKey: randomUUID() })
        .expect(201);
      expect(sent.body.delivery).toBe("sent");
    } finally {
      await readOnly.cleanup();
    }
  });

  it("keeps the route closed by default without contacting Chatwoot", async () => {
    const disabled = await createSupportChatFixture({ enabled: false });
    try {
      await disabled.customerA
        .post("/support-chat/episodes")
        .send({ idempotencyKey: randomUUID() })
        .expect(503);
      await disabled.customerA.get("/support-chat/episodes").expect(503);
      expect(disabled.upstream.requests).toHaveLength(0);
    } finally {
      await disabled.cleanup();
    }
  });

  it("persists an uncertain send and does not post it again for the same key", async () => {
    const created = await fixture.customerA
      .post("/support-chat/episodes")
      .send({ idempotencyKey: randomUUID() })
      .expect(201);
    fixture.upstream.abortAfterSaveOnce();
    const key = randomUUID();
    const first = await fixture.customerA
      .post(`/support-chat/episodes/${created.body.id}/messages`)
      .send({ text: "  Need support  ", idempotencyKey: key })
      .expect(201);
    expect(first.body).toMatchObject({ text: "  Need support  ", delivery: "uncertain" });
    const retry = await fixture.customerA
      .post(`/support-chat/episodes/${created.body.id}/messages`)
      .send({ text: "  Need support  ", idempotencyKey: key })
      .expect(201);
    expect(retry.body.id).toBe(first.body.id);
    expect(retry.body.delivery).toBe("uncertain");
    const posts = fixture.upstream.requests.filter(
      (entry) => entry.method === "POST" && /\/conversations\/\d+\/messages$/.test(entry.path),
    );
    expect(posts).toHaveLength(1);
    const [stored] = await fixture.db
      .select()
      .from(schema.supportChatMessages)
      .where(
        and(
          eq(schema.supportChatMessages.episodeId, created.body.id),
          eq(schema.supportChatMessages.idempotencyKey, key),
        ),
      );
    expect(stored?.delivery).toBe("uncertain");
    const reconciled = await fixture.customerA
      .get(`/support-chat/episodes/${created.body.id}`)
      .expect(200);
    expect(
      reconciled.body.messages.filter(
        (message: { text: string }) => message.text === "  Need support  ",
      ),
    ).toEqual([expect.objectContaining({ id: first.body.id, delivery: "sent" })]);
  });

  it("filters private, activity and HTML messages without leaking upstream metadata", async () => {
    const created = await fixture.customerA
      .post("/support-chat/episodes")
      .send({ idempotencyKey: randomUUID() })
      .expect(201);
    const [episode] = await fixture.db
      .select()
      .from(schema.supportChatEpisodes)
      .where(eq(schema.supportChatEpisodes.id, created.body.id));
    if (!episode?.remoteConversationId) throw new Error("Expected provisioned conversation");
    const base = {
      inbox_id: 17,
      conversation_id: episode.remoteConversationId,
      content_type: "text",
      created_at: Math.floor(Date.now() / 1000),
      source_id: null,
    };
    fixture.upstream.addMessage({
      ...base,
      id: 30001,
      content: "operator answer",
      message_type: 1,
      private: false,
    });
    fixture.upstream.addMessage({
      ...base,
      id: 30002,
      content: "internal note",
      message_type: 1,
      private: true,
    });
    fixture.upstream.addMessage({
      ...base,
      id: 30003,
      content: "activity",
      message_type: 2,
      private: false,
    });
    fixture.upstream.addMessage({
      ...base,
      id: 30004,
      content: "<b>html</b>",
      content_type: "html",
      message_type: 1,
      private: false,
    });
    const detail = await fixture.customerA
      .get(`/support-chat/episodes/${created.body.id}`)
      .expect(200);
    expect(detail.body.messages).toEqual([
      expect.objectContaining({ text: "operator answer", direction: "operator" }),
    ]);
    expect(JSON.stringify(detail.body)).not.toContain("confidential");
    expect(JSON.stringify(detail.body)).not.toContain("contact_id");
    expect(JSON.stringify(detail.body)).not.toContain("conversation_id");
  });

  it("pages backward from the latest message by occurrence time rather than local UUID order", async () => {
    const created = await fixture.customerA
      .post("/support-chat/episodes")
      .send({ idempotencyKey: randomUUID() })
      .expect(201);
    const earlierId = "ffffffff-ffff-4fff-8fff-ffffffffffff";
    const laterId = "00000000-0000-4000-8000-000000000001";
    await fixture.db.insert(schema.supportChatMessages).values([
      {
        id: earlierId,
        tenantId: fixture.tenantId,
        episodeId: created.body.id,
        direction: "customer",
        text: "earlier",
        occurredAt: new Date("2020-01-01T00:00:00Z"),
        delivery: "pending",
      },
      {
        id: laterId,
        tenantId: fixture.tenantId,
        episodeId: created.body.id,
        direction: "customer",
        text: "later",
        occurredAt: new Date("2021-01-01T00:00:00Z"),
        delivery: "pending",
      },
    ]);
    const first = await fixture.customerA
      .get(`/support-chat/episodes/${created.body.id}?limit=1`)
      .expect(200);
    expect(first.body.messages.map((message: { text: string }) => message.text)).toEqual(["later"]);
    const second = await fixture.customerA
      .get(`/support-chat/episodes/${created.body.id}`)
      .query({ limit: 1, cursor: first.body.nextCursor })
      .expect(200);
    expect(second.body.messages.map((message: { text: string }) => message.text)).toEqual([
      "earlier",
    ]);
  });

  it("denies a revoked member before reading upstream", async () => {
    const created = await fixture.customerA
      .post("/support-chat/episodes")
      .send({ idempotencyKey: randomUUID() })
      .expect(201);
    await fixture.db
      .delete(schema.member)
      .where(
        and(
          eq(schema.member.organizationId, fixture.tenantId),
          eq(schema.member.userId, fixture.userA),
        ),
      );
    const before = fixture.upstream.requests.length;
    await fixture.customerA.get(`/support-chat/episodes/${created.body.id}`).expect(403);
    expect(fixture.upstream.requests).toHaveLength(before);
  });

  it("denies a member revoked while upstream history is in flight", async () => {
    const created = await fixture.customerB
      .post("/support-chat/episodes")
      .send({ idempotencyKey: randomUUID() })
      .expect(201);
    const gate = fixture.upstream.holdNextMessageList();
    const pending = fixture.customerB.get(`/support-chat/episodes/${created.body.id}`);
    const response = pending.then((value) => value);
    await gate.seen;
    await fixture.db
      .delete(schema.member)
      .where(
        and(
          eq(schema.member.organizationId, fixture.tenantId),
          eq(schema.member.userId, fixture.userB),
        ),
      );
    gate.release();
    expect((await response).status).toBe(403);
  });
});
