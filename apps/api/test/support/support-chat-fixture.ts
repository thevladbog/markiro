import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import express from "express";
import { createDb, schema, type Db } from "@markiro/db";
import { eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Test } from "@nestjs/testing";
import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { AppModule } from "../../src/app.module";
import { mountAuth, setupAuth } from "../../src/auth/auth.setup";
import { loadEnv } from "../../src/env";
import { mountPlatformAuth, setupPlatformAuth } from "../../src/platform-auth/platform-auth.setup";
import { CHATWOOT_CONFIG } from "../../src/modules/support-chat/chatwoot.client";
import { listenOnLoopback } from "./listen-loopback";
import { signUpAndActivate } from "./auth";

type Agent = ReturnType<typeof request.agent>;

export interface SupportChatFixture {
  app: INestApplication;
  db: Db;
  customerA: Agent;
  customerB: Agent;
  anonymous: Agent;
  platform: Agent;
  freshAgent(): Agent;
  platformCookie: string;
  tenantId: string;
  userA: string;
  userB: string;
  upstream: {
    requests: Array<{ method: string; path: string; body: unknown }>;
    messages: Array<Record<string, unknown>>;
    baseUrl: string;
    abortAfterSaveOnce(): void;
    inspectBeforeMessagePost(inspector: (body: Record<string, unknown>) => Promise<void>): void;
    addMessage(value: Record<string, unknown>): void;
    holdNextMessageList(): { seen: Promise<void>; release(): void };
    failMessageListAfter(pages: number): void;
    changeConversationContact(conversationId: number, contactId: number): void;
    setUnavailable(value: boolean): void;
  };
  cleanup(): Promise<void>;
}

export async function createSupportChatFixture(
  options: { enabled?: boolean; adminOrigin?: string; platformOrigin?: string } = {},
): Promise<SupportChatFixture> {
  const maintenanceUrl = process.env.SUPPORT_CHAT_TEST_MAINTENANCE_URL;
  if (process.env.SUPPORT_CHAT_ISOLATED_DB !== "1" || !maintenanceUrl)
    throw new Error("Support chat isolated test database is not configured");
  const maintenanceTarget = new URL(maintenanceUrl);
  if (!(
    ["postgres:", "postgresql:"].includes(maintenanceTarget.protocol) &&
    ["127.0.0.1", "localhost"].includes(maintenanceTarget.hostname) &&
    maintenanceTarget.pathname.length > 1
  ))
    throw new Error("Support chat test maintenance URL must target a local PostgreSQL database");
  const databaseName = `markiro_support_chat_${randomUUID().replaceAll("-", "_")}`;
  const scratchUrl = new URL(maintenanceUrl);
  scratchUrl.pathname = `/${databaseName}`;
  const maintenance = createDb(maintenanceUrl);
  await maintenance.pool.query(`CREATE DATABASE "${databaseName}"`);
  const migrator = createDb(scratchUrl.toString());
  let app: INestApplication | undefined;
  let upstream: Server | undefined;
  try {
    await migrate(migrator.db, {
      migrationsFolder: join(__dirname, "../../../../packages/db/migrations"),
    });
    await migrator.pool.end();
    const requests: Array<{ method: string; path: string; body: unknown }> = [];
    const contacts = new Map<
      string,
      {
        id: number;
        identifier: string;
        contact_inboxes: Array<{ inbox: { id: number }; source_id: string }>;
      }
    >();
    const conversations = new Map<
      number,
      { id: number; account_id: number; inbox_id: number; meta: { sender: { id: number } } }
    >();
    const messages: Array<Record<string, unknown>> = [];
    let messageListGate: { wait: Promise<void>; started: () => void } | null = null;
    let failMessageListCountdown: number | null = null;
    let abortNextMessagePost = false;
    let unavailable = false;
    let messagePostInspector: ((body: Record<string, unknown>) => Promise<void>) | null = null;
    let contactSequence = 40;
    let conversationSequence = 90;
    let messageSequence = 120;
    const upstreamApp = express();
    upstreamApp.use(express.json());
    upstreamApp.use((req, res, next) => {
      requests.push({ method: req.method, path: req.path, body: req.body });
      if (unavailable) {
        res.status(503).end();
        return;
      }
      next();
    });
    upstreamApp.get("/api/v1/accounts/13/contacts/search", (req, res) => {
      res.json({
        payload: [...contacts.values()].filter((contact) =>
          contact.identifier.includes(String(req.query.q ?? "")),
        ),
      });
    });
    upstreamApp.post("/api/v1/accounts/13/contacts", (req, res) => {
      const identifier = req.body?.identifier;
      if (typeof identifier !== "string" || req.body?.inbox_id !== 17) return res.status(400).end();
      if (contacts.has(identifier)) return res.status(409).end();
      const contact = {
        id: ++contactSequence,
        identifier,
        contact_inboxes: [{ inbox: { id: 17 }, source_id: `source-${contactSequence}` }],
      };
      contacts.set(identifier, contact);
      return res.json({ payload: { contact, contact_inbox: contact.contact_inboxes[0] } });
    });
    upstreamApp.post("/api/v1/accounts/13/conversations", (req, res) => {
      if (req.body?.inbox_id !== 17 || typeof req.body?.contact_id !== "number")
        return res.status(400).end();
      const conversation = {
        id: ++conversationSequence,
        account_id: 13,
        inbox_id: 17,
        meta: { sender: { id: req.body.contact_id } },
      };
      conversations.set(conversation.id, conversation);
      return res.json(conversation);
    });
    upstreamApp.get("/api/v1/accounts/13/conversations/:id", (req, res) => {
      const conversation = conversations.get(Number(req.params.id));
      return conversation ? res.json(conversation) : res.status(404).end();
    });
    upstreamApp.get("/api/v1/accounts/13/conversations/:id/messages", async (req, res) => {
      const id = Number(req.params.id);
      if (!conversations.has(id)) return res.status(404).end();
      if (messageListGate) {
        const gate = messageListGate;
        messageListGate = null;
        gate.started();
        await gate.wait;
      }
      if (failMessageListCountdown === 0) {
        failMessageListCountdown = null;
        return res.status(503).end();
      }
      if (failMessageListCountdown !== null) failMessageListCountdown--;
      const source = messages
        .filter((message) => message.conversation_id === id)
        .sort((a, b) => Number(b.id) - Number(a.id));
      const before = Number(req.query.before);
      const page =
        Number.isSafeInteger(before) && before > 0
          ? source.filter((message) => Number(message.id) < before).slice(0, 20)
          : source.slice(0, 20);
      return res.json({
        meta: { confidential: "must not reach browser" },
        payload: page,
      });
    });
    upstreamApp.post("/api/v1/accounts/13/conversations/:id/messages", async (req, res) => {
      const id = Number(req.params.id);
      if (!conversations.has(id)) return res.status(404).end();
      const inspector = messagePostInspector;
      messagePostInspector = null;
      if (inspector) await inspector(req.body);
      const message = {
        id: ++messageSequence,
        conversation_id: id,
        inbox_id: 17,
        content: req.body?.content,
        content_type: "text",
        message_type: 0,
        private: false,
        created_at: Math.floor(Date.now() / 1000),
        source_id: req.body?.source_id,
      };
      messages.push(message);
      if (abortNextMessagePost) {
        abortNextMessagePost = false;
        res.socket?.destroy();
        return;
      }
      return res.json(message);
    });
    upstream = createServer(upstreamApp);
    await new Promise<void>((resolve, reject) => {
      upstream!.once("error", reject);
      upstream!.listen(0, "127.0.0.1", resolve);
    });
    const address = upstream.address();
    if (!address || typeof address === "string") throw new Error("Expected local upstream port");
    const env = loadEnv({
      NODE_ENV: "test",
      DATABASE_URL: scratchUrl.toString(),
      BETTER_AUTH_SECRET: "support-chat-test-auth-secret",
      BETTER_AUTH_URL: "http://127.0.0.1:3000",
      PLATFORM_AUTH_SECRET: "support-chat-test-platform-auth-secret-000",
      PLATFORM_AUTH_URL: "http://127.0.0.1:3001",
      ADMIN_ORIGIN: options.adminOrigin ?? "http://localhost:5173",
      SAAS_ADMIN_ORIGIN: options.platformOrigin ?? "http://127.0.0.1:5473",
      PAIRING_CODE_PEPPER: "support-chat-test-pepper",
      ...(options.enabled === false
        ? {}
        : {
            SUPPORT_CHAT_ENABLED: "true",
            SUPPORT_CHATWOOT_BASE_URL: "https://chatwoot.example.invalid",
            SUPPORT_CHATWOOT_ACCOUNT_ID: "13",
            SUPPORT_CHATWOOT_INBOX_ID: "17",
            SUPPORT_CHATWOOT_API_TOKEN: "test-token-never-print",
          }),
    });
    const auth = setupAuth(env);
    const platformAuth = setupPlatformAuth(env, auth.db);
    const module = await Test.createTestingModule({
      imports: [
        AppModule.forRoot({
          ...auth,
          platformAuth: platformAuth.platformAuth,
          databaseUrl: env.DATABASE_URL,
          env,
        }),
      ],
    })
      .overrideProvider(CHATWOOT_CONFIG)
      .useValue({
        baseUrl: `http://127.0.0.1:${address.port}`,
        accountId: 13,
        inboxId: 17,
        apiToken: "test-token-never-print",
      })
      .compile();
    app = module.createNestApplication({ bodyParser: false });
    const httpApp = app.getHttpAdapter().getInstance();
    mountAuth(httpApp, auth.auth);
    mountPlatformAuth(httpApp, platformAuth.platformAuth, { allowTestSignUp: true });
    httpApp.use(express.json());
    await app.init();
    await listenOnLoopback(app);
    const boundServer = app.getHttpServer();
    const freshAgent = () => request.agent(boundServer);
    const customerA = freshAgent();
    const customerB = freshAgent();
    const anonymous = freshAgent();
    const platform = freshAgent();
    const tenantId = await signUpAndActivate(customerA);
    await customerB
      .post("/api/auth/sign-up/email")
      .send({
        email: `support-b-${randomUUID()}@example.com`,
        password: `Pw-${randomUUID()}!Aa1`,
        name: "Support B",
      })
      .expect(200);
    const db = auth.db;
    const [ownerMember] = await db
      .select()
      .from(schema.member)
      .where(eq(schema.member.organizationId, tenantId));
    const [bUser] = await db.select().from(schema.user).where(eq(schema.user.name, "Support B"));
    if (!ownerMember || !bUser) throw new Error("Expected users for support fixture");
    await db.insert(schema.member).values({
      id: randomUUID(),
      organizationId: tenantId,
      userId: bUser.id,
      role: "member",
      createdAt: new Date(),
    });
    await customerB
      .post("/api/auth/organization/set-active")
      .send({ organizationId: tenantId })
      .expect(200);
    const platformSignUp = await platform
      .post("/api/platform-auth/sign-up/email")
      .set("Origin", env.SAAS_ADMIN_ORIGIN)
      .send({
        email: `support-platform-${randomUUID()}@example.invalid`,
        password: `Pw-${randomUUID()}!Aa1`,
        name: "Platform only",
      })
      .expect(200);
    const platformSession = (platformSignUp.headers["set-cookie"] as string[] | undefined)?.find(
      (cookie) => cookie.startsWith("markiro-platform.session_token="),
    );
    if (!platformSession) throw new Error("Expected platform session cookie");
    return {
      app,
      db,
      customerA,
      customerB,
      anonymous,
      platform,
      freshAgent,
      platformCookie: platformSession.split(";", 1)[0]!,
      tenantId,
      userA: ownerMember.userId,
      userB: bUser.id,
      upstream: {
        setUnavailable: (value) => {
          unavailable = value;
        },
        requests,
        messages,
        baseUrl: `http://127.0.0.1:${address.port}`,
        abortAfterSaveOnce: () => {
          abortNextMessagePost = true;
        },
        inspectBeforeMessagePost: (inspector) => {
          messagePostInspector = inspector;
        },
        addMessage: (value: Record<string, unknown>) => {
          messages.push(value);
        },
        holdNextMessageList: () => {
          let release = () => {};
          let started = () => {};
          const wait = new Promise<void>((resolve) => {
            release = resolve;
          });
          const seen = new Promise<void>((resolve) => {
            started = resolve;
          });
          messageListGate = { wait, started };
          return { seen, release };
        },
        failMessageListAfter: (pages) => {
          failMessageListCountdown = pages;
        },
        changeConversationContact: (conversationId, contactId) => {
          const current = conversations.get(conversationId);
          if (!current) throw new Error("Expected conversation");
          current.meta.sender.id = contactId;
        },
      },
      cleanup: async () => {
        await app?.close();
        await new Promise<void>((resolve, reject) =>
          upstream?.close((error) => (error ? reject(error) : resolve())),
        );
        await maintenance.pool.query(`DROP DATABASE IF EXISTS "${databaseName}"`);
        await maintenance.pool.end();
      },
    };
  } catch (error) {
    await app?.close();
    if (upstream) await new Promise<void>((resolve) => upstream!.close(() => resolve()));
    await migrator.pool.end().catch(() => undefined);
    await maintenance.pool.query(`DROP DATABASE IF EXISTS "${databaseName}"`);
    await maintenance.pool.end();
    throw error;
  }
}
