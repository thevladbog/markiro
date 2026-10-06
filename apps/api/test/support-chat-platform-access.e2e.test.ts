import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { schema } from "@markiro/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createSupportChatFixture, type SupportChatFixture } from "./support/support-chat-fixture";

const enabled =
  process.env.SUPPORT_CHAT_ISOLATED_DB === "1" &&
  Boolean(process.env.SUPPORT_CHAT_TEST_MAINTENANCE_URL);
describe.skipIf(!enabled)("platform support chat access", () => {
  let fixture: SupportChatFixture;
  let operatorId: string;
  let episodeId: string;
  beforeAll(async () => {
    fixture = await createSupportChatFixture();
    const [operator] = await fixture.db.select().from(schema.platformUsers).limit(1);
    if (!operator) throw new Error("Missing platform operator");
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
    episodeId = (
      await fixture.customerB
        .post("/support-chat/episodes")
        .send({ idempotencyKey: randomUUID() })
        .expect(201)
    ).body.id;
  }, 90_000);
  afterAll(async () => {
    await fixture?.cleanup();
  });

  it("requires a current platform principal rather than cabinet, device, or Chatwoot identity", async () => {
    const url = `/platform/support-chat/episodes/${episodeId}/proposals`;
    const body = { title: "Support", summary: "Need help", idempotencyKey: randomUUID() };
    expect((await fixture.anonymous.post(url).send(body)).status).toBe(401);
    expect(
      (await fixture.anonymous.post(url).set("api_access_token", "test-chatwoot-token").send(body))
        .status,
    ).toBe(401);
    expect((await fixture.customerB.post(url).send(body)).status).toBe(401);
    expect(await fixture.db.select().from(schema.supportChatProposals)).toHaveLength(0);
  });

  it("separates billing.read from billing.write and hides upstream mapping", async () => {
    const headers = { Cookie: fixture.platformCookie };
    const detail = await fixture.platform
      .get(`/platform/support-chat/episodes/${episodeId}`)
      .set(headers);
    expect(detail.status).toBe(200);
    expect(JSON.stringify(detail.body)).not.toMatch(
      /remoteAccountId|remoteConversationId|remoteInboxId|remoteContactId/,
    );
    const listed = await fixture.platform.get("/platform/support-chat/episodes").set(headers);
    expect(listed.status).toBe(200);
    expect(listed.body.items.map((item: { id: string }) => item.id)).toContain(episodeId);
    expect(
      (await fixture.platform.get("/platform/support-chat/episodes?cursor=not-a-uuid").set(headers))
        .status,
    ).toBe(400);
    await fixture.db
      .update(schema.platformUsers)
      .set({ role: "support" })
      .where(eq(schema.platformUsers.id, operatorId));
    try {
      expect(
        (await fixture.platform.get(`/platform/support-chat/episodes/${episodeId}`).set(headers))
          .status,
      ).toBe(403);
      expect(
        (
          await fixture.platform
            .post(`/platform/support-chat/episodes/${episodeId}/proposals`)
            .set(headers)
            .send({ title: "Support", summary: "Need help", idempotencyKey: randomUUID() })
        ).status,
      ).toBe(403);
    } finally {
      await fixture.db
        .update(schema.platformUsers)
        .set({ role: "platform_admin" })
        .where(eq(schema.platformUsers.id, operatorId));
    }
  });
});
