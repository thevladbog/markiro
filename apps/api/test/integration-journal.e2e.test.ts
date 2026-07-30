import { randomUUID } from "node:crypto";
import express from "express";
import { Test } from "@nestjs/testing";
import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { schema, type Db } from "@markiro/db";
import { and, eq } from "drizzle-orm";
import { AppModule } from "../src/app.module";
import { mountAuth, setupAuth, type AuthSetup } from "../src/auth/auth.setup";
import { loadEnv } from "../src/env";
import {
  JournalService,
  SESSION_RETENTION_DAYS,
} from "../src/modules/integrations/journal.service";
import { listenOnLoopback } from "./support/listen-loopback";
import { signUpAndActivate } from "./support/auth";

const ready = Boolean(
  process.env.DATABASE_URL && process.env.BETTER_AUTH_SECRET && process.env.BETTER_AUTH_URL,
);

// `integration_channels`/`integration_sessions`/`integration_events` all
// carry a `tenant_id -> organization.id` FK (see
// packages/db/src/schema/integrations.ts), so the journal can't be exercised
// against a made-up tenant id -- the very first insert would fail the
// foreign key. A real organization, created the same way every other e2e
// spec in this directory does it (`signUpAndActivate`), is required instead.
describe.skipIf(!ready)("journal", () => {
  let app: INestApplication | undefined;
  let setup: AuthSetup;
  let db: Db;
  let journal: JournalService;
  let tenantId: string;

  beforeAll(async () => {
    const env = loadEnv();
    setup = setupAuth(env);
    db = setup.db;
    journal = new JournalService(db);

    const ref = await Test.createTestingModule({
      imports: [AppModule.forRoot({ ...setup, databaseUrl: env.DATABASE_URL })],
    }).compile();

    app = ref.createNestApplication({ bodyParser: false });
    const server = app.getHttpAdapter().getInstance();
    mountAuth(server, setup.auth);
    server.use(express.json());
    await app.init();
    await listenOnLoopback(app);

    const agent = request.agent(app.getHttpServer());
    tenantId = await signUpAndActivate(agent);
  });

  afterAll(async () => {
    await app?.close();
  });

  it("открывает сеанс, копит события и закрывает его исходом", async () => {
    const session = await journal.openSession(tenantId, "commerceml", {
      cookieHash: `h-${randomUUID()}`,
      expiresAt: new Date(Date.now() + 3_600_000),
    });

    await journal.append({
      tenantId,
      channelType: "commerceml",
      sessionId: session.id,
      direction: "in",
      outcome: "ok",
      grain: "session",
      message: "Каталог принят",
    });

    await journal.finishSession(tenantId, session.id, "ok", { updated: 12, candidates: 3 });

    const [row] = await db
      .select()
      .from(schema.integrationSessions)
      .where(eq(schema.integrationSessions.id, session.id));
    expect(row!.outcome).toBe("ok");
    expect(row!.finishedAt).not.toBeNull();
    expect(row!.summary).toEqual({ updated: 12, candidates: 3 });
  });

  it("двигает состояние канала при каждом событии — карточка знает, когда он дышал", async () => {
    await db
      .insert(schema.integrationChannels)
      .values({ tenantId, type: "commerceml" })
      .onConflictDoNothing();

    await journal.append({
      tenantId,
      channelType: "commerceml",
      sessionId: null,
      direction: "local",
      outcome: "error",
      grain: "session",
      message: "Связь товара разорвана",
    });

    const [channel] = await db
      .select()
      .from(schema.integrationChannels)
      .where(
        and(
          eq(schema.integrationChannels.tenantId, tenantId),
          eq(schema.integrationChannels.type, "commerceml"),
        ),
      );
    expect(channel!.lastOutcome).toBe("error");
    expect(channel!.lastEventAt).not.toBeNull();
  });

  // Fix 2 (final review): `append` used to write the channel's moved state
  // with a plain `UPDATE ... WHERE tenant_id = ? AND type = ?` -- a no-op
  // against zero rows when the channel has never had its `integration_
  // channels` row created. `updateChannel` (a non-empty settings patch) and
  // `issueCredentials` are the only two writers of that row, and
  // `public_api`'s settings schema is `{}`-only (an empty patch is treated as
  // "nothing to write", see `updateChannel`'s own comment) while
  // `issueCredentials` now 409s for it (Task 15) -- so a channel exactly like
  // `public_api` can go through a real event (a key issuance, in production)
  // without ever getting a settings row through either path. `GET
  // /integrations` would then keep reporting `not_configured` /
  // `lastEventAt: null` forever, contradicting the journal this very call
  // just wrote. `append` must create the row itself when it's missing.
  it("двигает состояние канала, даже если у него никогда не было строки настроек", async () => {
    await journal.append({
      tenantId,
      channelType: "public_api",
      sessionId: null,
      direction: "local",
      outcome: "ok",
      grain: "session",
      message: "Ключ публичного API выпущен",
    });

    const [channel] = await db
      .select()
      .from(schema.integrationChannels)
      .where(
        and(
          eq(schema.integrationChannels.tenantId, tenantId),
          eq(schema.integrationChannels.type, "public_api"),
        ),
      );
    expect(channel).toBeDefined();
    expect(channel!.lastOutcome).toBe("ok");
    expect(channel!.lastEventAt).not.toBeNull();
  });

  it("чистит построчную детализацию раньше сводок, а сводки — только после 90 дней", async () => {
    const old = new Date(Date.now() - 30 * 24 * 3_600_000);
    const wayOld = new Date(Date.now() - (SESSION_RETENTION_DAYS + 10) * 24 * 3_600_000);
    const itemMessage = `item-${randomUUID()}`;
    const freshSessionMessage = `fresh-session-${randomUUID()}`;
    const staleSessionMessage = `stale-session-${randomUUID()}`;

    await db.insert(schema.integrationEvents).values([
      {
        tenantId,
        channelType: "commerceml",
        at: old,
        direction: "in",
        outcome: "warn",
        grain: "item",
        message: itemMessage,
      },
      {
        tenantId,
        channelType: "commerceml",
        at: old,
        direction: "in",
        outcome: "ok",
        grain: "session",
        message: freshSessionMessage,
      },
      // Внутри 90-дневного окна пруниться не должна — это доказательство,
      // что вторая ветка `prune()` не чистит раньше срока.
      {
        tenantId,
        channelType: "commerceml",
        at: wayOld,
        direction: "in",
        outcome: "ok",
        grain: "session",
        message: staleSessionMessage,
      },
    ]);

    await journal.prune(new Date());

    const rows = await db
      .select({ message: schema.integrationEvents.message })
      .from(schema.integrationEvents)
      .where(eq(schema.integrationEvents.tenantId, tenantId));
    const messages = rows.map((r) => r.message);
    expect(messages).not.toContain(itemMessage);
    expect(messages).toContain(freshSessionMessage);
    // Без этой записи вторую ветку `delete` в `prune()` можно было бы
    // выкинуть целиком, и тест всё равно прошёл бы.
    expect(messages).not.toContain(staleSessionMessage);
  });

  it("чистит сеансы старше 90 дней, но не более свежие", async () => {
    const recent = await journal.openSession(tenantId, "commerceml", {
      cookieHash: `recent-${randomUUID()}`,
      expiresAt: new Date(Date.now() + 3_600_000),
    });

    const wayOld = new Date(Date.now() - (SESSION_RETENTION_DAYS + 10) * 24 * 3_600_000);
    const [stale] = await db
      .insert(schema.integrationSessions)
      .values({
        tenantId,
        channelType: "commerceml",
        startedAt: wayOld,
        cookieHash: `stale-${randomUUID()}`,
        expiresAt: new Date(Date.now() + 3_600_000),
      })
      .returning({ id: schema.integrationSessions.id });

    await journal.prune(new Date());

    const rows = await db
      .select({ id: schema.integrationSessions.id })
      .from(schema.integrationSessions)
      .where(eq(schema.integrationSessions.tenantId, tenantId));
    const ids = rows.map((r) => r.id);
    expect(ids).toContain(recent.id);
    expect(ids).not.toContain(stale!.id);
  });

  it("хранит сеанс и его сводку 90 дней от завершения, а не от начала", async () => {
    const startedLongAgo = new Date(Date.now() - (SESSION_RETENTION_DAYS + 5) * 24 * 3_600_000);
    const finishedRecently = new Date(Date.now() - 2 * 24 * 3_600_000);
    const summaryMessage = `settled-session-${randomUUID()}`;

    const [settled] = await db
      .insert(schema.integrationSessions)
      .values({
        tenantId,
        channelType: "commerceml",
        startedAt: startedLongAgo,
        finishedAt: finishedRecently,
        outcome: "ok",
        cookieHash: `settled-${randomUUID()}`,
        expiresAt: new Date(Date.now() + 3_600_000),
        summary: { updated: 7 },
      })
      .returning({ id: schema.integrationSessions.id });

    // Событие обмена пишется примерно тогда же, когда сеанс закрывается —
    // задолго после того, как он был открыт.
    await db.insert(schema.integrationEvents).values({
      tenantId,
      channelType: "commerceml",
      sessionId: settled!.id,
      at: finishedRecently,
      direction: "in",
      outcome: "ok",
      grain: "session",
      message: summaryMessage,
    });

    await journal.prune(new Date());

    const [sessionRow] = await db
      .select({ id: schema.integrationSessions.id })
      .from(schema.integrationSessions)
      .where(eq(schema.integrationSessions.id, settled!.id));
    expect(sessionRow).toBeDefined();

    const eventRows = await db
      .select({ sessionId: schema.integrationEvents.sessionId })
      .from(schema.integrationEvents)
      .where(eq(schema.integrationEvents.message, summaryMessage));
    expect(eventRows).toHaveLength(1);
    // Сводка не должна пережить сеанс: если бы строку сеанса чистили по
    // старому `startedAt`, эта проверка провалилась бы — `sessionId`
    // указывал бы в никуда.
    expect(eventRows[0]!.sessionId).toBe(settled!.id);
  });
});
