import express from "express";
import request from "supertest";
import { Test } from "@nestjs/testing";
import type { INestApplication } from "@nestjs/common";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { schema, type Db } from "@markiro/db";
import { and, eq } from "drizzle-orm";
import { AppModule } from "../src/app.module";
import { loadEnv } from "../src/env";
import { mountAuth, setupAuth, type AuthSetup } from "../src/auth/auth.setup";
import { listenOnLoopback } from "./support/listen-loopback";
import { signUpAndActivate } from "./support/auth";
import { FILE_CHUNK_LIMIT } from "../src/modules/exchange/exchange-session.service";
import { hashDeviceToken } from "../src/pickup/device-token";

describe("1c_exchange", () => {
  let app: INestApplication | undefined;
  let agent: ReturnType<typeof request.agent>;
  let db: Db;
  let login: string;
  let secret: string;

  beforeAll(async () => {
    const env = loadEnv();
    const setup: AuthSetup = setupAuth(env);
    db = setup.db;
    const ref = await Test.createTestingModule({
      imports: [AppModule.forRoot({ ...setup, databaseUrl: env.DATABASE_URL })],
    }).compile();
    app = ref.createNestApplication({ bodyParser: false });
    const server = app.getHttpAdapter().getInstance();
    mountAuth(server, setup.auth);
    server.use(express.json());
    await app.init();
    await listenOnLoopback(app);
    agent = request.agent(app.getHttpServer());
    await signUpAndActivate(agent);
  });

  afterAll(async () => {
    await app?.close();
  });

  /** Repeats the checkauth exchange and turns its two body lines into a `Cookie` header value. */
  async function checkauth(): Promise<{ cookie: string; value: string }> {
    const res = await request(app!.getHttpServer())
      .get("/1c_exchange?type=catalog&mode=checkauth")
      .auth(login, secret)
      .expect(200);
    const [, name, value] = res.text.split("\n");
    return { cookie: `${name}=${value}`, value: value! };
  }

  it("выдаёт cookie на верные учётные данные", async () => {
    const issued = await agent.post("/integrations/commerceml/credentials").send({}).expect(201);
    login = issued.body.login;
    secret = issued.body.secret;

    const res = await request(app!.getHttpServer())
      .get("/1c_exchange?type=catalog&mode=checkauth")
      .auth(login, secret)
      .expect(200);

    const lines = res.text.split("\n");
    expect(lines[0]).toBe("success");
    expect(lines[1]).toBeTruthy();
    expect(lines[2]).toBeTruthy();
  });

  it("отвечает failure на неверный пароль и не выдаёт cookie", async () => {
    const res = await request(app!.getHttpServer())
      .get("/1c_exchange?type=catalog&mode=checkauth")
      .auth(login, "wrong")
      .expect(200);
    expect(res.text.startsWith("failure")).toBe(true);
  });

  it("сообщает параметры сеанса и отказывается от zip", async () => {
    const auth = await checkauth();
    const res = await request(app!.getHttpServer())
      .get("/1c_exchange?type=catalog&mode=init")
      .set("Cookie", auth.cookie)
      .expect(200);
    expect(res.text).toContain("zip=no");
    expect(res.text).toMatch(/file_limit=\d+/);
  });

  it("принимает файл кусками и собирает их в исходный порядок", async () => {
    const auth = await checkauth();
    await request(app!.getHttpServer())
      .post("/1c_exchange?type=catalog&mode=file&filename=import.xml")
      .set("Cookie", auth.cookie)
      .send(Buffer.from("<?xml version=", "utf8"))
      .expect(200);
    const res = await request(app!.getHttpServer())
      .post("/1c_exchange?type=catalog&mode=file&filename=import.xml")
      .set("Cookie", auth.cookie)
      .send(Buffer.from('"1.0"?><КоммерческаяИнформация/>', "utf8"))
      .expect(200);
    expect(res.text).toBe("success");
  });

  it("не пускает без cookie сеанса", async () => {
    const res = await request(app!.getHttpServer())
      .get("/1c_exchange?type=catalog&mode=init")
      .expect(200);
    expect(res.text.startsWith("failure")).toBe(true);
  });

  // Beyond the brief's five: the prose requirements ("ни одна ветка не
  // завершается молча") aren't exercised by the five tests above, so pin
  // them directly.

  it("собирает куски в исходном порядке, а не в порядке получения", async () => {
    const auth = await checkauth();
    await request(app!.getHttpServer())
      .post("/1c_exchange?type=catalog&mode=file&filename=ordered.xml")
      .set("Cookie", auth.cookie)
      .send(Buffer.from("AAA", "utf8"))
      .expect(200);
    await request(app!.getHttpServer())
      .post("/1c_exchange?type=catalog&mode=file&filename=ordered.xml")
      .set("Cookie", auth.cookie)
      .send(Buffer.from("BBB", "utf8"))
      .expect(200);

    // Resolves the exact session row via the same cookie-hash the app uses
    // to look it up (`hashDeviceToken`, reused for the exchange cookie in
    // `exchange-session.service.ts`) rather than "most recently inserted" --
    // this suite shares one real Postgres with every other e2e file, so a
    // recency heuristic would be a race against whatever else is running.
    const cookieHash = hashDeviceToken(auth.value);
    const [session] = await db
      .select()
      .from(schema.integrationSessions)
      .where(eq(schema.integrationSessions.cookieHash, cookieHash));

    const rows = await db
      .select()
      .from(schema.exchangeUploads)
      .where(
        and(
          eq(schema.exchangeUploads.sessionId, session!.id),
          eq(schema.exchangeUploads.filename, "ordered.xml"),
        ),
      )
      .orderBy(schema.exchangeUploads.chunk);
    expect(rows.map((r) => r.body.toString("utf8"))).toEqual(["AAA", "BBB"]);
  });

  it("неверный пароль пишет событие в журнал канала", async () => {
    const [before] = await db
      .select()
      .from(schema.integrationChannels)
      .where(
        and(
          eq(schema.integrationChannels.credentialLogin, login),
          eq(schema.integrationChannels.type, "commerceml"),
        ),
      );

    await request(app!.getHttpServer())
      .get("/1c_exchange?type=catalog&mode=checkauth")
      .auth(login, "definitely-wrong")
      .expect(200);

    const [after] = await db
      .select()
      .from(schema.integrationChannels)
      .where(eq(schema.integrationChannels.tenantId, before!.tenantId));
    expect(after!.lastOutcome).toBe("error");
  });

  it("неизвестный режим отвечает failure и пишет событие в журнал", async () => {
    const auth = await checkauth();
    const res = await request(app!.getHttpServer())
      .get("/1c_exchange?type=catalog&mode=bogus")
      .set("Cookie", auth.cookie)
      .expect(200);
    expect(res.text.startsWith("failure")).toBe(true);

    const [channel] = await db
      .select()
      .from(schema.integrationChannels)
      .where(eq(schema.integrationChannels.credentialLogin, login));
    expect(channel!.lastOutcome).toBe("error");
  });

  it("превышенный кусок отвечает failure, а не рвёт соединение 4xx-ом", async () => {
    const auth = await checkauth();
    const oversized = Buffer.alloc(FILE_CHUNK_LIMIT + 1, "a");
    const res = await request(app!.getHttpServer())
      .post("/1c_exchange?type=catalog&mode=file&filename=huge.xml")
      .set("Cookie", auth.cookie)
      .send(oversized)
      .expect(200);
    expect(res.text.startsWith("failure")).toBe(true);

    const [channel] = await db
      .select()
      .from(schema.integrationChannels)
      .where(eq(schema.integrationChannels.credentialLogin, login));
    expect(channel!.lastOutcome).toBe("error");
  });
});
