import * as http from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import request from "supertest";
import { Test } from "@nestjs/testing";
import type { INestApplication } from "@nestjs/common";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { schema, type Db } from "@markiro/db";
import { and, eq, inArray } from "drizzle-orm";
import { AppModule } from "../src/app.module";
import { loadEnv } from "../src/env";
import { mountAuth, setupAuth, type AuthSetup } from "../src/auth/auth.setup";
import { listenOnLoopback } from "./support/listen-loopback";
import { signUpAndActivate } from "./support/auth";
import { excludeExchangeRoute } from "../src/modules/exchange/exchange.module";
import { checkauthWindowStart } from "../src/modules/exchange/exchange-credentials";
import {
  ExchangeSessionService,
  FILE_CHUNK_LIMIT,
} from "../src/modules/exchange/exchange-session.service";
import { hashDeviceToken } from "../src/pickup/device-token";

describe("1c_exchange", () => {
  let app: INestApplication | undefined;
  let agent: ReturnType<typeof request.agent>;
  let db: Db;
  let login: string;
  let secret: string;
  // Review fix (task-6): captured once, here, at suite collection time --
  // not re-derived with `new Date()` down in `afterAll` -- so the cleanup
  // below deletes exactly the checkauth window this suite's own attempts
  // landed in, not whatever window happens to be current when the file
  // finishes running.
  const checkauthWindow = checkauthWindowStart(new Date());

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
    // Mirrors main.ts exactly: `/1c_exchange` must be excluded from the
    // global JSON parser here too, or this suite would never have caught
    // the bug `excludeExchangeRoute` fixes (see the regression test below).
    server.use(excludeExchangeRoute(express.json()));
    await app.init();
    await listenOnLoopback(app);
    agent = request.agent(app.getHttpServer());
    await signUpAndActivate(agent);
  });

  afterAll(async () => {
    // Fix 4: every failed/unrefunded `mode=checkauth` call in this file (plus
    // exchange-credentials.e2e.test.ts's own real-loopback regression, run in
    // the same `vitest run exchange-protocol exchange-credentials` invocation
    // -- `fileParallelism: false` in vitest.config.ts means the two share one
    // real-time 15-minute window) charges the SAME production rate limiter
    // `assertUnderCheckauthLimit` enforces, keyed on the caller's actual
    // address -- not a disposable per-test fixture the way `freshSource()` is
    // in exchange-credentials.e2e.test.ts's unit tests. Three loopback forms
    // because `checkauth`'s `source` (exchange.controller.ts) is used
    // UNNORMALIZED, unlike kiosk pairing's `normalizePairSource` -- Node can
    // report any of them for a loopback peer depending on the IPv4/IPv6 stack
    // (same set `kiosk-pairing.e2e.test.ts` guards against for its own
    // table). Without this, two or three runs inside one window exhaust
    // `CHECKAUTH_BUDGET` and every later run starts failing with "too many
    // attempts" until someone manually truncates `exchange_attempts`.
    //
    // Review fix (task-6): scoped to `checkauthWindow` (captured once, at
    // suite start, above) -- deleting by source alone, across EVERY window,
    // used to erase any other process's rate-limit history on the same
    // loopback addresses too. This runs against a real, locally-shared
    // Postgres, not a disposable per-test database: a dev server started by
    // hand, a differently-grouped CI invocation, or another concurrent
    // `vitest run` all point at the same table and the same three loopback
    // source strings. Narrowing to this suite's own window means the delete
    // can only ever remove rows this run itself could have written.
    await db
      .delete(schema.exchangeAttempts)
      .where(
        and(
          inArray(schema.exchangeAttempts.source, ["127.0.0.1", "::1", "::ffff:127.0.0.1"]),
          eq(schema.exchangeAttempts.windowStartedAt, checkauthWindow),
        ),
      );
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

  // Review fixes (task-6 follow-up): the four below each pin one finding.

  it("необработанное исключение в обработчике всё равно отвечает text/plain 200 (Fix 1)", async () => {
    const auth = await checkauth();
    const sessions = app!.get(ExchangeSessionService);
    const spy = vi
      .spyOn(sessions, "appendChunk")
      .mockRejectedValueOnce(new Error("boom: simulated db outage"));
    try {
      const res = await request(app!.getHttpServer())
        .post("/1c_exchange?type=catalog&mode=file&filename=boom.xml")
        .set("Cookie", auth.cookie)
        .send(Buffer.from("x", "utf8"))
        .expect(200);
      expect(res.headers["content-type"]).toMatch(/^text\/plain/);
      expect(res.text.startsWith("failure")).toBe(true);

      // The response shape alone doesn't pin what this filter exists for:
      // that the failure actually reached the journal, the same way the
      // "неизвестный режим"/"превышенный кусок" regressions above check
      // `lastOutcome` rather than stopping at the wire response.
      // `ExchangeExceptionFilter.catch()` journals against `req.exchangeContext`,
      // set right after `resolveSession` succeeds -- before the mocked
      // `appendChunk` throws -- so the known tenant here is `login`'s own.
      const [channel] = await db
        .select()
        .from(schema.integrationChannels)
        .where(eq(schema.integrationChannels.credentialLogin, login));
      expect(channel!.lastOutcome).toBe("error");
    } finally {
      spy.mockRestore();
    }
  });

  it("mode=file с чужим Content-Type (application/json) и невалидным телом остаётся text/plain 200, а не JSON-ошибкой парсера (Fix 3)", async () => {
    const res = await request(app!.getHttpServer())
      .post("/1c_exchange?type=catalog&mode=file&filename=mismatched.xml")
      .set("Content-Type", "application/json")
      .send("not json")
      .expect(200);
    expect(res.text.startsWith("failure")).toBe(true);
  });

  it("превышенный кусок БЕЗ Content-Length (chunked) тоже отвечает failure, а не 413-ом (Fix 4)", async () => {
    const address = app!.getHttpServer().address() as AddressInfo;
    const oversized = Buffer.alloc(FILE_CHUNK_LIMIT + 1, "a");

    // Raw `http.request`, not supertest: this needs precise control over the
    // wire (an explicit `Transfer-Encoding: chunked` with NO `Content-Length`
    // header at all) to reproduce exactly the gap `ExchangeRawBodyMiddleware`
    // closes -- the one case `ExchangeChunkLimitMiddleware`'s own
    // `Content-Length` check cannot see coming.
    const { status, body } = await new Promise<{ status: number; body: string }>(
      (resolve, reject) => {
        const req = http.request(
          {
            host: "127.0.0.1",
            port: address.port,
            path: "/1c_exchange?type=catalog&mode=file&filename=huge-chunked.xml",
            method: "POST",
            headers: {
              "Transfer-Encoding": "chunked",
              "Content-Type": "application/octet-stream",
            },
          },
          (res) => {
            let data = "";
            res.on("data", (chunk: Buffer) => (data += chunk.toString("utf8")));
            res.on("end", () => resolve({ status: res.statusCode!, body: data }));
          },
        );
        req.on("error", reject);
        req.end(oversized);
      },
    );

    expect(status).toBe(200);
    expect(body.startsWith("failure")).toBe(true);
  });

  it("checkauth выполняет полную проверку пароля даже для несуществующего логина (защита от тайминг-атаки, Fix 5)", async () => {
    const spy = vi.spyOn(crypto.subtle, "deriveBits");
    try {
      const res = await request(app!.getHttpServer())
        .get("/1c_exchange?type=catalog&mode=checkauth")
        .auth("no-such-exchange-login-at-all", "whatever")
        .expect(200);
      expect(res.text.startsWith("failure")).toBe(true);
      // A short-circuited `!row || ...` would return before ever deriving
      // anything for an unknown login -- exactly the timing side channel
      // `DUMMY_EXCHANGE_PHC` (exchange-credentials.ts) guards against.
      expect(spy).toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });
});
