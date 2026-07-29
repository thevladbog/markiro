import express from "express";
import { Test } from "@nestjs/testing";
import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AppModule } from "../src/app.module";
import { mountAuth, setupAuth, type AuthSetup } from "../src/auth/auth.setup";
import { loadEnv } from "../src/env";
import { listenOnLoopback } from "./support/listen-loopback";
import { signUpAndActivate } from "./support/auth";

/**
 * Same env-gating as sscc.e2e.test.ts / org-profile.e2e.test.ts -- requires a
 * reachable Postgres with migrations applied plus Better Auth env.
 */
const ready = Boolean(
  process.env.DATABASE_URL && process.env.BETTER_AUTH_SECRET && process.env.BETTER_AUTH_URL,
);

// Two distinct, check-digit-valid GLNs with DIFFERENT 9-digit prefixes -- the
// point of the "keeps ... separate" test below is that the org's own counter
// and the counterparty's counter live in genuinely different number spaces,
// not merely under a different row for an incidental reason.
const ORG_GLN = "4601112222005";
const COUNTERPARTY_GLN = "4609876543008";

// Two distinct, check-digit-valid GLNs sharing the 9-digit prefix
// "460123400" -- the same fixture sscc.e2e.test.ts uses for the identical
// reason: a tenant-only isolation test that leaves every tenant's issuer
// prefix distinct would still pass even if the WHERE clause dropped its
// tenantId filter entirely, since a DIFFERENT prefix alone would already
// keep the rows apart. Two different tenants sharing this ONE prefix is
// what actually exercises the tenantId filter.
const SHARED_PREFIX_GLN_A = "4601234000017";
const SHARED_PREFIX_GLN_B = "4601234000024";

// Routes carry no global prefix (see vite.config.ts's proxy comment and
// org-profile.e2e.test.ts / counterparties.e2e.test.ts): the controllers are
// `@Controller("org/profile")` and `@Controller("counterparties")`, so the
// routes below are `/org/profile/sscc` and `/counterparties/:id/sscc`, not
// the plan doc's `/api/org-profile/sscc` (that literal path does not exist
// anywhere else in this codebase's routing and would require a prefix/naming
// convention this app doesn't use).
describe.skipIf(!ready)("sscc counter settings e2e", () => {
  let app: INestApplication | undefined;
  let setup: AuthSetup;

  let agent: ReturnType<typeof request.agent>;
  let counterpartyId: string;
  let stationKey: string;

  beforeAll(async () => {
    const env = loadEnv();
    setup = setupAuth(env);

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

    await agent.put("/org/profile").send({ gln: ORG_GLN }).expect(200);

    const counterparty = await agent
      .post("/counterparties")
      .send({ name: "Client Co", gln: COUNTERPARTY_GLN })
      .expect(201);
    counterpartyId = (counterparty.body as { id: string }).id;

    const device = await agent
      .post("/station-devices")
      .send({ name: "Line 1 terminal" })
      .expect(201);
    stationKey = (device.body as { apiKey: string }).apiKey;
  });

  afterAll(async () => {
    await app?.close();
  });

  it("seeds the tenant's own box counter and reads it back", async () => {
    await agent
      .put("/org/profile/sscc")
      .send({ extensionDigit: 0, nextSerial: 45_000 })
      .expect(200);
    const res = await agent.get("/org/profile/sscc").expect(200);
    expect(res.body).toEqual({ extensionDigit: 0, nextSerial: 45_000 });
  });

  it("rejects an extension digit outside 0..9", async () => {
    await agent.put("/org/profile/sscc").send({ extensionDigit: 10, nextSerial: 0 }).expect(400);
  });

  it("rejects a starting serial beyond the space a 9-digit prefix allows", async () => {
    await agent
      .put("/org/profile/sscc")
      .send({ extensionDigit: 0, nextSerial: 10_000_000 })
      .expect(400);
  });

  it("rejects an extension digit outside 0..9 for a counterparty's counter", async () => {
    await agent
      .put(`/counterparties/${counterpartyId}/sscc`)
      .send({ extensionDigit: 10, nextSerial: 0 })
      .expect(400);
  });

  it("rejects a starting serial beyond the space a 9-digit prefix allows for a counterparty's counter", async () => {
    await agent
      .put(`/counterparties/${counterpartyId}/sscc`)
      .send({ extensionDigit: 0, nextSerial: 10_000_000 })
      .expect(400);
  });

  it("rejects a station api-key: org profile's counter is cabinet-only", async () => {
    await request(app!.getHttpServer())
      .get("/org/profile/sscc")
      .set("x-api-key", stationKey)
      .expect(403);
  });

  it("rejects a station api-key: a counterparty's counter is cabinet-only", async () => {
    await request(app!.getHttpServer())
      .get(`/counterparties/${counterpartyId}/sscc`)
      .set("x-api-key", stationKey)
      .expect(403);
  });

  it("keeps a counterparty's counter separate from the tenant's own", async () => {
    await agent.put("/org/profile/sscc").send({ extensionDigit: 0, nextSerial: 100 }).expect(200);
    await agent
      .put(`/counterparties/${counterpartyId}/sscc`)
      .send({ extensionDigit: 0, nextSerial: 900 })
      .expect(200);
    const own = await agent.get("/org/profile/sscc").expect(200);
    expect(own.body.nextSerial).toBe(100);
  });

  it("reads back a counterparty's own seeded counter", async () => {
    await agent
      .put(`/counterparties/${counterpartyId}/sscc`)
      .send({ extensionDigit: 0, nextSerial: 12_345 })
      .expect(200);
    const res = await agent.get(`/counterparties/${counterpartyId}/sscc`).expect(200);
    expect(res.body).toEqual({ extensionDigit: 0, nextSerial: 12_345 });
  });

  it("404s a counterparty counter id that does not exist", async () => {
    await agent.get("/counterparties/00000000-0000-4000-8000-000000000000/sscc").expect(404);
  });

  it("tenant isolation: a second organization cannot read or seed org A's own counter", async () => {
    await agent.put("/org/profile/sscc").send({ extensionDigit: 0, nextSerial: 555 }).expect(200);

    const agent2 = request.agent(app!.getHttpServer());
    await signUpAndActivate(agent2);
    await agent2.put("/org/profile").send({ gln: "4607777777003" }).expect(200);

    // Org B's own counter starts fresh at 0 -- NOT org A's 555. A missing
    // tenant filter in getSscc's WHERE clause would leak org A's row here.
    const res = await agent2.get("/org/profile/sscc").expect(200);
    expect(res.body).toEqual({ extensionDigit: 0, nextSerial: 0 });

    const stillOwn = await agent.get("/org/profile/sscc").expect(200);
    expect(stillOwn.body.nextSerial).toBe(555);
  });

  it("tenant isolation: a second organization cannot read or seed org A's counterparty counter", async () => {
    const agent2 = request.agent(app!.getHttpServer());
    await signUpAndActivate(agent2);

    // Org A's counterparty id does not belong to org B -- a missing tenant
    // filter in getCounterparty/getSscc would 200 here instead of 404ing.
    await agent2.get(`/counterparties/${counterpartyId}/sscc`).expect(404);
    await agent2
      .put(`/counterparties/${counterpartyId}/sscc`)
      .send({ extensionDigit: 0, nextSerial: 1 })
      .expect(404);
  });

  it("tenant isolation: two tenants whose own GLN shares a prefix still keep separate counters", async () => {
    const agentA = request.agent(app!.getHttpServer());
    await signUpAndActivate(agentA);
    await agentA.put("/org/profile").send({ gln: SHARED_PREFIX_GLN_A }).expect(200);
    await agentA.put("/org/profile/sscc").send({ extensionDigit: 0, nextSerial: 700 }).expect(200);

    const agentB = request.agent(app!.getHttpServer());
    await signUpAndActivate(agentB);
    await agentB.put("/org/profile").send({ gln: SHARED_PREFIX_GLN_B }).expect(200);

    // Org B shares org A's 9-digit prefix but is a DIFFERENT tenant -- it
    // must start fresh at 0, not inherit A's 700. A WHERE clause missing the
    // tenantId filter (matching on issuerPrefix + extensionDigit alone)
    // would return SOME row here instead of none.
    const resB = await agentB.get("/org/profile/sscc").expect(200);
    expect(resB.body).toEqual({ extensionDigit: 0, nextSerial: 0 });

    const resA = await agentA.get("/org/profile/sscc").expect(200);
    expect(resA.body.nextSerial).toBe(700);
  });

  it("tenant isolation: counterparties of two different tenants sharing a prefix keep separate counters", async () => {
    const agentA = request.agent(app!.getHttpServer());
    await signUpAndActivate(agentA);
    const cpA = await agentA
      .post("/counterparties")
      .send({ name: "Shared-prefix CP A", gln: SHARED_PREFIX_GLN_A })
      .expect(201);
    const cpAId = (cpA.body as { id: string }).id;
    await agentA
      .put(`/counterparties/${cpAId}/sscc`)
      .send({ extensionDigit: 0, nextSerial: 321 })
      .expect(200);

    const agentB = request.agent(app!.getHttpServer());
    await signUpAndActivate(agentB);
    const cpB = await agentB
      .post("/counterparties")
      .send({ name: "Shared-prefix CP B", gln: SHARED_PREFIX_GLN_B })
      .expect(201);
    const cpBId = (cpB.body as { id: string }).id;

    // Same prefix as counterparty A, different tenant -- must read as fresh.
    const resB = await agentB.get(`/counterparties/${cpBId}/sscc`).expect(200);
    expect(resB.body).toEqual({ extensionDigit: 0, nextSerial: 0 });
  });
});
