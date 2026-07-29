import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { Test } from "@nestjs/testing";
import type { INestApplication } from "@nestjs/common";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { schema, type Db } from "@markiro/db";
import { eq } from "drizzle-orm";
import { AppModule } from "../src/app.module";
import { loadEnv } from "../src/env";
import { mountAuth, setupAuth, type AuthSetup } from "../src/auth/auth.setup";
import { listenOnLoopback } from "./support/listen-loopback";
import { signUpAndActivate } from "./support/auth";

describe("candidates", () => {
  let app: INestApplication | undefined;
  let agent: ReturnType<typeof request.agent>;
  let db: Db;
  let tenantId: string;
  let productId: string;
  let candidateId: string;
  let otherCandidateId: string;
  let hiddenId: string;

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
    tenantId = await signUpAndActivate(agent);

    // Товар без внешней связи ещё — ровно то, что суждение о подсказке
    // (`suggestedProductId`) готово предложить единственным совпадением по
    // нормализованному имени.
    productId = randomUUID();
    await db.insert(schema.products).values({
      id: productId,
      tenantId,
      gtin14: "04600682000037",
      name: "Жигулёвское 0,5",
      unitPrice: "50.00",
    });

    // Позиция очереди, которая однозначно совпадает по имени с productId —
    // единственный товар без external_ref, так что подсказка не двусмысленна.
    const [candidateRow] = await db
      .insert(schema.integrationCandidates)
      .values({
        tenantId,
        channelType: "commerceml",
        externalRef: "guid-new",
        name: "Жигулёвское 0,5",
        article: "SKU-1",
        unit: "шт",
      })
      .returning({ id: schema.integrationCandidates.id });
    candidateId = candidateRow!.id;

    // Вторая позиция, которую тест 3 попытается связать с ТЕМ ЖЕ productId
    // после того, как он уже занят кандидатом выше — ожидается 409.
    const [otherCandidateRow] = await db
      .insert(schema.integrationCandidates)
      .values({
        tenantId,
        channelType: "commerceml",
        externalRef: "guid-other",
        name: "Совсем другое имя",
      })
      .returning({ id: schema.integrationCandidates.id });
    otherCandidateId = otherCandidateRow!.id;

    // Третья позиция — для проверки hide/unhide, никогда не линкуется.
    const [hiddenRow] = await db
      .insert(schema.integrationCandidates)
      .values({
        tenantId,
        channelType: "commerceml",
        externalRef: "guid-hidden",
        name: "Скрытая позиция",
      })
      .returning({ id: schema.integrationCandidates.id });
    hiddenId = hiddenRow!.id;
  });

  afterAll(async () => {
    await app?.close();
  });

  it("подсказывает совпадение по наименованию — иначе первый обмен это сотни ручных сопоставлений", async () => {
    const res = await agent.get("/integrations/commerceml/candidates").expect(200);
    const candidate = res.body.candidates.find(
      (c: { name: string }) => c.name === "Жигулёвское 0,5",
    );
    expect(candidate.suggestedProductId).toBe(productId);
  });

  it("связывание проставляет external_ref и убирает позицию из очереди", async () => {
    await agent
      .post(`/integrations/commerceml/candidates/${candidateId}/link`)
      .send({ productId })
      .expect(200);

    const [product] = await db
      .select({ externalRef: schema.products.externalRef })
      .from(schema.products)
      .where(eq(schema.products.id, productId));
    expect(product!.externalRef).toBe("guid-new");

    const res = await agent.get("/integrations/commerceml/candidates").expect(200);
    expect(res.body.candidates.map((c: { id: string }) => c.id)).not.toContain(candidateId);
  });

  it("не даёт связать двух кандидатов с одним товаром", async () => {
    await agent
      .post(`/integrations/commerceml/candidates/${otherCandidateId}/link`)
      .send({ productId })
      .expect(409);
  });

  it("скрытое не всплывает в обычном списке, но доступно под фильтром", async () => {
    await agent.post(`/integrations/commerceml/candidates/${hiddenId}/hide`).expect(200);
    const plain = await agent.get("/integrations/commerceml/candidates").expect(200);
    expect(plain.body.candidates.map((c: { id: string }) => c.id)).not.toContain(hiddenId);
    const withHidden = await agent
      .get("/integrations/commerceml/candidates?hidden=true")
      .expect(200);
    expect(withHidden.body.candidates.map((c: { id: string }) => c.id)).toContain(hiddenId);
  });

  it("разрыв связи оставляет цену и пишет событие", async () => {
    await agent.delete(`/products/${productId}/external-link`).expect(200);
    const [product] = await db
      .select({ externalRef: schema.products.externalRef, unitPrice: schema.products.unitPrice })
      .from(schema.products)
      .where(eq(schema.products.id, productId));
    expect(product!.externalRef).toBeNull();
    expect(product!.unitPrice).not.toBeNull();

    const journal = await agent.get("/integrations/commerceml/journal").expect(200);
    const messages = journal.body.sessions.flatMap((s: { events: { message: string }[] }) =>
      s.events.map((e) => e.message),
    );
    expect(messages.join(" ")).toMatch(/связь/i);
  });
});
