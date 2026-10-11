import { describe, expect, it } from "vitest";
import * as contracts from "../src/index.js";

const uuid = "00000000-0000-4000-8000-000000000001";

describe("support chat boundary contracts", () => {
  it("binds consent to a server-owned localized notice", () => {
    const ru = contracts.supportTranscriptNotice("ru");
    const en = contracts.supportTranscriptNotice("en");
    expect(ru).toEqual({
      version: "support-transcript-v1",
      locale: "ru",
      text: "Переписка по этому вопросу будет добавлена в обращение. Её смогут читать владелец и администраторы вашей организации, а также поддержка Markiro. Новые сообщения этого диалога тоже будут добавляться",
    });
    expect(en.version).toBe("support-transcript-v1");
    expect(en.locale).toBe("en");
    expect(en.text).toContain("owner and administrators");
    const body = contracts.supportChatContracts.decision.body;
    const valid = {
      decision: "accept",
      revision: 1,
      noticeVersion: ru.version,
      noticeLocale: "ru",
      idempotencyKey: uuid,
    };
    expect(body.safeParse(valid).success).toBe(true);
    expect(body.safeParse({ ...valid, noticeLocale: "de" }).success).toBe(false);
    expect(body.safeParse({ ...valid, noticeText: "other" }).success).toBe(false);
  });
  it("rejects empty, oversized, and remote-controlled message bodies", () => {
    const endpoint = contracts.supportChatContracts.message;
    expect(endpoint.body.safeParse({ text: "", idempotencyKey: uuid }).success).toBe(false);
    expect(endpoint.body.safeParse({ text: "x".repeat(2001), idempotencyKey: uuid }).success).toBe(
      false,
    );
    expect(
      endpoint.body.safeParse({ text: "hello", idempotencyKey: uuid, conversationId: 123 }).success,
    ).toBe(false);
    expect(endpoint.body.safeParse({ text: "hello", idempotencyKey: "not-a-uuid" }).success).toBe(
      false,
    );
    expect(endpoint.body.safeParse({ text: "hello", idempotencyKey: uuid }).success).toBe(true);
  });

  it("preserves exact submitted text while limiting the raw input length", () => {
    const body = contracts.supportChatContracts.message.body;
    expect(body.safeParse({ text: "   ", idempotencyKey: uuid }).success).toBe(false);
    expect(body.safeParse({ text: `${"x".repeat(2_000)} `, idempotencyKey: uuid }).success).toBe(
      false,
    );
    const parsed = body.parse({ text: "  hello\n", idempotencyKey: uuid });
    expect(parsed.text).toBe("  hello\n");
  });

  it("bounds pagination and forbids unknown identity selectors", () => {
    expect(contracts.supportChatContracts.episodeList.query.safeParse({ limit: 101 }).success).toBe(
      false,
    );
    expect(contracts.supportChatContracts.episodeList.query.safeParse({ limit: 100 }).success).toBe(
      true,
    );
    expect(
      contracts.supportChatContracts.episodeList.query.safeParse({ tenantId: "other" }).success,
    ).toBe(false);
    expect(
      contracts.platformSupportChatContracts.episodeList.query.safeParse({ limit: 0 }).success,
    ).toBe(false);
    expect(
      contracts.platformSupportChatContracts.episodeList.query.safeParse({ cursor: "not-a-uuid" })
        .success,
    ).toBe(false);
    expect(
      contracts.platformSupportChatContracts.episodeList.query.safeParse({ cursor: uuid }).success,
    ).toBe(true);
    expect(
      contracts.supportTranscriptContracts.tenant.query.safeParse({ cursor: "opaque" }).success,
    ).toBe(true);
    expect(
      contracts.supportTranscriptContracts.tenant.query.safeParse({ limit: 101 }).success,
    ).toBe(false);
  });

  it("exposes a limited request reference with no billing detail", () => {
    const safe = { id: uuid, number: "BR-000001", status: "new" };
    expect(contracts.supportRequestRefSchema.safeParse(safe).success).toBe(true);
    expect(
      contracts.supportRequestRefSchema.safeParse({ ...safe, description: "private" }).success,
    ).toBe(false);
    expect(contracts.supportRequestRefSchema.safeParse({ ...safe, events: [] }).success).toBe(
      false,
    );
  });

  it("exposes public messages with local IDs and no remote fields", () => {
    const message = {
      id: uuid,
      direction: "customer",
      text: "hello",
      occurredAt: "2026-10-06T00:00:00.000Z",
      delivery: "sent",
    };
    expect(contracts.supportMessageSchema.safeParse(message).success).toBe(true);
    expect(
      contracts.supportMessageSchema.safeParse({ ...message, remoteMessageId: 1 }).success,
    ).toBe(false);
    expect(
      contracts.supportMessageSchema.safeParse({ ...message, delivery: "pending" }).success,
    ).toBe(true);
    expect(
      contracts.supportMessageSchema.safeParse({ ...message, text: "x".repeat(4_001) }).success,
    ).toBe(true);
  });

  it("accepts only sent public messages in a transcript", () => {
    const message = {
      id: uuid,
      direction: "operator",
      text: "a public reply",
      occurredAt: "2026-10-06T00:00:00.000Z",
      delivery: "sent",
    };
    const page = {
      items: [message],
      nextCursor: null,
      sync: { state: "healthy", lastSyncedAt: null, errorCode: null },
    };
    const response = contracts.supportTranscriptContracts.tenant.response;
    expect(response.safeParse(page).success).toBe(true);
    expect(
      response.safeParse({ ...page, sync: { ...page.sync, errorCode: "upstream-secret" } }).success,
    ).toBe(false);
    expect(
      response.safeParse({ ...page, items: [{ ...message, delivery: "pending" }] }).success,
    ).toBe(false);
    expect(response.safeParse({ ...page, items: [{ ...message, private: true }] }).success).toBe(
      false,
    );
  });
});
