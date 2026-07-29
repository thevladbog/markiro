import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";
import { applyMigrations } from "../src/lib/mirror.js";
import { addRange, burnSerial, remaining } from "../src/lib/sscc-pool.js";
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
});
