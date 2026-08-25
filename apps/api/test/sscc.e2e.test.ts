import { randomUUID } from "node:crypto";
import express from "express";
import { Test } from "@nestjs/testing";
import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { buildSscc, canonicalizeKm, kmHash } from "@markiro/domain";
import { schema, type Db } from "@markiro/db";
import { AppModule } from "../src/app.module";
import { mountAuth, setupAuth, type AuthSetup } from "../src/auth/auth.setup";
import { loadEnv } from "../src/env";
import { SsccCapacityExhaustedException, SsccService } from "../src/modules/sscc/sscc.service";
import { listenOnLoopback } from "./support/listen-loopback";
import { createTestStationDevice, signUpAndActivate } from "./support/auth";

const ready = Boolean(
  process.env.DATABASE_URL && process.env.BETTER_AUTH_SECRET && process.env.BETTER_AUTH_URL,
);

// Same fixture as conflicts.e2e.test.ts / products.e2e.test.ts.
const VALID_GTIN14 = "04006381333931";

// Three distinct, check-digit-valid GLNs -- kept apart so a service bug that
// swapped the organisation's own GLN with the counterparty's (or vice versa)
// shows up as a wrong value rather than an accidental match.
const ORG_GLN = "4601112222005";
const COUNTERPARTY_GLN = "4609876543008";

// Two distinct, check-digit-valid GLNs sharing the 9-digit prefix
// "460123400" -- the same example the correction's own background uses: one
// GS1 member holding two GLNs (e.g. two locations) that differ only in the
// digits after the prefix. Two counters keyed on the full GLN would each
// hand out serial 1 independently and buildSscc would turn both into the
// SAME SSCC -- the exact collision the prefix-keyed counter prevents.
const SHARED_PREFIX = "460123400";
const GLN_SHARING_PREFIX_A = "4601234000017";
const GLN_SHARING_PREFIX_B = "4601234000024";

describe.skipIf(!ready)("sscc e2e", () => {
  let app: INestApplication | undefined;
  let setup: AuthSetup;
  let db: Db;

  let agent: ReturnType<typeof request.agent>;
  let tenantId: string;
  let productId: string;
  let shiftWithIssuerId: string;
  let plainShiftId: string;

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
    const counterpartyId = (counterparty.body as { id: string }).id;

    const product = await agent
      .post("/products")
      .send({
        name: "Cola",
        gtin: VALID_GTIN14,
        productGroup: "Beverages",
        boxCapacity: 10,
        palletCapacity: 5,
      })
      .expect(201);
    productId = (product.body as { id: string }).id;

    const boxLabelTemplateId = randomUUID();
    await db.insert(schema.labelTemplates).values({
      id: boxLabelTemplateId,
      tenantId,
      name: "SSCC test box template",
      spec: { widthMm: 58, heightMm: 40, dpi: 203, language: "zpl", elements: [] },
    });
    await agent
      .put("/org/profile")
      .send({ defaultBoxLabelTemplateId: boxLabelTemplateId })
      .expect(200);

    // The CreateShiftDto has no field for ssccIssuerCounterpartyId (Task 3
    // only landed the column; no route sets it yet), so it's assigned
    // directly here, same as sccc counters/blocks are inserted directly in
    // the tests below.
    const shiftWithIssuer = await agent
      .post("/shifts")
      .send({ productId, mode: "aggregation" })
      .expect(201);
    shiftWithIssuerId = (shiftWithIssuer.body as { id: string }).id;
    await db
      .update(schema.shifts)
      .set({ ssccIssuerCounterpartyId: counterpartyId })
      .where(and(eq(schema.shifts.tenantId, tenantId), eq(schema.shifts.id, shiftWithIssuerId)));

    const plainShift = await agent
      .post("/shifts")
      .send({ productId, mode: "aggregation" })
      .expect(201);
    plainShiftId = (plainShift.body as { id: string }).id;
  });

  afterAll(async () => {
    await app?.close();
  });

  /** Registers a real station_devices row -- sscc_blocks.device_id carries a real FK to it. */
  async function registerDevice(name: string): Promise<string> {
    return (await createTestStationDevice(app!, agent, name)).deviceId;
  }

  /** Creates a counterparty + shift pointing at it as the sscc issuer, returning the shift id. */
  async function shiftIssuedBy(name: string, gln: string): Promise<string> {
    const counterparty = await agent.post("/counterparties").send({ name, gln }).expect(201);
    const counterpartyId = (counterparty.body as { id: string }).id;
    const shift = await agent.post("/shifts").send({ productId, mode: "aggregation" }).expect(201);
    const shiftId = (shift.body as { id: string }).id;
    await db
      .update(schema.shifts)
      .set({ ssccIssuerCounterpartyId: counterpartyId })
      .where(and(eq(schema.shifts.tenantId, tenantId), eq(schema.shifts.id, shiftId)));
    return shiftId;
  }

  // A 9-digit issuer prefix unused by any other test in this file: these
  // tests cut REAL sscc_blocks rows, and sharing a prefix would make one
  // test's blocks shift another's expected serials.
  let prefixCounter = 0;
  function freshPrefix(): string {
    prefixCounter += 1;
    return `47${String(prefixCounter).padStart(7, "0")}`;
  }

  it("allocates non-overlapping blocks under concurrency", async () => {
    const svc = app!.get(SsccService);
    const prefix = "111111111";
    const deviceIds = await Promise.all(
      Array.from({ length: 8 }, (_, i) => registerDevice(`Concurrency device ${i}`)),
    );
    const blocks = await Promise.all(
      deviceIds.map((deviceId) => svc.allocate(tenantId, prefix, 0, deviceId, 100)),
    );
    const sorted = [...blocks].sort((a, b) => a.fromSerial - b.fromSerial);
    for (let i = 1; i < sorted.length; i++) {
      expect(sorted[i]!.fromSerial).toBeGreaterThan(sorted[i - 1]!.toSerial);
    }
    expect(new Set(blocks.map((b) => b.fromSerial)).size).toBe(8);
  });

  it("starts a fresh box range at serial one", async () => {
    const deviceId = await registerDevice("First serial device");
    const block = await app!.get(SsccService).allocate(tenantId, "555555555", 0, deviceId, 3);

    expect(block).toMatchObject({ fromSerial: 1, toSerial: 3 });
    const sscc = buildSscc(0, "555555555", block.fromSerial);
    expect(sscc).toHaveLength(18);
    expect(sscc.slice(10, 17)).toBe("0000001");
  });

  it("continues from the seeded starting serial", async () => {
    const prefix = "222222222";
    const deviceId = await registerDevice("Seeded-counter device");
    await db
      .insert(schema.ssccCounters)
      .values({ tenantId, issuerPrefix: prefix, extensionDigit: 0, nextSerial: 45_000 });
    const block = await app!.get(SsccService).allocate(tenantId, prefix, 0, deviceId, 10);
    expect(block.fromSerial).toBe(45_000);
  });

  it("records which device received the block", async () => {
    const prefix = "333333333";
    const deviceId = await registerDevice("Recorded device");
    const block = await app!.get(SsccService).allocate(tenantId, prefix, 0, deviceId, 10);
    const rows = await db
      .select()
      .from(schema.ssccBlocks)
      .where(
        and(eq(schema.ssccBlocks.tenantId, tenantId), eq(schema.ssccBlocks.deviceId, deviceId)),
      );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.fromSerial).toBe(block.fromSerial);
  });

  it("deduplicates duplicate historical revoked block starts in bundle safety output", async () => {
    const prefix = freshPrefix();
    const deviceId = await registerDevice("Duplicate revoked start device");
    await db.insert(schema.ssccBlocks).values([
      {
        tenantId,
        issuerPrefix: prefix,
        extensionDigit: 0,
        deviceId,
        fromSerial: 50,
        toSerial: 99,
        revokedAt: new Date(),
      },
      {
        tenantId,
        issuerPrefix: prefix,
        extensionDigit: 0,
        deviceId,
        fromSerial: 50,
        toSerial: 149,
        revokedAt: new Date(),
      },
    ]);

    await expect(
      app!.get(SsccService).revokedFromSerials(tenantId, prefix, 0, deviceId),
    ).resolves.toEqual([50]);
  });

  it("resolves a shift's issuer to the counterparty's issuer prefix when one is set", async () => {
    const prefix = await app!.get(SsccService).resolveIssuerPrefix(tenantId, shiftWithIssuerId);
    expect(prefix).toBe(COUNTERPARTY_GLN.slice(0, 9));
  });

  it("resolves to the organisation's own issuer prefix when the shift sets no issuer", async () => {
    expect(await app!.get(SsccService).resolveIssuerPrefix(tenantId, plainShiftId)).toBe(
      ORG_GLN.slice(0, 9),
    );
  });

  it("draws from the SAME counter for two different GLNs sharing a 9-digit prefix", async () => {
    const svc = app!.get(SsccService);
    const shiftA = await shiftIssuedBy("Location A", GLN_SHARING_PREFIX_A);
    const shiftB = await shiftIssuedBy("Location B", GLN_SHARING_PREFIX_B);

    const prefixA = await svc.resolveIssuerPrefix(tenantId, shiftA);
    const prefixB = await svc.resolveIssuerPrefix(tenantId, shiftB);
    // Both GLNs resolve to the same prefix -- this is the number space's
    // real identity, not the GLN itself.
    expect(prefixA).toBe(SHARED_PREFIX);
    expect(prefixB).toBe(SHARED_PREFIX);

    const deviceA = await registerDevice("Shared-prefix device A");
    const deviceB = await registerDevice("Shared-prefix device B");
    const blockA = await svc.allocate(tenantId, prefixA, 0, deviceA, 50);
    const blockB = await svc.allocate(tenantId, prefixB, 0, deviceB, 50);
    // Contiguous ranges prove ONE shared counter advanced twice, rather than
    // two independent counters (keyed on the full GLN) each starting at 1 --
    // the bug this correction fixes, which would make blockB.fromSerial 1
    // instead of continuing from blockA's range.
    expect(blockB.fromSerial).toBe(blockA.toSerial + 1);
  });

  it("rolls back the counter when the block insert fails (unknown device)", async () => {
    const svc = app!.get(SsccService);
    const prefix = "444444444";
    const unknownDeviceId = "00000000-0000-4000-8000-000000000000";

    await expect(svc.allocate(tenantId, prefix, 0, unknownDeviceId, 10)).rejects.toThrow();

    const rows = await db
      .select()
      .from(schema.ssccCounters)
      .where(
        and(
          eq(schema.ssccCounters.tenantId, tenantId),
          eq(schema.ssccCounters.issuerPrefix, prefix),
          eq(schema.ssccCounters.extensionDigit, 0),
        ),
      );
    // No row at all -- had the counter upsert and the failing block insert
    // not been wrapped in one transaction, the counter's insert would have
    // survived on its own, burning the range with no sscc_blocks row
    // recording who (attempted to receive) it.
    expect(rows).toHaveLength(0);
  });

  it("keeps extension digit 1 from disturbing extension digit 0 under the same prefix", async () => {
    const svc = app!.get(SsccService);
    const prefix = "555555555";
    const device0 = await registerDevice("Ext-digit-0 device");
    const device1 = await registerDevice("Ext-digit-1 device");

    const block0First = await svc.allocate(tenantId, prefix, 0, device0, 20);
    const block1 = await svc.allocate(tenantId, prefix, 1, device1, 30);
    // A hardcoded extensionDigit: 0 inside allocate()'s .values() calls would
    // route this ext-1 request onto ext-0's counter, making it continue from
    // block0First's range instead of starting fresh.
    expect(block1.fromSerial).toBe(0);

    const block0Second = await svc.allocate(tenantId, prefix, 0, device0, 5);
    // ext-0's own counter must be exactly where block0First left it --
    // undisturbed by the ext-1 allocation in between.
    expect(block0Second.fromSerial).toBe(block0First.toSerial + 1);
  });

  it("cuts a fresh block instead of handing back a revoked one", async () => {
    const service = app!.get(SsccService);
    const deviceId = await registerDevice("Revoked block device");
    const prefix = freshPrefix();

    const first = await service.allocateForBundle(tenantId, prefix, 0, deviceId, 50);
    // A repeat fetch must still hand back the SAME block -- that invariant is
    // what keeps a station from burning through the number space on every
    // shift entry, and this test must not silently relax it.
    const repeat = await service.allocateForBundle(tenantId, prefix, 0, deviceId, 50);
    expect(repeat.fromSerial).toBe(first.fromSerial);

    await db
      .update(schema.ssccBlocks)
      .set({ revokedAt: new Date() })
      .where(
        and(
          eq(schema.ssccBlocks.tenantId, tenantId),
          eq(schema.ssccBlocks.issuerPrefix, prefix),
          eq(schema.ssccBlocks.extensionDigit, 0),
        ),
      );

    const afterRevoke = await service.allocateForBundle(tenantId, prefix, 0, deviceId, 50);
    expect(afterRevoke.fromSerial).toBe(first.toSerial + 1);
  });

  describe("recordConsumedSerial (Task 7 correction)", () => {
    /** Reads back the one sscc_blocks row for this device -- tests below allocate exactly one. */
    async function blockFor(deviceId: string) {
      const [row] = await db
        .select()
        .from(schema.ssccBlocks)
        .where(
          and(eq(schema.ssccBlocks.tenantId, tenantId), eq(schema.ssccBlocks.deviceId, deviceId)),
        );
      return row;
    }

    it("advances the covering block's consumedThroughSerial", async () => {
      const svc = app!.get(SsccService);
      const prefix = "600000001";
      const deviceId = await registerDevice("Consume device A");
      const block = await svc.allocate(tenantId, prefix, 0, deviceId, 20);

      const sscc = buildSscc(0, prefix, block.fromSerial + 3);
      await svc.recordConsumedSerial(tenantId, sscc);

      const row = await blockFor(deviceId);
      expect(row!.consumedThroughSerial).toBe(block.fromSerial + 3);
    });

    it("never regresses the cursor when an earlier serial's closure arrives late", async () => {
      const svc = app!.get(SsccService);
      const prefix = "600000002";
      const deviceId = await registerDevice("Consume device B");
      const block = await svc.allocate(tenantId, prefix, 0, deviceId, 20);

      await svc.recordConsumedSerial(tenantId, buildSscc(0, prefix, block.fromSerial + 5));
      await svc.recordConsumedSerial(tenantId, buildSscc(0, prefix, block.fromSerial + 2));

      const row = await blockFor(deviceId);
      // A GREATEST-based advance, not an unconditional overwrite: an
      // out-of-order arrival (offline batches, retried syncs) must not walk
      // the cursor backwards.
      expect(row!.consumedThroughSerial).toBe(block.fromSerial + 5);
    });

    it("is tenant-scoped: does not advance another tenant's block under the same prefix+serial", async () => {
      const svc = app!.get(SsccService);
      const prefix = "600000003";
      const deviceId = await registerDevice("Consume device C");
      const block = await svc.allocate(tenantId, prefix, 0, deviceId, 20);

      // A second tenant, allocated the SAME prefix+extension-digit range
      // (counters are independent per tenant, so both blocks cover serial
      // block.fromSerial + 1) -- the only way to prove the update's tenantId
      // clause, not just the range match, is what keeps the two apart.
      const otherAgent = request.agent(app!.getHttpServer());
      const otherTenantId = await signUpAndActivate(otherAgent);
      const otherDeviceId = (await createTestStationDevice(app!, otherAgent, "Other tenant device"))
        .deviceId;
      await svc.allocate(otherTenantId, prefix, 0, otherDeviceId, 20);

      const sscc = buildSscc(0, prefix, block.fromSerial + 1);
      await svc.recordConsumedSerial(otherTenantId, sscc);

      const mine = await blockFor(deviceId);
      expect(mine!.consumedThroughSerial).toBeNull();
    });

    it("is a silent no-op for an sscc that matches no known block", async () => {
      const svc = app!.get(SsccService);
      // Well-formed but never allocated under this tenant.
      const sscc = buildSscc(0, "609999999", 1);
      await expect(svc.recordConsumedSerial(tenantId, sscc)).resolves.toBeUndefined();
    });

    it("is a silent no-op for a malformed sscc", async () => {
      const svc = app!.get(SsccService);
      await expect(svc.recordConsumedSerial(tenantId, "not-an-sscc")).resolves.toBeUndefined();
    });
  });

  describe("allocateForBundle remainder (Task 7 correction)", () => {
    it("hands back the whole range on a repeat call before anything is consumed", async () => {
      const svc = app!.get(SsccService);
      const prefix = "700000001";
      const deviceId = await registerDevice("Remainder device A");

      const first = await svc.allocateForBundle(tenantId, prefix, 0, deviceId, 20);
      const second = await svc.allocateForBundle(tenantId, prefix, 0, deviceId, 20);

      expect(second).toEqual(first);
      const rows = await db
        .select()
        .from(schema.ssccBlocks)
        .where(
          and(eq(schema.ssccBlocks.tenantId, tenantId), eq(schema.ssccBlocks.deviceId, deviceId)),
        );
      expect(rows).toHaveLength(1);
    });

    it("hands back the block's ORIGINAL bounds plus the consumed cursor once part of it is recorded consumed (final review, finding 1)", async () => {
      const svc = app!.get(SsccService);
      const prefix = "700000002";
      const deviceId = await registerDevice("Remainder device B");

      const first = await svc.allocateForBundle(tenantId, prefix, 0, deviceId, 20);
      const consumedUpTo = first.fromSerial + 6;
      await svc.recordConsumedSerial(tenantId, buildSscc(0, prefix, consumedUpTo));

      const remainder = await svc.allocateForBundle(tenantId, prefix, 0, deviceId, 20);
      // NEVER a shrunk range: a fromSerial that moves would not match the
      // device's already-held row's primary key (issuer_prefix,
      // extension_digit, from_serial) on its own sscc_pool, and would be
      // inserted there as a SECOND, overlapping row instead of reconciling
      // the first -- the exact bug this correction fixes (see
      // SsccService.allocateForBundle's doc comment).
      expect(remainder.fromSerial).toBe(first.fromSerial);
      expect(remainder.toSerial).toBe(first.toSerial);
      expect(remainder.consumedThroughSerial).toBe(consumedUpTo);

      // Still the SAME block, not a fresh one -- the row count must not grow.
      const rows = await db
        .select()
        .from(schema.ssccBlocks)
        .where(
          and(eq(schema.ssccBlocks.tenantId, tenantId), eq(schema.ssccBlocks.deviceId, deviceId)),
        );
      expect(rows).toHaveLength(1);
    });

    it("cuts a fresh block once the held one is fully consumed, instead of handing back an exhausted range", async () => {
      const svc = app!.get(SsccService);
      const prefix = "700000003";
      const deviceId = await registerDevice("Remainder device C");

      const first = await svc.allocateForBundle(tenantId, prefix, 0, deviceId, 5);
      await svc.recordConsumedSerial(tenantId, buildSscc(0, prefix, first.toSerial));

      const next = await svc.allocateForBundle(tenantId, prefix, 0, deviceId, 5);
      expect(next.fromSerial).toBe(first.toSerial + 1);

      const rows = await db
        .select()
        .from(schema.ssccBlocks)
        .where(
          and(eq(schema.ssccBlocks.tenantId, tenantId), eq(schema.ssccBlocks.deviceId, deviceId)),
        );
      expect(rows).toHaveLength(2);

      // Task 10 fix: recordConsumedSerial's covering-range predicates
      // (fromSerial <= serial <= toSerial) must scope the UPDATE to the
      // block that actually covers the serial. Every OTHER test in this
      // describe block uses a device holding exactly one block, so dropping
      // those predicates would be undetectable there -- this fixture
      // already holds two (the exhausted `first` and the fresh `next`), so
      // recording a serial from the SECOND block must leave the FIRST
      // block's cursor untouched rather than pushing it past a serial it
      // never actually issued.
      await svc.recordConsumedSerial(tenantId, buildSscc(0, prefix, next.fromSerial));
      const afterRows = await db
        .select()
        .from(schema.ssccBlocks)
        .where(
          and(eq(schema.ssccBlocks.tenantId, tenantId), eq(schema.ssccBlocks.deviceId, deviceId)),
        )
        .orderBy(schema.ssccBlocks.fromSerial);
      expect(afterRows).toHaveLength(2);
      expect(afterRows[0]!.fromSerial).toBe(first.fromSerial);
      expect(afterRows[0]!.consumedThroughSerial).toBe(first.toSerial);
      expect(afterRows[1]!.fromSerial).toBe(next.fromSerial);
      expect(afterRows[1]!.consumedThroughSerial).toBe(next.fromSerial);
    });

    it("reports a consumed cursor of 0 as itself, not as 'nothing consumed yet' (Task 10 fix)", async () => {
      const svc = app!.get(SsccService);
      // Historical blocks beginning at zero remain valid even though fresh
      // box allocation now starts at one. Seed one directly so this test
      // still covers the one cursor value where "== null" (correct) and a
      // falsy check (the regression this guards) diverge: 0 is falsy but not
      // null/undefined.
      const prefix = "700000005";
      const deviceId = await registerDevice("Remainder device D");
      await db.insert(schema.ssccBlocks).values({
        tenantId,
        issuerPrefix: prefix,
        extensionDigit: 0,
        deviceId,
        fromSerial: 0,
        toSerial: 19,
      });

      const first = await svc.allocateForBundle(tenantId, prefix, 0, deviceId, 20);
      expect(first.fromSerial).toBe(0);

      await svc.recordConsumedSerial(tenantId, buildSscc(0, prefix, first.fromSerial));

      const remainder = await svc.allocateForBundle(tenantId, prefix, 0, deviceId, 20);
      // Original bounds, unchanged (final review, finding 1) -- and a falsy
      // check regression would have read `consumedThroughSerial: 0` as
      // "nothing consumed yet" and returned null here instead of 0.
      expect(remainder.fromSerial).toBe(first.fromSerial);
      expect(remainder.toSerial).toBe(first.toSerial);
      expect(remainder.consumedThroughSerial).toBe(0);

      // Still the SAME block -- row count must stay 1.
      const rows = await db
        .select()
        .from(schema.ssccBlocks)
        .where(
          and(eq(schema.ssccBlocks.tenantId, tenantId), eq(schema.ssccBlocks.deviceId, deviceId)),
        );
      expect(rows).toHaveLength(1);
    });

    it("cuts a fresh block instead of an inverted range if consumedThroughSerial ever exceeds toSerial (Task 10 fix)", async () => {
      const svc = app!.get(SsccService);
      const prefix = "700000006";
      const deviceId = await registerDevice("Remainder device E");

      const first = await svc.allocateForBundle(tenantId, prefix, 0, deviceId, 5);
      // recordConsumedSerial's own covering-range predicates can never
      // produce this -- it is a defensive scenario, simulated directly here
      // -- but allocateForBundle must not read "!== toSerial" as "still has
      // room" and hand back an inverted (fromSerial > toSerial) range.
      await db
        .update(schema.ssccBlocks)
        .set({ consumedThroughSerial: first.toSerial + 1 })
        .where(
          and(eq(schema.ssccBlocks.tenantId, tenantId), eq(schema.ssccBlocks.deviceId, deviceId)),
        );

      const next = await svc.allocateForBundle(tenantId, prefix, 0, deviceId, 5);
      expect(next.fromSerial).toBe(first.toSerial + 1);
      expect(next.toSerial).toBeGreaterThanOrEqual(next.fromSerial);
    });
  });

  // CodeRabbit PR33 review, Finding 4: `allocate` used to increment the
  // counter unconditionally, with nothing stopping a block from crossing a
  // 9-digit issuer prefix's own capacity (10_000_000 = 10 ** (16 - 9)). The
  // settings API lets an admin seed `nextSerial` up to 9_999_999, so an
  // allocation near that ceiling could produce a block whose `toSerial` sat
  // beyond capacity -- burning serials `buildSscc` can never turn into a
  // valid SSCC.
  describe("capacity boundary (CodeRabbit PR33 review, Finding 4)", () => {
    const CAPACITY = 10_000_000;

    /** Seeds the counter directly to `nextSerial`, bypassing putSscc's own floor check (not under test here). */
    async function seedCounter(prefix: string, nextSerial: number): Promise<void> {
      await db
        .insert(schema.ssccCounters)
        .values({ tenantId, issuerPrefix: prefix, extensionDigit: 0, nextSerial });
    }

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

    it("clamps a block that would cross capacity to only the remainder, and corrects the persisted counter to exactly capacity", async () => {
      const svc = app!.get(SsccService);
      const prefix = "800000001";
      const deviceId = await registerDevice("Near-ceiling device A");
      // Only 5 serials remain (9_999_995..9_999_999) before capacity.
      await seedCounter(prefix, CAPACITY - 5);

      const block = await svc.allocate(tenantId, prefix, 0, deviceId, 10);

      expect(block.fromSerial).toBe(CAPACITY - 5);
      // NOT fromSerial + 10 - 1: clamped to the last serial actually inside
      // capacity, not the full requested size.
      expect(block.toSerial).toBe(CAPACITY - 1);
      // The persisted counter must land exactly on capacity -- never above
      // it, which would silently corrupt every later allocate() on this
      // counter into producing an over-capacity block again.
      expect(await readCounter(prefix)).toBe(CAPACITY);
      // buildSscc must accept every serial in the granted (clamped) block.
      expect(() => buildSscc(0, prefix, block.fromSerial)).not.toThrow();
      expect(() => buildSscc(0, prefix, block.toSerial)).not.toThrow();
    });

    it("refuses cleanly (named exhaustion error) once the counter is already at capacity, rolling back the attempted increment", async () => {
      const svc = app!.get(SsccService);
      const prefix = "800000002";
      const deviceId = await registerDevice("Near-ceiling device B");
      await seedCounter(prefix, CAPACITY);

      await expect(svc.allocate(tenantId, prefix, 0, deviceId, 10)).rejects.toBeInstanceOf(
        SsccCapacityExhaustedException,
      );

      // The rejected attempt must leave the counter untouched -- rolled back
      // inside the SAME transaction the increment ran in, not left sitting
      // over capacity.
      expect(await readCounter(prefix)).toBe(CAPACITY);
      // And no orphaned sscc_blocks row was left behind for the failed attempt.
      const rows = await db
        .select()
        .from(schema.ssccBlocks)
        .where(
          and(eq(schema.ssccBlocks.tenantId, tenantId), eq(schema.ssccBlocks.issuerPrefix, prefix)),
        );
      expect(rows).toHaveLength(0);
    });

    it("stays internally consistent across repeated allocations right up to and past the ceiling", async () => {
      const svc = app!.get(SsccService);
      const prefix = "800000003";
      const deviceA = await registerDevice("Near-ceiling device C1");
      const deviceB = await registerDevice("Near-ceiling device C2");
      await seedCounter(prefix, CAPACITY - 3);

      // First device: only 3 remain -- gets a clamped block of exactly 3.
      const first = await svc.allocate(tenantId, prefix, 0, deviceA, 10);
      expect(first.fromSerial).toBe(CAPACITY - 3);
      expect(first.toSerial).toBe(CAPACITY - 1);
      expect(await readCounter(prefix)).toBe(CAPACITY);

      // Second device, right after: nothing left at all.
      await expect(svc.allocate(tenantId, prefix, 0, deviceB, 10)).rejects.toBeInstanceOf(
        SsccCapacityExhaustedException,
      );
      // Still exactly at capacity -- the failed second attempt changed nothing.
      expect(await readCounter(prefix)).toBe(CAPACITY);
    });
  });

  // Task 6: the compliance-critical guarantee that a disassembled box's own
  // sscc can never be handed to a new box. Nothing in this plan modifies
  // `SsccService.allocate`'s counter itself (it always advances forward and
  // never reads `boxes` at all) -- this test exists to LOCK DOWN that an
  // already-existing property of the counter continues to hold once
  // "disassemble" (station-scans.service.ts) exists as a caller that can
  // retire a box, not to drive new production code in this service.
  describe("disassemble retires an SSCC for good (Task 6)", () => {
    it("a disassembled box's SSCC never reappears in a later allocation for the same prefix", async () => {
      const svc = app!.get(SsccService);
      const prefix = "900000001";

      const device = await createTestStationDevice(app!, agent, "Disassemble-lockdown device");
      const deviceId = device.deviceId;
      const apiKey = device.apiKey;

      // A dedicated, OPENED shift -- this describe's shared `shiftWithIssuerId`/
      // `plainShiftId` fixtures are never opened, and posting scans against a
      // still-`planned` shift is not what a real device flow looks like.
      const shift = await agent
        .post("/shifts")
        .send({ productId, mode: "aggregation" })
        .expect(201);
      const shiftId = (shift.body as { id: string }).id;
      await agent.post(`/shifts/${shiftId}/open`).expect(200);

      // Allocate a block and burn its very FIRST serial as the box's own
      // sscc, closing a real box through the ordinary sync-batch endpoint --
      // exactly the path that writes `boxes.sscc` and calls
      // `SsccService.recordConsumedSerial` in production.
      const block = await svc.allocate(tenantId, prefix, 0, deviceId, 20);
      const burnedSerial = block.fromSerial;
      const sscc = buildSscc(0, prefix, burnedSerial);
      const raw = `01${VALID_GTIN14}21S-d1`;
      const km = canonicalizeKm(raw);
      const codeHash = kmHash(km);

      await request(app!.getHttpServer())
        .post("/station/scans")
        .set("x-api-key", apiKey)
        .send({
          batchId: `disassemble-sscc-scan-${randomUUID()}`,
          items: [
            {
              shiftId,
              terminalId: deviceId,
              raw,
              verdict: "ok",
              scannedAt: new Date().toISOString(),
              code: { codeHash, gtin14: km.gtin14, serial: km.serial },
              boxId: "b1",
              operatorId: null,
            },
          ],
          boxes: [],
          exceptions: [],
        })
        .expect(201);

      await request(app!.getHttpServer())
        .post("/station/scans")
        .set("x-api-key", apiKey)
        .send({
          batchId: `disassemble-sscc-close-${randomUUID()}`,
          items: [],
          boxes: [
            {
              boxId: "b1",
              shiftId,
              terminalId: deviceId,
              sscc,
              closedAt: new Date().toISOString(),
              operatorId: null,
            },
          ],
          exceptions: [],
        })
        .expect(201);

      const [boxRow] = await db
        .select({ id: schema.boxes.id })
        .from(schema.boxes)
        .where(and(eq(schema.boxes.tenantId, tenantId), eq(schema.boxes.deviceBoxId, "b1")));
      const boxId = boxRow!.id;

      // Disassemble it via the same sync-batch endpoint a real station uses.
      await request(app!.getHttpServer())
        .post("/station/scans")
        .set("x-api-key", apiKey)
        .send({
          batchId: `disassemble-sscc-exception-${randomUUID()}`,
          items: [],
          boxes: [],
          exceptions: [
            {
              kind: "disassemble",
              boxId: "b1",
              codeHash: null,
              shiftId,
              terminalId: deviceId,
              operatorId: null,
              reason: "wrong customer",
              occurredAt: new Date().toISOString(),
            },
          ],
        })
        .expect(201);

      const [disassembled] = await db
        .select({ disassembledAt: schema.boxes.disassembledAt, sscc: schema.boxes.sscc })
        .from(schema.boxes)
        .where(eq(schema.boxes.id, boxId));
      expect(disassembled?.disassembledAt).not.toBeNull();
      // The sscc string is kept, historical -- retirement is disassembledAt
      // alone.
      expect(disassembled?.sscc).toBe(sscc);

      // Force fresh allocations for the SAME (tenantId, issuerPrefix,
      // extensionDigit) -- enough of them to walk the counter well past the
      // one serial this now-disassembled box already burned.
      const next1 = await svc.allocate(tenantId, prefix, 0, deviceId, 20);
      const next2 = await svc.allocate(tenantId, prefix, 0, deviceId, 20);

      // Every block ever issued under this (tenant, prefix, extension
      // digit): the burned serial must be covered by exactly ONE of them --
      // the original block -- never a later one, which is what "the sscc
      // never reappears as any serial range" actually means at the
      // allocator's own level.
      const allBlocks = await db
        .select({ fromSerial: schema.ssccBlocks.fromSerial, toSerial: schema.ssccBlocks.toSerial })
        .from(schema.ssccBlocks)
        .where(
          and(
            eq(schema.ssccBlocks.tenantId, tenantId),
            eq(schema.ssccBlocks.issuerPrefix, prefix),
            eq(schema.ssccBlocks.extensionDigit, 0),
          ),
        );
      const coveringBlocks = allBlocks.filter(
        (b) => burnedSerial >= b.fromSerial && burnedSerial <= b.toSerial,
      );
      expect(coveringBlocks).toHaveLength(1);
      expect(coveringBlocks[0]!.fromSerial).toBe(block.fromSerial);
      expect(coveringBlocks[0]!.toSerial).toBe(block.toSerial);

      // Neither fresh block's own range covers the burned serial either --
      // the same fact, restated directly against the two new allocations.
      for (const fresh of [next1, next2]) {
        expect(burnedSerial < fresh.fromSerial || burnedSerial > fresh.toSerial).toBe(true);
      }

      // And no OTHER box -- disassembled or not -- was ever allowed to carry
      // this same sscc string: `boxes_tenant_sscc_uq` already enforces this
      // at the schema level, but the guarantee that matters here is
      // behavioural, so assert it directly.
      const boxesWithThisSscc = await db
        .select({ id: schema.boxes.id })
        .from(schema.boxes)
        .where(and(eq(schema.boxes.tenantId, tenantId), eq(schema.boxes.sscc, sscc)));
      expect(boxesWithThisSscc).toHaveLength(1);
      expect(boxesWithThisSscc[0]!.id).toBe(boxId);
    });
  });
});
