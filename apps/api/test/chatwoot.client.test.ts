import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ChatwootClient } from "../src/modules/support-chat/chatwoot.client";
import { loadEnv } from "../src/env";
import type { SupportChatRepository } from "../src/modules/support-chat/support-chat.repository";

describe("pinned Chatwoot Application API boundary", () => {
  let server: Server;
  let client: ChatwootClient;
  const requests: Array<{ path: string; method: string; body: unknown }> = [];
  let response: unknown = {};
  let status = 200;

  beforeAll(async () => {
    server = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const raw = Buffer.concat(chunks).toString("utf8");
      requests.push({
        path: req.url ?? "",
        method: req.method ?? "",
        body: raw ? JSON.parse(raw) : null,
      });
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(response));
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected test port");
    client = new ChatwootClient(
      {
        baseUrl: `http://127.0.0.1:${address.port}`,
        accountId: 13,
        inboxId: 17,
        apiToken: "local-test-token",
      },
      {} as SupportChatRepository,
    );
  });
  afterAll(async () => {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  });

  it("chooses only an exact opaque identifier from substring contact search", async () => {
    const wanted = client.contactIdentifier("tenant-one", "user-one");
    expect(wanted).not.toContain("tenant-one");
    response = {
      payload: [
        {
          id: 41,
          identifier: `prefix-${wanted}`,
          contact_inboxes: [{ inbox: { id: 17 }, source_id: "wrong" }],
        },
        {
          id: 42,
          identifier: wanted,
          contact_inboxes: [{ inbox: { id: 17 }, source_id: "right" }],
        },
      ],
    };
    status = 200;
    expect(await client.findContact(wanted)).toEqual({ contactId: 42, sourceId: "right" });
    expect(requests.at(-1)?.path).toContain(`/accounts/13/contacts/search?q=${wanted}`);
  });

  it("sends source correlation and accepts only an expected public text response", async () => {
    response = {
      id: 81,
      inbox_id: 17,
      conversation_id: 19,
      content: "  exact text  ",
      content_type: "text",
      message_type: 0,
      private: false,
      created_at: 1_700_000_000,
      source_id: "11111111-1111-4111-8111-111111111111",
    };
    const sent = await client.sendMessage(
      { accountId: 13, inboxId: 17, contactId: 42, conversationId: 19 },
      { id: "11111111-1111-4111-8111-111111111111", text: "  exact text  " },
    );
    expect(sent).toMatchObject({ remoteId: 81, text: "  exact text  ", direction: "customer" });
    expect(requests.at(-1)?.body).toEqual({
      content: "  exact text  ",
      message_type: "incoming",
      private: false,
      source_id: "11111111-1111-4111-8111-111111111111",
      content_attributes: { markiro_support_message_id: "11111111-1111-4111-8111-111111111111" },
    });
  });

  it("refuses to bind an upstream send response with missing or mismatched intent facts", async () => {
    const intent = { id: "11111111-1111-4111-8111-111111111111", text: "exact text" };
    const mapping = { accountId: 13, inboxId: 17, contactId: 42, conversationId: 19 };
    const valid = {
      id: 82,
      inbox_id: 17,
      conversation_id: 19,
      content: intent.text,
      content_type: "text",
      message_type: 0,
      private: false,
      created_at: 1_700_000_000,
    };
    for (const malformed of [
      { ...valid },
      { ...valid, source_id: "22222222-2222-4222-8222-222222222222" },
      { ...valid, source_id: intent.id, content: "different" },
    ]) {
      response = malformed;
      await expect(client.sendMessage(mapping, intent)).rejects.toThrow("send response");
    }
  });

  it("requires the expected contact in a new conversation response", async () => {
    const valid = { id: 91, account_id: 13, inbox_id: 17 };
    for (const malformed of [valid, { ...valid, meta: { sender: { id: 99 } } }]) {
      response = malformed;
      await expect(
        client.createConversation(42, "source-42", "11111111-1111-4111-8111-111111111111"),
      ).rejects.toThrow("contact mismatch");
    }
  });

  it("drops private, activity and HTML messages and rejects a foreign inbox", async () => {
    const base = {
      conversation_id: 19,
      inbox_id: 17,
      created_at: 1_700_000_000,
      content_type: "text",
    };
    response = {
      meta: { email: "private@example.invalid" },
      payload: [
        { ...base, id: 1, message_type: 1, private: false, content: "visible" },
        { ...base, id: 2, message_type: 1, private: true, content: "note" },
        { ...base, id: 3, message_type: 2, private: false, content: "activity" },
        {
          ...base,
          id: 4,
          message_type: 1,
          private: false,
          content_type: "html",
          content: "<b>x</b>",
        },
      ],
    };
    const mapping = { accountId: 13, inboxId: 17, contactId: 42, conversationId: 19 };
    expect((await client.listMessages(mapping)).map((item) => item.text)).toEqual(["visible"]);
    response = {
      payload: [
        { ...base, id: 5, inbox_id: 99, message_type: 1, private: false, content: "foreign" },
      ],
    };
    await expect(client.listMessages(mapping)).rejects.toThrow("scope mismatch");
  });
});

describe("support chat configuration", () => {
  const base = {
    NODE_ENV: "test",
    DATABASE_URL: "postgresql://test.invalid/postgres",
    BETTER_AUTH_SECRET: "local-test-auth-placeholder",
    BETTER_AUTH_URL: "http://127.0.0.1:3000",
    PLATFORM_AUTH_SECRET: "local-test-platform-placeholder-000",
    PLATFORM_AUTH_URL: "http://127.0.0.1:3001",
    SAAS_ADMIN_ORIGIN: "http://127.0.0.1:5473",
    PAIRING_CODE_PEPPER: "local-test-pepper-placeholder",
  };
  it("defaults off without any Chatwoot credentials", () => {
    expect(loadEnv(base).SUPPORT_CHAT_ENABLED).toBe(false);
  });
  it("requires complete trusted HTTPS origin settings before enabling", () => {
    expect(() => loadEnv({ ...base, SUPPORT_CHAT_ENABLED: "true" })).toThrow();
    const configured = {
      ...base,
      SUPPORT_CHAT_ENABLED: "true",
      SUPPORT_CHATWOOT_ACCOUNT_ID: "13",
      SUPPORT_CHATWOOT_INBOX_ID: "17",
      SUPPORT_CHATWOOT_API_TOKEN: "test-only-token",
    };
    expect(() =>
      loadEnv({ ...configured, SUPPORT_CHATWOOT_BASE_URL: "http://example.invalid" }),
    ).toThrow();
    expect(() =>
      loadEnv({ ...configured, SUPPORT_CHATWOOT_BASE_URL: "https://example.invalid/path" }),
    ).toThrow();
    expect(
      loadEnv({ ...configured, SUPPORT_CHATWOOT_BASE_URL: "https://example.invalid" })
        .SUPPORT_CHAT_ENABLED,
    ).toBe(true);
  });
});
