import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createSupportChatFixture, type SupportChatFixture } from "./support/support-chat-fixture";

const ready =
  process.env.SUPPORT_CHAT_ISOLATED_DB === "1" &&
  Boolean(process.env.SUPPORT_CHAT_TEST_MAINTENANCE_URL);

describe.skipIf(!ready)("support episode list cursor", () => {
  let fixture: SupportChatFixture;
  beforeAll(async () => {
    fixture = await createSupportChatFixture();
  }, 120_000);
  afterAll(async () => {
    await fixture?.cleanup();
  });

  it("returns 400 for a malformed cursor before a UUID database comparison", async () => {
    const response = await fixture.customerA.get("/support-chat/episodes?cursor=not-a-uuid");
    expect(response.status).toBe(400);
  });

  it("pages only the current owner's episodes with a valid cursor", async () => {
    const firstId = (
      await fixture.customerA
        .post("/support-chat/episodes")
        .send({ idempotencyKey: randomUUID() })
        .expect(201)
    ).body.id as string;
    const secondId = (
      await fixture.customerA
        .post("/support-chat/episodes")
        .send({ idempotencyKey: randomUUID() })
        .expect(201)
    ).body.id as string;
    await fixture.customerB
      .post("/support-chat/episodes")
      .send({ idempotencyKey: randomUUID() })
      .expect(201);
    const first = await fixture.customerA.get("/support-chat/episodes?limit=1").expect(200);
    expect(first.body.items).toHaveLength(1);
    expect(first.body.nextCursor).toBe(first.body.items[0].id);
    const second = await fixture.customerA
      .get(`/support-chat/episodes?limit=1&cursor=${first.body.nextCursor}`)
      .expect(200);
    expect(second.body.items).toHaveLength(1);
    expect([first.body.items[0].id, second.body.items[0].id]).toEqual([firstId, secondId]);
    expect(second.body.nextCursor).toBeNull();
  });
});
