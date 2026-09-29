import { readFileSync } from "node:fs";

import { deriveDigestB64, formatPhc, parsePhc, PHC_ITERATIONS, verifyPhc } from "@markiro/domain";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  BADGE_ITERATIONS,
  hashBadge,
  hashPin,
  isBadgePhc,
  isPinPhc,
  MAX_PHC_ITERATIONS,
  MIN_PHC_ITERATIONS,
} from "../src/lib/credentials.js";

// See test/protocol.test.ts: bind import.meta.url before building the URL.
const testModuleUrl = import.meta.url;

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(new URL(`../proto/fixtures/${name}`, testModuleUrl), "utf8"));
}

/** A string field of a fixture object, asserted rather than cast. */
function field(name: string, key: string): string {
  const value: unknown = (fixture(name) as Record<string, unknown>)[key];
  if (typeof value !== "string") throw new Error(`${name} has no string ${key}`);
  return value;
}

/** `badge-salt.json`: the site's badge salt, as the office reads it. */
const SITE_SALT = field("badge-salt.json", "badgeSalt");
/** `badge-create.json`: the badge «MRK-000742» hashed with `SITE_SALT`. */
const BADGE_PHC = field("badge-create.json", "badgePhc");
/** `operator-create.json`: the PIN 4821 with the salt bytes of «markiro-pin-salt». */
const PIN_PHC = field("operator-create.json", "pinPhc");

describe("operator credentials", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("pins the badge iteration count at the host's 100 000, the domain's PHC_ITERATIONS", () => {
    expect(BADGE_ITERATIONS).toBe(100_000);
    expect(BADGE_ITERATIONS).toBe(PHC_ITERATIONS);
    expect(parsePhc(BADGE_PHC)?.iterations).toBe(BADGE_ITERATIONS);
    expect(parsePhc(BADGE_PHC)?.saltB64).toBe(SITE_SALT);
  });

  it("hashes a badge code with the site's salt into the host's fixture, as the cloud does", async () => {
    await expect(hashBadge("MRK-000742", SITE_SALT)).resolves.toBe(BADGE_PHC);
    // The cloud's `hashBadgeWithSalt`, written out.
    const cloud = formatPhc(
      PHC_ITERATIONS,
      SITE_SALT,
      await deriveDigestB64("MRK-000742", SITE_SALT, PHC_ITERATIONS),
    );
    expect(cloud).toBe(BADGE_PHC);
  });

  it("hashes the code it is given as it is: no trimming, no case folding", async () => {
    const plain = await hashBadge("MRK-000742", SITE_SALT);
    await expect(hashBadge(" MRK-000742 ", SITE_SALT)).resolves.not.toBe(plain);
    await expect(hashBadge("mrk-000742", SITE_SALT)).resolves.not.toBe(plain);
  });

  it("hashes a PIN with 16 random salt bytes into the domain's format", async () => {
    const salt = new TextEncoder().encode("markiro-pin-salt");
    vi.spyOn(crypto, "getRandomValues").mockImplementation(
      <T extends ArrayBufferView | null>(array: T): T => {
        if (array instanceof Uint8Array) array.set(salt);
        return array;
      },
    );
    await expect(hashPin("4821")).resolves.toBe(PIN_PHC);
  });

  it("gives every PIN hash a fresh salt, in standard base64 with padding", async () => {
    const first = await hashPin("4821");
    const second = await hashPin("4821");
    expect(first).not.toBe(second);
    for (const phc of [first, second]) {
      expect(phc).toMatch(/^pbkdf2\$sha256\$100000\$[A-Za-z0-9+/]{22}==\$[A-Za-z0-9+/]{43}=$/);
      await expect(verifyPhc("4821", phc)).resolves.toBe(true);
      await expect(verifyPhc("4822", phc)).resolves.toBe(false);
    }
  });
});

describe("hashes a station can use", () => {
  /** `PIN_PHC` with its count written as `count`. */
  function pinWith(count: string): string {
    return PIN_PHC.replace("$100000$", `$${count}$`);
  }

  it("takes a PIN hash of 10 000 to 1 000 000 iterations, written as the host writes it", () => {
    expect([MIN_PHC_ITERATIONS, MAX_PHC_ITERATIONS]).toEqual([10_000, 1_000_000]);
    for (const count of ["10000", "100000", "1000000"]) {
      expect(isPinPhc(pinWith(count))).toBe(true);
    }
    // `parsePhc` reads the last four as 100 000; the host never writes them.
    for (const count of ["9999", "1000001", "0100000", "1e5", " 100000", "100000.0"]) {
      expect(isPinPhc(pinWith(count))).toBe(false);
    }
    expect(isPinPhc("4821")).toBe(false);
  });

  it("takes a badge hash with exactly BADGE_ITERATIONS, written as the host writes it", () => {
    expect(isBadgePhc(BADGE_PHC)).toBe(true);
    for (const count of ["10000", "200000", "0100000", "1e5"]) {
      expect(isBadgePhc(BADGE_PHC.replace("$100000$", `$${count}$`))).toBe(false);
    }
    expect(isBadgePhc(BADGE_PHC.replace("AAECAwQFBgcICQoLDA0ODw==", "AAECAwQFBgc="))).toBe(false);
  });
});
