import { randomUUID } from "node:crypto";
import express from "express";
import { Test } from "@nestjs/testing";
import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AppModule } from "../src/app.module";
import { mountAuth, setupAuth, type AuthSetup } from "../src/auth/auth.setup";
import { loadEnv } from "../src/env";
import type { ScanItemDto } from "../src/modules/station-scans/dto";
import { listenOnLoopback } from "./support/listen-loopback";
import { signUpAndActivate } from "./support/auth";

const ready = Boolean(
  process.env.DATABASE_URL && process.env.BETTER_AUTH_SECRET && process.env.BETTER_AUTH_URL,
);

/**
 * Task 14: the per-shift box list in the cabinet (`GET /boxes?shiftId=`).
 * All fixtures are built through the same `/station/scans` ingest path Task
 * 10/13's box-membership suite exercises directly (station-scans.e2e.test.ts)
 * -- there is no other way to create a `boxes`/`box_items` row -- so this
 * file never touches the database directly.
 *
 * Fixtures are built ONCE in `beforeAll` and every `it` below is a read-only
 * assertion against them; nothing here mutates shared state, so sharing them
 * across tests (rather than a fresh tenant per test, as conflicts.e2e.test.ts
 * does) is safe and keeps each scenario's setup in one place.
 */
describe.skipIf(!ready)("boxes e2e", () => {
  let app: INestApplication | undefined;
  let setup: AuthSetup;

  let agent: ReturnType<typeof request.agent>;
  let stationKey: string;
  /** A box with two live items, neither ever displaced. */
  let shiftId: string;
  /**
   * A box that CLOSED first, and only afterwards had its sole item's
   * ownership claimed by an earlier-scanned rival elsewhere -- the exact
   * "one position short" scenario `contentsChangedAfterClose` exists for
   * (see BoxesService.listBoxes).
   */
  let displacedShiftId: string;
  /**
   * A box whose sole item was displaced while the box was still open
   * (`closedAt` stays null throughout) -- guards against a query that flags
   * ANY displaced item regardless of `closed_at`, rather than only one
   * displaced strictly after closing.
   */
  let openShiftId: string;
  /** A second tenant's shift, to prove the list never crosses tenants. */
  let otherTenantShiftId: string;
  /**
   * A box closed with a client-supplied `closedAt` far in the FUTURE --
   * simulating a fast device clock (CodeRabbit PR33 review, Finding 7) --
   * whose sole item is THEN displaced (server-assigned `displacedAt`, a
   * real "now()" that is, by construction, well BEHIND that fake future
   * `closedAt`). The old `displacedAt > closedAt` comparison would read
   * this as "changed before closing" (false) purely because the client's
   * clock lied, even though the contents genuinely changed after the
   * physical close.
   */
  let futureClockShiftId: string;
  /** The employee behind displacedShiftId's box b2 closure, for the field-mapping test below. */
  let operatorId: string;
  /** Shared product every shift above opens against (see the beforeAll comment below). */
  let productId: string;

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

    agent = request.agent(app!.getHttpServer());
    await signUpAndActivate(agent);
    stationKey = await deviceKey(agent);
    // One product for every shift below: `openShift`'s own `createActiveProduct`
    // call would otherwise re-POST the same GTIN under the same tenant on
    // every invocation and 409 -- a single shared product is fine since
    // multiple shifts can share one product (see conflicts.e2e.test.ts's
    // `openShiftForProduct(agent, productId)` reuse for the same reason).
    productId = await createActiveProduct(agent);
    // A real `employees` row: `boxes.operator_id` carries a composite tenant
    // FK to it (see station-scans.e2e.test.ts's box-membership describe
    // block), so a non-null operatorId that doesn't resolve to one would
    // 23503 the closure batch below.
    const operatorRes = await agent
      .post("/employees")
      .send({ fullName: "Operator One" })
      .expect(201);
    operatorId = (operatorRes.body as { id: string }).id;

    // shiftId: two clean items in one box, nothing displaced.
    shiftId = await openShiftForProduct(agent, productId);
    await postBatch(stationKey, [
      scan(shiftId, "aa", "t1", "2026-07-01T10:00:00.000Z", "b1"),
      scan(shiftId, "bb", "t1", "2026-07-01T10:00:01.000Z", "b1"),
    ]);

    // displacedShiftId: box b2 closes first (closedAt well in the past),
    // THEN a rival scan elsewhere claims "dd" with an earlier scannedAt,
    // retroactively marking b2's own item displaced at the real "now()" --
    // strictly after closedAt.
    displacedShiftId = await openShiftForProduct(agent, productId);
    await postBatch(stationKey, [
      scan(displacedShiftId, "dd", "t1", "2026-07-01T10:00:00.000Z", "b2"),
    ]);
    await postBatch(
      stationKey,
      [],
      [
        {
          boxId: "b2",
          shiftId: displacedShiftId,
          terminalId: "t1",
          sscc: "123456789012345675",
          closedAt: "2026-01-01T00:00:00.000Z",
          operatorId,
        },
      ],
    );
    await postBatch(stationKey, [
      scan(displacedShiftId, "dd", "t2", "2026-07-01T09:00:00.000Z", null),
    ]);

    // openShiftId: box b3's item is displaced (an earlier rival scan of the
    // same code wins ownership) while b3 is still open -- no closure is ever
    // posted for it.
    openShiftId = await openShiftForProduct(agent, productId);
    await postBatch(stationKey, [scan(openShiftId, "oo", "t1", "2026-07-01T10:00:05.000Z", "b3")]);
    await postBatch(stationKey, [scan(openShiftId, "oo", "t2", "2026-07-01T10:00:00.000Z", null)]);

    // futureClockShiftId: box b4 closes with closedAt set far in the future
    // (a fast device clock), THEN a rival scan elsewhere claims "ff" with an
    // earlier scannedAt, retroactively marking b4's own item displaced at
    // the real "now()" -- which is nowhere near closedAt's fake future
    // value, but IS strictly after the server's own closureReceivedAt.
    futureClockShiftId = await openShiftForProduct(agent, productId);
    await postBatch(stationKey, [
      scan(futureClockShiftId, "ff", "t1", "2026-07-01T10:00:00.000Z", "b4"),
    ]);
    await postBatch(
      stationKey,
      [],
      [
        {
          boxId: "b4",
          shiftId: futureClockShiftId,
          terminalId: "t1",
          sscc: "123456789012345683",
          closedAt: "2099-01-01T00:00:00.000Z",
          operatorId,
        },
      ],
    );
    await postBatch(stationKey, [
      scan(futureClockShiftId, "ff", "t2", "2026-07-01T09:00:00.000Z", null),
    ]);

    // otherTenantShiftId: a second tenant entirely, with its own box.
    const other = request.agent(app!.getHttpServer());
    await signUpAndActivate(other);
    const otherKey = await deviceKey(other);
    otherTenantShiftId = await openShift(other);
    await postBatch(otherKey, [
      scan(otherTenantShiftId, "zz", "t1", "2026-07-01T10:00:00.000Z", "b9"),
    ]);
  });

  afterAll(async () => {
    await app?.close();
  });

  async function deviceKey(a: ReturnType<typeof request.agent>): Promise<string> {
    const device = await a.post("/station-devices").send({ name: "Line 1" }).expect(201);
    return (device.body as { apiKey: string }).apiKey;
  }

  // Same fixture as conflicts.e2e.test.ts / station-scans.e2e.test.ts.
  const VALID_GTIN14 = "04006381333931";

  async function createActiveProduct(a: ReturnType<typeof request.agent>): Promise<string> {
    const product = await a
      .post("/products")
      .send({
        name: "Cola",
        gtin: VALID_GTIN14,
        productGroup: "Beverages",
        boxCapacity: 10,
        palletCapacity: 5,
      })
      .expect(201);
    return (product.body as { id: string }).id;
  }

  async function openShiftForProduct(
    a: ReturnType<typeof request.agent>,
    productId: string,
  ): Promise<string> {
    const shift = await a.post("/shifts").send({ productId, mode: "validation" }).expect(201);
    const id = (shift.body as { id: string }).id;
    await a.post(`/shifts/${id}/open`).expect(200);
    return id;
  }

  async function openShift(a: ReturnType<typeof request.agent>): Promise<string> {
    const pid = await createActiveProduct(a);
    return openShiftForProduct(a, pid);
  }

  function scan(
    shiftId: string,
    codeLabel: string,
    terminalId: string,
    scannedAt: string,
    boxId: string | null,
  ): ScanItemDto {
    return {
      shiftId,
      terminalId,
      raw: `RAW-${codeLabel}`,
      verdict: "ok",
      scannedAt,
      code: { codeHash: codeLabel.padEnd(64, "0"), gtin14: VALID_GTIN14, serial: `S-${codeLabel}` },
      boxId,
      operatorId: null,
    };
  }

  interface ClosureFixture {
    boxId: string;
    shiftId: string;
    terminalId: string | null;
    sscc: string;
    closedAt: string;
    operatorId: string | null;
  }

  async function postBatch(apiKey: string, items: ScanItemDto[], boxes: ClosureFixture[] = []) {
    return request(app!.getHttpServer())
      .post("/station/scans")
      .set("x-api-key", apiKey)
      .send({ batchId: `boxes-batch-${randomUUID()}`, items, boxes })
      .expect(201);
  }

  it("lists a shift's boxes with a live item count", async () => {
    const res = await agent.get(`/boxes?shiftId=${shiftId}`).expect(200);
    expect(res.body.items[0].itemCount).toBe(2);
  });

  it("excludes displaced items from the count", async () => {
    const res = await agent.get(`/boxes?shiftId=${displacedShiftId}`).expect(200);
    expect(res.body.items[0].itemCount).toBe(0);
  });

  it("flags a box whose contents changed after it closed", async () => {
    const res = await agent.get(`/boxes?shiftId=${displacedShiftId}`).expect(200);
    expect(res.body.items[0].contentsChangedAfterClose).toBe(true);
  });

  // None of the brief's own assertions distinguish `sscc` from `terminalId`
  // from `operatorId` from `closedAt` -- each is a DIFFERENT, distinguishable
  // value here, so a `toDto`/`select` mapping bug that swapped two of these
  // columns (or read the wrong one) would fail this test even though it
  // would pass every assertion above unnoticed.
  it("maps the box's own sscc, terminal, operator, and closing time onto the DTO", async () => {
    const res = await agent.get(`/boxes?shiftId=${displacedShiftId}`).expect(200);
    const box = res.body.items[0];
    expect(box.sscc).toBe("123456789012345675");
    expect(box.terminalId).toBe("t1");
    expect(box.operatorId).toBe(operatorId);
    expect(box.closedAt).toBe("2026-01-01T00:00:00.000Z");
  });

  // CodeRabbit PR33 review, Finding 7: `contentsChangedAfterClose` used to
  // compare the server-assigned `displacedAt` against the CLIENT-supplied
  // `closedAt` -- a device timestamp with no clock-skew bound at all
  // (unlike scan items, closures have no `assertScannedAtWithinWindow`
  // -style check). A fast device clock could therefore make this flag
  // report `false` for a box whose contents genuinely changed after the
  // physical close, purely because the client's clock lied about when that
  // was. The fix compares against `closureReceivedAt` (server-assigned
  // `now()` at ingest) instead, so this must still correctly report `true`
  // even though `closedAt` itself sits decades in the future.
  it(
    "still reports contentsChangedAfterClose: true for a fast device clock's far-future " +
      "closedAt, because the comparison uses the server-assigned receipt time (Finding 7)",
    async () => {
      const res = await agent.get(`/boxes?shiftId=${futureClockShiftId}`).expect(200);
      expect(res.body.items[0].closedAt).toBe("2099-01-01T00:00:00.000Z");
      expect(res.body.items[0].contentsChangedAfterClose).toBe(true);
    },
  );

  it("does not flag a box displaced before it closed", async () => {
    const res = await agent.get(`/boxes?shiftId=${openShiftId}`).expect(200);
    expect(res.body.items[0].contentsChangedAfterClose).toBe(false);
  });

  it("rejects a station api-key", async () => {
    await request(app!.getHttpServer())
      .get(`/boxes?shiftId=${shiftId}`)
      .set("x-api-key", stationKey)
      .expect(403);
  });

  it("does not list another tenant's boxes", async () => {
    const res = await agent.get(`/boxes?shiftId=${otherTenantShiftId}`).expect(200);
    expect(res.body.items).toEqual([]);
  });

  // Task 7: `itemCount`'s aggregate used to exclude only displaced items
  // (`filter (where displaced_at is null)`) -- a box item an operator
  // removed via an "undo"/"clear" exception (`removed_at`, station-scans
  // .service.ts's applyExceptions) was NOT displaced, so the old filter
  // still counted it, overstating how many items the box actually holds.
  // A dedicated shift/box, not the shared `shiftId` fixture above: mutating
  // that box's own item via an exception here would retroactively change
  // the "lists a shift's boxes with a live item count" test's own
  // itemCount === 2 assertion (this describe's own doc comment: fixtures
  // are built once in beforeAll and every `it` is meant to be a READ-ONLY
  // assertion against them).
  it("excludes operator-removed items from itemCount and surfaces disassembledAt", async () => {
    const removedShiftId = await openShiftForProduct(agent, productId);
    await postBatch(stationKey, [
      scan(removedShiftId, "rr", "t1", "2026-07-01T10:00:00.000Z", "b5"),
      scan(removedShiftId, "ss", "t1", "2026-07-01T10:00:01.000Z", "b5"),
    ]);
    await request(app!.getHttpServer())
      .post("/station/scans")
      .set("x-api-key", stationKey)
      .send({
        batchId: `undo-batch-${randomUUID()}`,
        items: [],
        boxes: [],
        exceptions: [
          {
            kind: "undo",
            boxId: "b5",
            codeHash: "rr".padEnd(64, "0"),
            shiftId: removedShiftId,
            terminalId: "t1",
            operatorId: null,
            reason: null,
            occurredAt: new Date().toISOString(),
          },
        ],
      })
      .expect(201);

    const res = await agent.get(`/boxes?shiftId=${removedShiftId}`).expect(200);
    const box = res.body.items[0];
    // Only "ss" remains live -- "rr" was removed by the undo exception. A
    // filter matching only `displaced_at is null` (the pre-Task-7 aggregate)
    // would still count "rr", since undo never touches displaced_at.
    expect(box.itemCount).toBe(1);
    expect(box.disassembledAt).toBeNull();
  });
});
