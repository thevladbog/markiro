import express from "express";
import { Test } from "@nestjs/testing";
import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildSscc, gs1CheckDigit } from "@markiro/domain";
import { schema, type Db } from "@markiro/db";
import { and, eq, isNull, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
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
    expect(res.body).toMatchObject({ extensionDigit: 0, nextSerial: 45_000 });
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
    expect(res.body).toMatchObject({ extensionDigit: 0, nextSerial: 12_345 });
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
    expect(res.body).toMatchObject({ extensionDigit: 0, nextSerial: 1 });

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
    expect(resB.body).toMatchObject({ extensionDigit: 0, nextSerial: 1 });

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
    expect(resB.body).toMatchObject({ extensionDigit: 0, nextSerial: 1 });
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
      expect(res.body).toMatchObject({ extensionDigit: 0, nextSerial: 777 });
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

    it("rejects seeding below the floor for a counterparty's counter once a serial has been printed", async () => {
      const gln = freshGln();
      const counterparty = await agent
        .post("/counterparties")
        .send({ name: "Floor test counterparty", gln })
        .expect(201);
      const cpId = (counterparty.body as { id: string }).id;
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

      const rejected = await agent
        .put(`/counterparties/${cpId}/sscc`)
        .send({ extensionDigit: 0, nextSerial: floor - 1 })
        .expect(400);
      // Machine-readable since Task 4: the admin client reads `code` off the
      // body and renders `minSerial` itself, rather than parsing a sentence.
      expect(rejected.body).toMatchObject({ code: "sscc_seed_below_floor", minSerial: floor });

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
  // and then write `nextSerial` in two SEPARATE statements. That gap is
  // still open today, but what can land in it has changed with the
  // 2026-08-20 reseed design: the floor now tracks what was actually
  // PRINTED (`sscc_blocks.consumedThroughSerial`), not what was merely
  // allocated, so a plain `allocate()` in the gap no longer moves it. What
  // still moves it is a concurrent BOX CLOSURE -- a device's closed box
  // arriving at ingest and calling `SsccService.recordConsumedSerial`
  // between the admin's floor read and their write. If the write still
  // landed unconditionally in that case, it would silently overwrite the
  // counter with a value now behind a serial that is already on a physical
  // box. This exercises `atomicSeedSscc` (the fix) directly: the
  // interleaving is forced explicitly (read a floor, THEN let a concurrent
  // box closure advance the printed floor, THEN attempt to write the
  // now-stale value), which is the deterministic way to prove the race
  // window is closed rather than relying on real thread timing.
  describe("putSscc atomic write vs a concurrent box closure (CodeRabbit PR33 review, Finding 5)", () => {
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

    it("rejects a stale seed once a concurrent box closure has moved the printed floor", async () => {
      const gln = freshGln();
      const prefix = gln.slice(0, 9);

      // The admin's own pre-check, run BEFORE the race -- floor is 1 (the
      // extension digit's own first serial), nothing has ever been printed
      // under this prefix yet.
      const floorBeforeRace = await seedFloor(db, tenantId, prefix, 0);
      expect(floorBeforeRace).toBe(1);
      const staleNextSerial = 10; // valid against floorBeforeRace, momentarily

      // A block must exist for there to be something to attribute a printed
      // serial to -- a device's bundle fetch allocates a REAL block under
      // this SAME prefix. This alone does NOT move the printed floor (the
      // 2026-08-20 reseed design): the counter advances to 51, but nothing
      // has been printed yet.
      const block = await app!.get(SsccService).allocate(tenantId, prefix, 0, deviceId, 50);
      expect(block.toSerial).toBe(50);

      // The race: a device's closed box arrives at ingest and reports serial
      // 40 as actually printed, in between the admin's floor read above and
      // their write below -- advancing the printed floor to 41.
      await app!.get(SsccService).recordConsumedSerial(tenantId, buildSscc(0, prefix, 40));

      // The admin's write now lands, still carrying the STALE value that
      // was valid a moment ago. The atomic guard must refuse it.
      const applied = await atomicSeedSscc(db, tenantId, prefix, 0, staleNextSerial);
      expect(applied).toBe(false);

      // The counter must be untouched by the rejected write -- still
      // exactly where the earlier allocation left it (51), never silently
      // regressed to the stale value.
      expect(await readCounter(prefix)).toBe(51);
    });

    it("still applies cleanly when nothing has changed since the floor was read", async () => {
      const gln = freshGln();
      const prefix = gln.slice(0, 9);

      const floor = await seedFloor(db, tenantId, prefix, 0);
      expect(floor).toBe(1);

      const applied = await atomicSeedSscc(db, tenantId, prefix, 0, 777);
      expect(applied).toBe(true);
      expect(await readCounter(prefix)).toBe(777);
    });
  });

  describe("seed guards and block revocation (2026-08-20 reseed design)", () => {
    // Own counter, offset clear of BOTH describe blocks above ("46" and
    // "47"): a shared prefix counter would make these tests seed over rows
    // another test already cut a block under.
    let counter = 0;
    function freshGln(): string {
      counter += 1;
      const body = `48${String(counter).padStart(7, "0")}000`;
      return body + String(gs1CheckDigit(body));
    }

    // The out-of-sync-device guard fires on a device whose `last_seen_at`
    // predates the last shift close -- and `createTestStationDevice` leaves it
    // null. Test 1 below closes a shift, which would then make every later
    // test in this block see a `device_out_of_sync` blocker for a reason none
    // of them is about. Stamping the device as freshly checked-in before each
    // test isolates them to the behaviour they actually assert.
    beforeEach(async () => {
      await db
        .update(schema.stationDevices)
        .set({ lastSeenAt: new Date() })
        .where(eq(schema.stationDevices.id, deviceId));
    });

    /** Direct-DB product seed: product validation is not what these tests exercise. */
    async function seedProduct(): Promise<string> {
      const id = randomUUID();
      await db.insert(schema.products).values({
        id,
        tenantId,
        gtin14: `${Math.floor(Math.random() * 1e13)}`.padStart(14, "0"),
        name: "Seed Product",
        status: "active",
        // Aggregation shifts refuse to be created without one (see
        // ShiftsService's "Aggregation mode requires a box capacity").
        boxCapacity: 12,
      });
      return id;
    }

    /** Direct-DB box label template seed: aggregation shifts require one. */
    async function seedBoxLabelTemplate(): Promise<string> {
      const id = randomUUID();
      await db.insert(schema.labelTemplates).values({
        id,
        tenantId,
        name: `Box Template ${id.slice(0, 8)}`,
        spec: { widthMm: 58, heightMm: 40, dpi: 203, language: "zpl", elements: [] },
      });
      return id;
    }

    /** Creates + opens an aggregation shift, returning its id and display number. */
    async function openAggregationShift(): Promise<{ id: string; number: string }> {
      const productId = await seedProduct();
      const boxLabelTemplateId = await seedBoxLabelTemplate();
      const created = await agent
        .post("/shifts")
        .send({ productId, mode: "aggregation", boxLabelTemplateId })
        .expect(201);
      const id = created.body.id as string;
      const opened = await agent.post(`/shifts/${id}/open`).expect(200);
      return { id, number: opened.body.number as string };
    }

    /** Closes a shift so the counter guard stops reporting it (`reason` is min 3 chars). */
    async function closeShift(id: string): Promise<void> {
      await agent.post(`/shifts/${id}/close`).send({ reason: "counter reseed test" }).expect(200);
    }

    it("refuses to seed while a shift is active, and says which one", async () => {
      const gln = freshGln();
      await agent.put("/org/profile").send({ gln }).expect(200);
      const shift = await openAggregationShift();

      const res = await agent
        .put("/org/profile/sscc")
        .send({ extensionDigit: 0, nextSerial: 900 })
        .expect(409);
      expect(res.body.code).toBe("sscc_seed_active_shift");

      const state = await agent.get("/org/profile/sscc").expect(200);
      expect(state.body.blockedBy).toEqual({
        kind: "active_shift",
        shiftId: shift.id,
        shiftNumber: shift.number,
      });

      await closeShift(shift.id);
      await agent.put("/org/profile/sscc").send({ extensionDigit: 0, nextSerial: 900 }).expect(200);
    });

    it("reports the current floor as minSerial", async () => {
      const gln = freshGln();
      await agent.put("/org/profile").send({ gln }).expect(200);
      const prefix = gln.slice(0, 9);
      const service = app!.get(SsccService);
      await service.allocate(tenantId, prefix, 0, deviceId, 50);
      await service.recordConsumedSerial(tenantId, buildSscc(0, prefix, 7));

      const res = await agent.get("/org/profile/sscc").expect(200);
      expect(res.body.minSerial).toBe(8);
      expect(res.body.blockedBy).toBeNull();
    });

    it("revokes the device's live block when the value changes, and leaves it when it does not", async () => {
      const gln = freshGln();
      await agent.put("/org/profile").send({ gln }).expect(200);
      const prefix = gln.slice(0, 9);
      const service = app!.get(SsccService);
      const block = await service.allocate(tenantId, prefix, 0, deviceId, 50);

      const liveBlocks = async () =>
        db
          .select({ id: schema.ssccBlocks.id })
          .from(schema.ssccBlocks)
          .where(
            and(
              eq(schema.ssccBlocks.tenantId, tenantId),
              eq(schema.ssccBlocks.issuerPrefix, prefix),
              isNull(schema.ssccBlocks.revokedAt),
            ),
          );

      // Re-saving the value the counter already holds must NOT revoke: every
      // redundant "Save" would otherwise burn a whole block and tear a
      // 2000-serial hole in the numbering.
      const unchanged = (await agent.get("/org/profile/sscc").expect(200)).body.nextSerial;
      await agent
        .put("/org/profile/sscc")
        .send({ extensionDigit: 0, nextSerial: unchanged })
        .expect(200);
      expect(await liveBlocks()).toHaveLength(1);

      await agent
        .put("/org/profile/sscc")
        .send({ extensionDigit: 0, nextSerial: block.toSerial + 500 })
        .expect(200);
      expect(await liveBlocks()).toHaveLength(0);
    });

    it("refuses while a device holding a live block is out of sync, unless that device is revoked", async () => {
      const gln = freshGln();
      await agent.put("/org/profile").send({ gln }).expect(200);
      const prefix = gln.slice(0, 9);
      await app!.get(SsccService).allocate(tenantId, prefix, 0, deviceId, 50);

      // A shift closes AFTER the device's last check-in: the device may be
      // offline holding closed boxes whose SSCCs sit in the block above.
      await closeShift((await openAggregationShift()).id);

      const res = await agent
        .put("/org/profile/sscc")
        .send({ extensionDigit: 0, nextSerial: 900 })
        .expect(409);
      expect(res.body.code).toBe("sscc_seed_device_out_of_sync");
      expect((await agent.get("/org/profile/sscc").expect(200)).body.blockedBy).toEqual({
        kind: "device_out_of_sync",
        deviceId,
        deviceName: "Line 1 terminal",
      });

      // A decommissioned terminal must not block the setting forever.
      await db
        .update(schema.stationDevices)
        .set({ revokedAt: new Date() })
        .where(eq(schema.stationDevices.id, deviceId));
      try {
        await agent
          .put("/org/profile/sscc")
          .send({ extensionDigit: 0, nextSerial: 900 })
          .expect(200);
      } finally {
        await db
          .update(schema.stationDevices)
          .set({ revokedAt: null })
          .where(eq(schema.stationDevices.id, deviceId));
      }
    });
  });

  // Task 4 review, Finding 1: `seedCounter`'s pre-write read of the current
  // counter value used to take no row lock, while the lock on
  // `sscc_counters` was only taken a few lines later, inside
  // `atomicSeedSscc`. A concurrent `allocate()` could commit in that window:
  // the read would still see the PRE-allocation value, `atomicSeedSscc`
  // would accept the write anyway (its own re-validation floor is
  // PRINTED-only, by design, and nothing had been printed), and the revoke
  // check (`current.nextSerial === dto.nextSerial`) would then compare two
  // copies of the same stale number and conclude "no change" -- skipping
  // revocation of the live block `allocate()` had just handed a device. The
  // fix adds `.for("update")` to that read.
  //
  // Reproducing this deterministically (no `setTimeout`/sleep race) requires
  // a REAL held Postgres transaction, because the bug is specifically about
  // whether a read blocks on another transaction's row lock -- something a
  // purely sequential test cannot exercise: run the statements in any fixed
  // order and there is no window left for the race to fall into. So this
  // holds a genuine `allocate()` transaction open across an `await`, and
  // uses `pg_locks` (not a timer) to confirm `seedCounter`'s own locked read
  // has actually queued behind it before releasing -- the DB's own lock
  // state is the synchronization signal, not wall-clock timing.
  describe("seedCounter locked read vs a concurrent allocate (final review, finding 1)", () => {
    let counter = 0;
    function freshGln(): string {
      counter += 1;
      const body = `50${String(counter).padStart(7, "0")}000`;
      return body + String(gs1CheckDigit(body));
    }

    beforeEach(async () => {
      await db
        .update(schema.stationDevices)
        .set({ lastSeenAt: new Date() })
        .where(eq(schema.stationDevices.id, deviceId));
    });

    /**
     * Polls `pg_stat_activity` for a backend whose current query names
     * `queryFragment` and is waiting on `wait_event_type = 'Lock'` -- i.e.
     * some other session is genuinely queued behind a lock while running
     * that query. `pg_locks` alone does NOT surface this: a session blocked
     * on `SELECT ... FOR UPDATE` waits on a `transactionid`-type lock (the
     * blocker's own transaction ID), not a `relation`-type one, so joining
     * `pg_locks` to `pg_class` on the target table -- the obvious first
     * approach -- silently finds nothing and this poll would never resolve.
     * `pg_stat_activity`'s `wait_event_type` reports the wait regardless of
     * lock type, which is why it's used here instead. The 20ms polling
     * interval only affects how quickly the poll notices the state change;
     * the assertion itself waits on that DB-visible state, not on a fixed
     * delay, so it does not flake under CI scheduling jitter the way a
     * "sleep N ms and hope" approach would.
     */
    async function waitForBlockedLockRequest(
      queryFragment: string,
      timeoutMs = 5000,
    ): Promise<void> {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const res = await db.execute<{ count: string }>(sql`
          SELECT count(*)::text AS count
          FROM pg_stat_activity
          WHERE wait_event_type = 'Lock'
            AND query ILIKE ${`%${queryFragment}%`}
            AND pid <> pg_backend_pid()
        `);
        if (Number(res.rows[0]?.count ?? "0") > 0) return;
        if (Date.now() > deadline) {
          throw new Error(`Timed out waiting for a blocked query mentioning "${queryFragment}"`);
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    }

    it("revokes the device's block instead of silently skipping it when a concurrent allocate advances the counter first", async () => {
      const gln = freshGln();
      await agent.put("/org/profile").send({ gln }).expect(200);
      const prefix = gln.slice(0, 9);
      const service = app!.get(SsccService);

      // Seed once so `sscc_counters` already has a row -- `FOR UPDATE` locks
      // nothing on a row that doesn't exist yet (see this test's sibling
      // "seeds freely" case for that path; it needs no lock because the
      // `current == null` branch already revokes unconditionally).
      const preAllocationValue = 500;
      await agent
        .put("/org/profile/sscc")
        .send({ extensionDigit: 0, nextSerial: preAllocationValue })
        .expect(200);

      // Hold a REAL allocate() transaction open on this counter's row: its
      // own upsert acquires the row lock immediately, `lockAcquired` fires
      // the instant that statement returns (guaranteeing the lock is held
      // by the time we proceed), and the transaction then parks on `held`
      // -- keeping the lock in place -- until this test releases it below.
      let lockAcquired!: () => void;
      const lockAcquiredPromise = new Promise<void>((resolve) => {
        lockAcquired = resolve;
      });
      let release!: () => void;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      const allocatePromise = db.transaction(async (tx) => {
        const block = await service.allocate(tenantId, prefix, 0, deviceId, 2000, tx);
        lockAcquired();
        await held;
        return block;
      });

      await lockAcquiredPromise;

      // seedCounter submits the value the counter held BEFORE the concurrent
      // allocate above -- exactly the stale value an unlocked read would
      // have produced. Its `findSeedBlocker`/`seedFloor` reads don't touch
      // `sscc_counters`, so its own locked read is the first thing it does
      // that can collide with the lock `allocate()` is holding; started but
      // deliberately not awaited yet, so it can queue behind that lock.
      const seedPromise = service.seedCounter(tenantId, prefix, {
        extensionDigit: 0,
        nextSerial: preAllocationValue,
      });

      // Confirms seedCounter's locked read is now genuinely queued behind
      // allocate()'s held lock, before we let that lock go -- proving the
      // fix's `.for("update")` is what's blocking it, not coincidence.
      await waitForBlockedLockRequest("sscc_counters");

      release();
      const block = await allocatePromise;
      const result = await seedPromise;

      // The write itself is allowed to land (by design -- `seedFloor` only
      // tracks PRINTED serials, and nothing was printed here), but with the
      // locked read now seeing the POST-allocation counter value (not the
      // stale pre-allocation one this admin submitted), `current.nextSerial
      // !== dto.nextSerial` holds and the block allocate() just handed the
      // device must be revoked -- closing exactly the hole Finding 1
      // describes, instead of silently leaving a live block over a range
      // the counter can now hand out again.
      expect(result.nextSerial).toBe(preAllocationValue);

      const liveBlocks = await db
        .select({ id: schema.ssccBlocks.id })
        .from(schema.ssccBlocks)
        .where(
          and(
            eq(schema.ssccBlocks.tenantId, tenantId),
            eq(schema.ssccBlocks.issuerPrefix, prefix),
            eq(schema.ssccBlocks.extensionDigit, 0),
            isNull(schema.ssccBlocks.revokedAt),
          ),
        );
      expect(liveBlocks).toHaveLength(0);
      expect(block.fromSerial).toBe(preAllocationValue);
    });
  });
});
