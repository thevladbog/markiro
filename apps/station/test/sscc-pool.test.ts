import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";
import { applyMigrations } from "../src/lib/mirror.js";
import { addRange, burnSerial, dropRanges, remaining } from "../src/lib/sscc-pool.js";
import { makeExec } from "./support/sqlite-exec.js";

// A 9-digit GS1 issuer prefix -- see mirror.ts's StationBundle.sscc doc
// comment for why the pool is keyed by prefix rather than by GLN.
const ISSUER_PREFIX = "460123456";

describe("sscc pool", () => {
  let exec: ReturnType<typeof makeExec>;
  beforeEach(async () => {
    exec = makeExec(new DatabaseSync(":memory:"));
    await applyMigrations(exec);
  });

  it("returns null when the pool is empty", async () => {
    expect(await burnSerial(exec, ISSUER_PREFIX, 0)).toBeNull();
  });

  it("skips unused serial zero in a legacy box block", async () => {
    await addRange(exec, {
      issuerPrefix: ISSUER_PREFIX,
      extensionDigit: 0,
      fromSerial: 0,
      toSerial: 3,
      consumedThroughSerial: null,
    });
    expect(await burnSerial(exec, ISSUER_PREFIX, 0)).toBe(1);
  });

  it("keeps a server-known consumed cursor ahead of the box minimum", async () => {
    await addRange(exec, {
      issuerPrefix: ISSUER_PREFIX,
      extensionDigit: 0,
      fromSerial: 0,
      toSerial: 9,
      consumedThroughSerial: 4,
    });
    expect(await burnSerial(exec, ISSUER_PREFIX, 0)).toBe(5);
  });

  it("does not apply the box minimum to another extension digit", async () => {
    await addRange(exec, {
      issuerPrefix: ISSUER_PREFIX,
      extensionDigit: 1,
      fromSerial: 0,
      toSerial: 2,
    });
    expect(await burnSerial(exec, ISSUER_PREFIX, 1)).toBe(0);
  });

  it("burns serials in ascending order", async () => {
    await addRange(exec, {
      issuerPrefix: ISSUER_PREFIX,
      extensionDigit: 0,
      fromSerial: 10,
      toSerial: 12,
    });
    expect(await burnSerial(exec, ISSUER_PREFIX, 0)).toBe(10);
    expect(await burnSerial(exec, ISSUER_PREFIX, 0)).toBe(11);
    expect(await burnSerial(exec, ISSUER_PREFIX, 0)).toBe(12);
    expect(await burnSerial(exec, ISSUER_PREFIX, 0)).toBeNull();
  });

  it("moves on to a later non-adjacent range once the first is spent", async () => {
    await addRange(exec, {
      issuerPrefix: ISSUER_PREFIX,
      extensionDigit: 0,
      fromSerial: 10,
      toSerial: 10,
    });
    await addRange(exec, {
      issuerPrefix: ISSUER_PREFIX,
      extensionDigit: 0,
      fromSerial: 90,
      toSerial: 91,
    });
    expect(await burnSerial(exec, ISSUER_PREFIX, 0)).toBe(10);
    expect(await burnSerial(exec, ISSUER_PREFIX, 0)).toBe(90);
  });

  it("keeps issuers apart", async () => {
    await addRange(exec, {
      issuerPrefix: ISSUER_PREFIX,
      extensionDigit: 0,
      fromSerial: 10,
      toSerial: 11,
    });
    expect(await burnSerial(exec, "460999999", 0)).toBeNull();
    expect(await remaining(exec, ISSUER_PREFIX, 0)).toBe(2);
  });

  it("keeps extension digits apart", async () => {
    await addRange(exec, {
      issuerPrefix: ISSUER_PREFIX,
      extensionDigit: 0,
      fromSerial: 10,
      toSerial: 11,
    });
    expect(await burnSerial(exec, ISSUER_PREFIX, 1)).toBeNull();
  });

  it("never reissues a serial when two burns race", async () => {
    await addRange(exec, {
      issuerPrefix: ISSUER_PREFIX,
      extensionDigit: 0,
      fromSerial: 10,
      toSerial: 19,
    });
    const got = await Promise.all(
      Array.from({ length: 10 }, () => burnSerial(exec, ISSUER_PREFIX, 0)),
    );
    expect(new Set(got).size).toBe(10);
  });

  it("counts what is left across ranges", async () => {
    await addRange(exec, {
      issuerPrefix: ISSUER_PREFIX,
      extensionDigit: 0,
      fromSerial: 1,
      toSerial: 3,
    });
    await addRange(exec, {
      issuerPrefix: ISSUER_PREFIX,
      extensionDigit: 0,
      fromSerial: 7,
      toSerial: 8,
    });
    await burnSerial(exec, ISSUER_PREFIX, 0);
    expect(await remaining(exec, ISSUER_PREFIX, 0)).toBe(4);
  });

  it("ignores a duplicate range so a replayed bundle cannot double the pool", async () => {
    const r = { issuerPrefix: ISSUER_PREFIX, extensionDigit: 0, fromSerial: 1, toSerial: 3 };
    await addRange(exec, r);
    await addRange(exec, r);
    expect(await remaining(exec, ISSUER_PREFIX, 0)).toBe(3);
  });

  it("does not reset progress when a bundle replays after serials were already burned", async () => {
    const r = { issuerPrefix: ISSUER_PREFIX, extensionDigit: 0, fromSerial: 1, toSerial: 3 };
    await addRange(exec, r);
    expect(await burnSerial(exec, ISSUER_PREFIX, 0)).toBe(1);
    // The device re-downloads the same bundle (e.g. after a dropped ack).
    // The already-burned serial must stay burned.
    await addRange(exec, r);
    expect(await burnSerial(exec, ISSUER_PREFIX, 0)).toBe(2);
    expect(await remaining(exec, ISSUER_PREFIX, 0)).toBe(1);
  });

  it("still counts a range down to its very last serial", async () => {
    await addRange(exec, {
      issuerPrefix: ISSUER_PREFIX,
      extensionDigit: 0,
      fromSerial: 5,
      toSerial: 5,
    });
    expect(await remaining(exec, ISSUER_PREFIX, 0)).toBe(1);
  });

  it("does not let remaining() count another issuer's or extension digit's stock", async () => {
    await addRange(exec, {
      issuerPrefix: ISSUER_PREFIX,
      extensionDigit: 0,
      fromSerial: 1,
      toSerial: 3,
    });
    expect(await remaining(exec, "460999999", 0)).toBe(0);
    expect(await remaining(exec, ISSUER_PREFIX, 1)).toBe(0);
  });

  // Final review, finding 1. The server now always reports a block's
  // ORIGINAL fromSerial/toSerial, even for a block the device already
  // holds, plus a `consumedThroughSerial` cursor -- never a range shrunk to
  // the unconsumed remainder (that shape doesn't match the existing row's
  // primary key, so it used to insert as a SECOND, overlapping row, and
  // `burnSerial`'s ORDER BY from_serial would drain the original row then
  // restart the second one from its own from_serial, reissuing every
  // serial in between). These two tests are the device-side half of that
  // fix: `addRange` must reconcile the SAME row rather than duplicate it.
  describe("reconciling a re-sent block against progress already made (final review, finding 1)", () => {
    it("recovers a device that lost its local database entirely, without reissuing already-consumed serials", async () => {
      const full = { issuerPrefix: ISSUER_PREFIX, extensionDigit: 0, fromSerial: 0, toSerial: 9 };
      await addRange(exec, full);
      expect(await burnSerial(exec, ISSUER_PREFIX, 0)).toBe(1);
      expect(await burnSerial(exec, ISSUER_PREFIX, 0)).toBe(2);

      // The device's local database is lost outright (factory reset, a
      // corrupted store) -- its sscc_pool row for this block is gone, even
      // though the server's sscc_blocks row (and consumedThroughSerial)
      // survives untouched.
      await exec.run(
        "DELETE FROM sscc_pool WHERE issuer_prefix = ? AND extension_digit = ? AND from_serial = ?",
        [full.issuerPrefix, full.extensionDigit, full.fromSerial],
      );

      // Re-provisioning fetches the bundle again: the server hands back
      // this SAME block's original bounds plus consumedThroughSerial: 2 --
      // not a fresh range starting at fromSerial.
      await addRange(exec, { ...full, consumedThroughSerial: 2 });

      const seen: number[] = [];
      for (;;) {
        const serial = await burnSerial(exec, ISSUER_PREFIX, 0);
        if (serial === null) break;
        seen.push(serial);
      }
      // Never 1 or 2 again -- those are already on printed labels. Serial 0
      // remains unused under the box allocation policy.
      expect(seen).toEqual([3, 4, 5, 6, 7, 8, 9]);
      expect(new Set(seen).size).toBe(seen.length);
    });

    it("fast-forwards a stale but still-present local cursor instead of leaving it regressed", async () => {
      const full = { issuerPrefix: ISSUER_PREFIX, extensionDigit: 0, fromSerial: 0, toSerial: 9 };
      await addRange(exec, full);
      expect(await burnSerial(exec, ISSUER_PREFIX, 0)).toBe(1);
      expect(await burnSerial(exec, ISSUER_PREFIX, 0)).toBe(2);

      // The device's local database is restored from a stale snapshot (a
      // crash recovery, a restored backup) that still holds this exact row
      // but has forgotten the two burns above -- next_serial regresses to
      // fromSerial even though serials 1-2 are already on printed labels.
      await exec.run(
        "UPDATE sscc_pool SET next_serial = ? WHERE issuer_prefix = ? AND extension_digit = ? AND from_serial = ?",
        [full.fromSerial, full.issuerPrefix, full.extensionDigit, full.fromSerial],
      );

      // The next bundle fetch hands back the SAME original range plus the
      // server's consumedThroughSerial (final review, finding 1) -- what
      // this device already told the server it burned. `addRange` must use
      // it to fast-forward the stale local cursor, not leave it regressed.
      await addRange(exec, { ...full, consumedThroughSerial: 2 });

      const seen: number[] = [];
      for (;;) {
        const serial = await burnSerial(exec, ISSUER_PREFIX, 0);
        if (serial === null) break;
        seen.push(serial);
      }
      expect(seen).toEqual([3, 4, 5, 6, 7, 8, 9]);
      expect(new Set(seen).size).toBe(seen.length);
    });
  });

  it("drops a revoked range so burning moves to the replacement block", async () => {
    await addRange(exec, {
      issuerPrefix: ISSUER_PREFIX,
      extensionDigit: 0,
      fromSerial: 1,
      toSerial: 2000,
      consumedThroughSerial: 10,
    });
    await addRange(exec, {
      issuerPrefix: ISSUER_PREFIX,
      extensionDigit: 0,
      fromSerial: 5000,
      toSerial: 6999,
      consumedThroughSerial: null,
    });
    // burnSerial takes the LOWEST from_serial, so the revoked block wins
    // until it is actually deleted -- this is the whole reason dropRanges
    // exists rather than just adding the new range.
    expect(await burnSerial(exec, ISSUER_PREFIX, 0)).toBe(11);

    await dropRanges(exec, ISSUER_PREFIX, 0, [1]);
    expect(await burnSerial(exec, ISSUER_PREFIX, 0)).toBe(5000);
  });

  it("ignores an empty revocation list and a range it does not hold", async () => {
    await addRange(exec, {
      issuerPrefix: ISSUER_PREFIX,
      extensionDigit: 0,
      fromSerial: 1,
      toSerial: 9,
      consumedThroughSerial: null,
    });
    await dropRanges(exec, ISSUER_PREFIX, 0, []);
    await dropRanges(exec, ISSUER_PREFIX, 0, [12345]);
    expect(await remaining(exec, ISSUER_PREFIX, 0)).toBe(9);
  });

  it("does not drop the same from_serial under another extension digit", async () => {
    await addRange(exec, {
      issuerPrefix: ISSUER_PREFIX,
      extensionDigit: 1,
      fromSerial: 1,
      toSerial: 9,
      consumedThroughSerial: null,
    });
    await dropRanges(exec, ISSUER_PREFIX, 0, [1]);
    expect(await remaining(exec, ISSUER_PREFIX, 1)).toBe(9);
  });
});
