import express from "express";
import { Test } from "@nestjs/testing";
import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildSscc, gs1CheckDigit } from "@markiro/domain";
import { schema, type Db } from "@markiro/db";
import { and, eq } from "drizzle-orm";
import { AppModule } from "../src/app.module";
import { mountAuth, setupAuth, type AuthSetup } from "../src/auth/auth.setup";
import { loadEnv } from "../src/env";
import { atomicSeedSscc, seedFloor, SsccService } from "../src/modules/sscc/sscc.service";
import { listenOnLoopback } from "./support/listen-loopback";
import { createTestStationDevice, signUpAndActivate } from "./support/auth";

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
  let db: Db;

  let agent: ReturnType<typeof request.agent>;
  let tenantId: string;
  let counterpartyId: string;
  let stationKey: string;
  let deviceId: string;

  beforeAll(async () => {
    const env = loadEnv();
    setup = setupAuth(env);
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

    await agent.put("/org/profile").send({ gln: ORG_GLN }).expect(200);

    const counterparty = await agent
      .post("/counterparties")
      .send({ name: "Client Co", gln: COUNTERPARTY_GLN })
      .expect(201);
    counterpartyId = (counterparty.body as { id: string }).id;

    const device = await createTestStationDevice(app!, agent, "Line 1 terminal");
    stationKey = device.apiKey;
    deviceId = device.deviceId;
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

  it("rejects serial zero for the tenant's own box counter", async () => {
    await agent.put("/org/profile/sscc").send({ extensionDigit: 0, nextSerial: 0 }).expect(400);
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

  it("rejects serial zero for a counterparty's box counter", async () => {
    await agent
      .put(`/counterparties/${counterpartyId}/sscc`)
      .send({ extensionDigit: 0, nextSerial: 0 })
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

    // Org B's own counter starts fresh at 1 -- NOT org A's 555. A missing
    // tenant filter in getSscc's WHERE clause would leak org A's row here.
    const res = await agent2.get("/org/profile/sscc").expect(200);
    expect(res.body).toEqual({ extensionDigit: 0, nextSerial: 1 });

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
    // must start fresh at 1, not inherit A's 700. A WHERE clause missing the
    // tenantId filter (matching on issuerPrefix + extensionDigit alone)
    // would return SOME row here instead of none.
    const resB = await agentB.get("/org/profile/sscc").expect(200);
    expect(resB.body).toEqual({ extensionDigit: 0, nextSerial: 1 });

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
    expect(resB.body).toEqual({ extensionDigit: 0, nextSerial: 1 });
  });

  describe("putSscc floor (final review, finding 2)", () => {
    // A fresh, check-digit-valid 13-digit GLN per call, isolated from every
    // fixture prefix used above -- these tests cut a REAL sscc_blocks row
    // (via SsccService.allocate) under whatever prefix they use, and must
    // never collide with a prefix another test in this file already seeded.
    // The counter is placed in the body's FIRST 7 digits (after "46"), so it
    // lands inside the 9-digit PREFIX itself (`gln.slice(0, 9)`) -- padding
    // it into the trailing serial-shaped digits instead would leave every
    // call sharing the same 9-digit prefix, since only those first 9 digits
    // are ever read.
    let counter = 0;
    function freshGln(): string {
      counter += 1;
      const body = `46${String(counter).padStart(7, "0")}000`;
      return body + String(gs1CheckDigit(body));
    }

    it("seeds freely when no block has ever been issued under the prefix", async () => {
      await agent.put("/org/profile").send({ gln: freshGln() }).expect(200);
      await agent.put("/org/profile/sscc").send({ extensionDigit: 0, nextSerial: 777 }).expect(200);
      const res = await agent.get("/org/profile/sscc").expect(200);
      expect(res.body).toEqual({ extensionDigit: 0, nextSerial: 777 });
    });

    it("rejects seeding below the floor once a serial has been printed, but allows seeding at or above it", async () => {
      const gln = freshGln();
      await agent.put("/org/profile").send({ gln }).expect(200);
      const prefix = gln.slice(0, 9);

      // Cuts a real sscc_blocks row under this prefix, the same one-statement
      // path a shift bundle uses -- no HTTP route exposes raw allocation, so
      // SsccService is called directly, same as sscc.e2e.test.ts does. The
      // floor comes from the PRINTED serial recorded below, not from the
      // block's bounds (2026-08-20 reseed design).
      const service = app!.get(SsccService);
      const block = await service.allocate(tenantId, prefix, 0, deviceId, 50);
      await service.recordConsumedSerial(tenantId, buildSscc(0, prefix, block.fromSerial + 9));
      const floor = block.fromSerial + 10;

      await agent
        .put("/org/profile/sscc")
        .send({ extensionDigit: 0, nextSerial: floor - 1 })
        .expect(400);

      await agent
        .put("/org/profile/sscc")
        .send({ extensionDigit: 0, nextSerial: floor })
        .expect(200);
      expect((await agent.get("/org/profile/sscc").expect(200)).body.nextSerial).toBe(floor);
    });

    it("rejects seeding below the floor for a counterparty's counter once a block has been issued", async () => {
      const gln = freshGln();
      const counterparty = await agent
        .post("/counterparties")
        .send({ name: "Floor test counterparty", gln })
        .expect(201);
      const cpId = (counterparty.body as { id: string }).id;
      const prefix = gln.slice(0, 9);

      const block = await app!.get(SsccService).allocate(tenantId, prefix, 0, deviceId, 50);
      const floor = block.toSerial + 1;

      const rejected = await agent
        .put(`/counterparties/${cpId}/sscc`)
        .send({ extensionDigit: 0, nextSerial: floor - 1 })
        .expect(400);
      expect((rejected.body as { message: string }).message).toContain(String(floor));

      await agent
        .put(`/counterparties/${cpId}/sscc`)
        .send({ extensionDigit: 0, nextSerial: floor })
        .expect(200);
      expect((await agent.get(`/counterparties/${cpId}/sscc`).expect(200)).body.nextSerial).toBe(
        floor,
      );
    });

    it("floors on what was printed, not on what was handed out", async () => {
      const gln = freshGln();
      await agent.put("/org/profile").send({ gln }).expect(200);
      const prefix = gln.slice(0, 9);
      const service = app!.get(SsccService);

      // A block of 50 serials is handed to the device, but only serial 10 is
      // ever reported as actually printed. The old floor (toSerial + 1 = 51)
      // made every unprinted serial in the block permanently unusable; the
      // floor is now one past what was really printed.
      await service.allocate(tenantId, prefix, 0, deviceId, 50);
      await service.recordConsumedSerial(tenantId, buildSscc(0, prefix, 10));

      await agent.put("/org/profile/sscc").send({ extensionDigit: 0, nextSerial: 10 }).expect(400);
      await agent.put("/org/profile/sscc").send({ extensionDigit: 0, nextSerial: 11 }).expect(200);
      expect((await agent.get("/org/profile/sscc").expect(200)).body.nextSerial).toBe(11);
    });

    it("floors at the box minimum when nothing was ever printed", async () => {
      const gln = freshGln();
      await agent.put("/org/profile").send({ gln }).expect(200);
      const prefix = gln.slice(0, 9);
      await app!.get(SsccService).allocate(tenantId, prefix, 0, deviceId, 50);

      // Handed out but never printed -- serial 1 is still free.
      expect(await seedFloor(db, tenantId, prefix, 0)).toBe(1);
      await agent.put("/org/profile/sscc").send({ extensionDigit: 0, nextSerial: 1 }).expect(200);
    });
  });

  // CodeRabbit PR33 review, Finding 5: `putSscc` used to read `seedFloor`
  // and then write `nextSerial` in two SEPARATE statements. If a device's
  // `allocate()` landed in between -- advancing the counter and recording a
  // new block -- the write would still land unconditionally, silently
  // overwriting the counter with a value now behind that block. This
  // exercises `atomicSeedSscc` (the fix) directly: the interleaving is
  // forced explicitly (read a floor, THEN let a concurrent allocation
  // advance the counter, THEN attempt to write the now-stale value), which
  // is the deterministic way to prove a race window is closed rather than
  // relying on real thread timing.
  describe("putSscc atomic write vs a concurrent allocation (CodeRabbit PR33 review, Finding 5)", () => {
    let counter = 0;
    function freshGln(): string {
      counter += 1;
      // Offset well clear of the "putSscc floor" describe block's own
      // freshGln counter above -- both start at 1, and a shared counter
      // would otherwise collide on the same prefix.
      const body = `47${String(counter).padStart(7, "0")}000`;
      return body + String(gs1CheckDigit(body));
    }

    /** Reads sscc_counters.next_serial straight off the row -- the ONLY way to observe atomicSeedSscc's effect without going through putSscc again. */
    async function readCounter(prefix: string): Promise<number | null> {
      const [row] = await db
        .select({ nextSerial: schema.ssccCounters.nextSerial })
        .from(schema.ssccCounters)
        .where(
          and(
            eq(schema.ssccCounters.tenantId, tenantId),
            eq(schema.ssccCounters.issuerPrefix, prefix),
            eq(schema.ssccCounters.extensionDigit, 0),
          ),
        );
      return row ? Number(row.nextSerial) : null;
    }

    it("rejects a stale seed once a concurrent allocation has moved the floor, leaving the counter at the allocation's value", async () => {
      const gln = freshGln();
      const prefix = gln.slice(0, 9);

      // The admin's own pre-check, run BEFORE the race -- floor is 0, no
      // block has ever been issued yet.
      const floorBeforeRace = await seedFloor(db, tenantId, prefix, 0);
      expect(floorBeforeRace).toBe(0);
      const staleNextSerial = 10; // valid against floorBeforeRace, momentarily

      // The race: a device's bundle fetch allocates a REAL block under this
      // SAME prefix, in between the admin's floor read above and their
      // write below -- advancing the counter to 51 and moving the floor to 51.
      const block = await app!.get(SsccService).allocate(tenantId, prefix, 0, deviceId, 50);
      expect(block.toSerial).toBe(50);

      // The admin's write now lands, still carrying the STALE value that
      // was valid a moment ago. The atomic guard must refuse it.
      const applied = await atomicSeedSscc(db, tenantId, prefix, 0, staleNextSerial);
      expect(applied).toBe(false);

      // The counter must be untouched by the rejected write -- still
      // exactly where the concurrent allocation left it, never silently
      // regressed to the stale value.
      expect(await readCounter(prefix)).toBe(51);
    });

    it("still applies cleanly when nothing has changed since the floor was read", async () => {
      const gln = freshGln();
      const prefix = gln.slice(0, 9);

      const floor = await seedFloor(db, tenantId, prefix, 0);
      expect(floor).toBe(0);

      const applied = await atomicSeedSscc(db, tenantId, prefix, 0, 777);
      expect(applied).toBe(true);
      expect(await readCounter(prefix)).toBe(777);
    });
  });
});
