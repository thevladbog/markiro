import { deriveDigestB64, PHC_ITERATIONS } from "@markiro/domain";
import { describe, expect, it, vi } from "vitest";
import type { CreateOrderDto } from "../src/api/types.js";
import {
  dequeueOrder,
  enqueueOrder,
  listQuarantine,
  listQueue,
  quarantineOrder,
  type QueuedOrder,
} from "../src/store/queue.js";
import { scrubStoredBadgeCodes } from "../src/store/scrub.js";

const SALT = "fwGrIt01vwgBxxDlhqLVRQ==";
const CODE = "BADGE-1";

const digestOf = (code: string) => deriveDigestB64(code, SALT, PHC_ITERATIONS);

/**
 * An order body as the PRE-DIGEST bundle wrote it — a plaintext badge code and
 * no digest. Cast because `CreateOrderDto` describes what today's app writes,
 * while IndexedDB holds whatever every past version wrote; that gap is exactly
 * what this module exists to close.
 */
const legacyBody = (deviceSeq: number, badgeCode = CODE): CreateOrderDto =>
  ({
    deviceSeq,
    badgeCode,
    reason: "buy",
    items: [{ rawKm: `01…${deviceSeq}` }],
    createdAt: "2026-07-29T09:00:00.000Z",
  }) as unknown as CreateOrderDto;

const currentBody = (deviceSeq: number, badgeDigest: string): CreateOrderDto => ({
  deviceSeq,
  badgeDigest,
  reason: "buy",
  items: [{ rawKm: `01…${deviceSeq}` }],
  createdAt: "2026-07-29T09:00:00.000Z",
});

/** The stored body, read back without pretending it matches today's type. */
const storedBody = (order: QueuedOrder) => order.body as unknown as Record<string, unknown>;

describe("scrubStoredBadgeCodes", () => {
  it("replaces a queued order's plaintext badge code with the digest the server now takes", async () => {
    await enqueueOrder(legacyBody(1), "e1");

    await expect(scrubStoredBadgeCodes(SALT)).resolves.toBe(1);

    const [queued] = await listQueue();
    expect(storedBody(queued!)).not.toHaveProperty("badgeCode");
    expect(storedBody(queued!).badgeDigest).toBe(await digestOf(CODE));
    // Everything else about the order survives — this is a rewrite of one
    // field, not a re-creation of the record, and the raw marking codes are
    // the only way anyone can tell which bottles the pickup was for.
    expect(storedBody(queued!).items).toEqual([{ rawKm: "01…1" }]);
    expect(queued!.employeeId).toBe("e1");
  });

  /**
   * The store that matters most. The queue eventually drains; nothing prunes
   * the quarantine, so a badge code parked there stays for the life of the
   * device — and `quarantineQueue` moves the WHOLE queue there when a token is
   * revoked, which is precisely when a device is likeliest to be sitting
   * unattended.
   */
  it("scrubs the quarantine store too, which nothing else ever clears", async () => {
    await quarantineOrder({
      deviceSeq: 7,
      employeeId: "e1",
      body: legacyBody(7),
      at: "2026-07-29T10:00:00.000Z",
      status: 422,
      message: "Unknown or inactive badge",
    });

    await expect(scrubStoredBadgeCodes(SALT)).resolves.toBe(1);

    const [parked] = await listQuarantine();
    expect(storedBody(parked!)).not.toHaveProperty("badgeCode");
    expect(storedBody(parked!).badgeDigest).toBe(await digestOf(CODE));
    // The refusal itself is untouched: this record is custody, not a queue
    // entry, and its verdict is why it is being kept.
    expect(parked!.status).toBe(422);
    expect(parked!.message).toBe("Unknown or inactive badge");
  });

  it("preserves an SSCC body and its bottle estimate while scrubbing the legacy badge", async () => {
    const body = {
      ...legacyBody(8),
      items: [],
      boxes: [{ sscc: "346006820000000021" }],
    };
    await enqueueOrder(body, "e1", "pending_attestation", 12);
    const before = (await listQueue())[0]!;

    await expect(scrubStoredBadgeCodes(SALT)).resolves.toBe(1);

    const after = (await listQueue())[0]!;
    expect(after.estimatedBottleCount).toBe(12);
    expect(after.body.boxes).toEqual(before.body.boxes);
    expect(after.body.items).toEqual([]);
    expect(storedBody(after)).not.toHaveProperty("badgeCode");
    expect(storedBody(after).badgeDigest).toBe(await digestOf(CODE));
    expect(storedBody(after)).not.toHaveProperty("members");
  });

  it("derives once per distinct badge, not once per order", async () => {
    for (const deviceSeq of [1, 2, 3]) await enqueueOrder(legacyBody(deviceSeq), "e1");
    await enqueueOrder(legacyBody(4, "BADGE-2"), "e2");

    const spy = vi.spyOn(crypto.subtle, "deriveBits");
    await expect(scrubStoredBadgeCodes(SALT)).resolves.toBe(4);
    // Two workers, four orders. PBKDF2 at 100000 iterations is ~50ms, and a
    // backlog is a whole outage's worth of orders — per-record derivation
    // would put that on the boot path in front of a worker.
    expect(spy).toHaveBeenCalledTimes(2);
    spy.mockRestore();
  });

  it("does nothing, and derives nothing, once every record has been migrated", async () => {
    await enqueueOrder(currentBody(1, await digestOf(CODE)), "e1");

    const spy = vi.spyOn(crypto.subtle, "deriveBits");
    await expect(scrubStoredBadgeCodes(SALT)).resolves.toBe(0);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it("is idempotent — a second boot rewrites nothing", async () => {
    await enqueueOrder(legacyBody(1), "e1");

    await expect(scrubStoredBadgeCodes(SALT)).resolves.toBe(1);
    await expect(scrubStoredBadgeCodes(SALT)).resolves.toBe(0);

    const [queued] = await listQueue();
    expect(storedBody(queued!).badgeDigest).toBe(await digestOf(CODE));
  });

  /**
   * A `put`-based rewrite would RE-CREATE a record the drain deleted while the
   * digest was being derived — resurrecting a delivered order under a
   * `deviceSeq` the server has already spent. The server answers a repeated
   * `(tenantId, kioskId, deviceSeq)` with the FIRST order rather than filing a
   * second, so the next worker's whole cart would evaporate and be confirmed
   * to them under a stranger's number. `updateEach` walks a cursor instead,
   * which visits only what is there when its transaction runs.
   *
   * The interleave is staged at the one point it can actually happen: the
   * async gap between reading the records and rewriting them, which is the
   * PBKDF2 derivation.
   */
  it("does not resurrect an order the drain removed while the digest was being derived", async () => {
    await enqueueOrder(legacyBody(1), "e1");
    await enqueueOrder(legacyBody(2), "e1");

    const realDeriveBits = crypto.subtle.deriveBits.bind(crypto.subtle);
    const spy = vi
      .spyOn(crypto.subtle, "deriveBits")
      .mockImplementation(async (...args: Parameters<typeof realDeriveBits>) => {
        await dequeueOrder(1); // the drain acknowledges order 1, mid-scrub
        return realDeriveBits(...args);
      });

    await scrubStoredBadgeCodes(SALT);
    spy.mockRestore();

    // Order 1 stays gone. Order 2 is still scrubbed — one delivered order must
    // not cost the rest of the queue its migration.
    expect((await listQueue()).map((order) => order.deviceSeq)).toEqual([2]);
    const [remaining] = await listQueue();
    expect(storedBody(remaining!)).not.toHaveProperty("badgeCode");
    expect(storedBody(remaining!).badgeDigest).toBe(await digestOf(CODE));
  });

  it("leaves an unreadable store alone and reports nothing rather than failing the boot", async () => {
    await enqueueOrder(legacyBody(1), "e1");
    const spy = vi.spyOn(crypto.subtle, "deriveBits").mockRejectedValue(new Error("no crypto"));

    // Never rejects: this runs in front of the screen a worker is standing at,
    // so a failure has to leave the device working and be retried next boot.
    await expect(scrubStoredBadgeCodes(SALT)).resolves.toBe(0);
    spy.mockRestore();

    // And the order is still queued, code and all — losing a pickup would be a
    // far worse outcome than carrying it one more boot.
    expect(await listQueue()).toHaveLength(1);
  });
});
