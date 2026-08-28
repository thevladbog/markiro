import express from "express";
import request from "supertest";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AppModule } from "../src/app.module";
import { loadEnv } from "../src/env";
import { mountAuth, setupAuth, type AuthSetup } from "../src/auth/auth.setup";
import { listenOnLoopback } from "./support/listen-loopback";
import { signUpAndActivate } from "./support/auth";

const ready = Boolean(
  process.env.DATABASE_URL && process.env.BETTER_AUTH_SECRET && process.env.BETTER_AUTH_URL,
);

describe.skipIf(!ready)("signer agents pairing", () => {
  let app: INestApplication | undefined;
  let agent: request.Agent;

  beforeAll(async () => {
    const env = loadEnv();
    const setup: AuthSetup = setupAuth(env);
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

  it("issues an 8-digit pairing code", async () => {
    const res = await agent.post("/signer-agents/pairing-code").expect(201);
    expect(res.body.code).toMatch(/^\d{8}$/);
    expect(new Date(res.body.expiresAt).getTime()).toBeGreaterThan(Date.now());
  });

  it("rejects a wrong code and pairs with the right one exactly once", async () => {
    const { body: issued } = await agent.post("/signer-agents/pairing-code").expect(201);
    await request(app!.getHttpServer())
      .post("/signer-agent/pair")
      .send({ pairingCode: "00000000", hostname: "PC", appVersion: "0.1.0" })
      .expect(401);
    const pair = await request(app!.getHttpServer())
      .post("/signer-agent/pair")
      .send({ pairingCode: issued.code, hostname: "BUH-PC", appVersion: "0.1.0" })
      .expect(201);
    expect(pair.body.agentId).toBeTruthy();
    expect(pair.body.agentSecret.length).toBeGreaterThanOrEqual(32);
    expect(pair.body.tenantName).toBeTruthy();
    // one-time use
    await request(app!.getHttpServer())
      .post("/signer-agent/pair")
      .send({ pairingCode: issued.code, hostname: "BUH-PC", appVersion: "0.1.0" })
      .expect(401);
    // agent shows up in the overview with the empty token status
    const overview = await agent.get("/signer-agents").expect(200);
    expect(
      overview.body.agents.some(
        (a: { name: string; status: string }) => a.name === "BUH-PC" && a.status === "active",
      ),
    ).toBe(true);
    expect(overview.body.token.status).toBe("none");
  });

  it("revokes an agent", async () => {
    const { body: issued } = await agent.post("/signer-agents/pairing-code").expect(201);
    const pair = await request(app!.getHttpServer())
      .post("/signer-agent/pair")
      .send({ pairingCode: issued.code, hostname: "PC-2", appVersion: "0.1.0" })
      .expect(201);
    await agent.post(`/signer-agents/${pair.body.agentId}/revoke`).expect(204);
    const overview = await agent.get("/signer-agents").expect(200);
    const revoked = overview.body.agents.find(
      (a: { id: string; status: string }) => a.id === pair.body.agentId,
    );
    expect(revoked.status).toBe("revoked");
  });

  it("does not let one tenant revoke another tenant's agent", async () => {
    const { body: issued } = await agent.post("/signer-agents/pairing-code").expect(201);
    const pair = await request(app!.getHttpServer())
      .post("/signer-agent/pair")
      .send({ pairingCode: issued.code, hostname: "PC-3", appVersion: "0.1.0" })
      .expect(201);

    const otherAgent = request.agent(app!.getHttpServer());
    await signUpAndActivate(otherAgent);

    await otherAgent.post(`/signer-agents/${pair.body.agentId}/revoke`).expect(404);

    // The agent from tenant A must remain untouched by tenant B's denied attempt.
    const overview = await agent.get("/signer-agents").expect(200);
    const stillActive = overview.body.agents.find(
      (a: { id: string; status: string }) => a.id === pair.body.agentId,
    );
    expect(stillActive.status).toBe("active");
  });

  it("rejects a malformed agent id with 400 rather than a database error", async () => {
    await agent.post("/signer-agents/not-a-uuid/revoke").expect(400);
  });
});
