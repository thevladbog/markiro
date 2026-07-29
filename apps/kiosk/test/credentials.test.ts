import { deriveDigestB64, formatPhc, PHC_ITERATIONS } from "@markiro/domain";
import { describe, expect, it, vi } from "vitest";
import { buildBadgeIndex, resolveBadge } from "../src/credentials/badge.js";
import { verifyOperatorBadge, verifyOperatorPin } from "../src/credentials/operator.js";

const SALT = "fwGrIt01vwgBxxDlhqLVRQ==";

async function bootstrapWith(badges: Record<string, string>) {
  const employees = await Promise.all(
    Object.entries(badges).map(async ([id, code]) => ({
      id,
      fullName: id,
      role: null,
      badgeHash: formatPhc(PHC_ITERATIONS, SALT, await deriveDigestB64(code, SALT, PHC_ITERATIONS)),
    })),
  );
  return { badgeSalt: SALT, employees } as never;
}

describe("resolveBadge", () => {
  it("finds the employee behind a scanned badge", async () => {
    const bootstrap = await bootstrapWith({ e1: "BADGE-1", e2: "BADGE-2" });
    const index = buildBadgeIndex(bootstrap);
    await expect(resolveBadge("BADGE-2", bootstrap, index)).resolves.toMatchObject({
      employeeId: "e2",
    });
  });

  /**
   * The digest comes back out, because it is what the ORDER names the employee
   * by (`CreateOrderDto.badgeDigest`). An order body is written to IndexedDB
   * before it is ever sent, so the scanned code must not be what identifies
   * the worker in it — and this is the one place that has both, so it is the
   * one place that can hand the safe half onward.
   */
  it("returns the digest it matched on, so the caller never has to keep the scanned code", async () => {
    const bootstrap = await bootstrapWith({ e1: "BADGE-1" });
    const index = buildBadgeIndex(bootstrap);

    const match = await resolveBadge("BADGE-1", bootstrap, index);

    expect(match?.digest).toBe(await deriveDigestB64("BADGE-1", SALT, PHC_ITERATIONS));
    // The verifier the roster shipped, with the same digest in it — which is
    // what lets the server look this up without either end holding the code.
    expect(index.get(match!.digest)).toBe("e1");
    expect(match?.digest).not.toBe("BADGE-1");
  });

  it("returns null for an unknown badge", async () => {
    const bootstrap = await bootstrapWith({ e1: "BADGE-1" });
    await expect(resolveBadge("NOPE", bootstrap, buildBadgeIndex(bootstrap))).resolves.toBeNull();
  });

  it("costs ONE derivation regardless of roster size — a per-employee loop would take seconds on a full staff", async () => {
    const many: Record<string, string> = {};
    for (let i = 0; i < 50; i++) many[`e${i}`] = `BADGE-${i}`;
    const bootstrap = await bootstrapWith(many);
    const index = buildBadgeIndex(bootstrap);

    const spy = vi.spyOn(crypto.subtle, "deriveBits");
    await resolveBadge("BADGE-49", bootstrap, index);
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });
});

describe("buildBadgeIndex", () => {
  it("skips employees with no badgeHash instead of indexing a null", () => {
    const bootstrap = {
      badgeSalt: SALT,
      employees: [{ id: "e1", fullName: "e1", role: null, badgeHash: null }],
    } as never;
    expect(buildBadgeIndex(bootstrap).size).toBe(0);
  });
});

async function hashFor(secret: string): Promise<string> {
  return formatPhc(PHC_ITERATIONS, SALT, await deriveDigestB64(secret, SALT, PHC_ITERATIONS));
}

interface OperatorSeed {
  employeeId: string;
  login: string;
  pin: string;
  badge?: string;
  active?: boolean;
}

async function operatorBootstrap(seeds: OperatorSeed[]) {
  const operators = await Promise.all(
    seeds.map(async (seed) => ({
      employeeId: seed.employeeId,
      name: seed.employeeId,
      login: seed.login,
      role: "operator",
      pinHash: await hashFor(seed.pin),
      badgeHash: seed.badge === undefined ? null : await hashFor(seed.badge),
      active: seed.active ?? true,
    })),
  );
  return { badgeSalt: SALT, employees: [], operators } as never;
}

describe("verifyOperatorPin", () => {
  it("signs in the operator matching login, not merely a matching PIN", async () => {
    const bootstrap = await operatorBootstrap([
      { employeeId: "op-a", login: "1001", pin: "1234" },
      // Same PIN as op-a — a PIN-only lookup would return whichever row came first.
      { employeeId: "op-b", login: "1002", pin: "1234" },
    ]);
    await expect(verifyOperatorPin("1002", "1234", bootstrap)).resolves.toMatchObject({
      employeeId: "op-b",
    });
  });

  it("rejects a wrong PIN for a known login", async () => {
    const bootstrap = await operatorBootstrap([{ employeeId: "op-a", login: "1001", pin: "1234" }]);
    await expect(verifyOperatorPin("1001", "9999", bootstrap)).resolves.toBeNull();
  });

  it("rejects an unknown login", async () => {
    const bootstrap = await operatorBootstrap([{ employeeId: "op-a", login: "1001", pin: "1234" }]);
    await expect(verifyOperatorPin("9999", "1234", bootstrap)).resolves.toBeNull();
  });

  it("rejects an inactive operator even with the right PIN", async () => {
    const bootstrap = await operatorBootstrap([
      { employeeId: "op-a", login: "1001", pin: "1234", active: false },
    ]);
    await expect(verifyOperatorPin("1001", "1234", bootstrap)).resolves.toBeNull();
  });

  it("still performs a derivation when the login matches no operator (equal-work timing guard)", async () => {
    const bootstrap = await operatorBootstrap([{ employeeId: "op-a", login: "1001", pin: "1234" }]);
    const spy = vi.spyOn(crypto.subtle, "deriveBits");
    try {
      // "9999" matches no operator's login — a short-circuit implementation
      // would return before ever deriving anything, which is exactly the
      // timing side channel this guards against.
      const result = await verifyOperatorPin("9999", "0000", bootstrap);
      expect(result).toBeNull();
      expect(spy).toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });
});

describe("verifyOperatorBadge", () => {
  it("finds the active operator behind a scanned badge", async () => {
    const bootstrap = await operatorBootstrap([
      { employeeId: "op-a", login: "1001", pin: "1234", badge: "OPBADGE-1" },
    ]);
    await expect(verifyOperatorBadge("OPBADGE-1", bootstrap)).resolves.toMatchObject({
      employeeId: "op-a",
    });
  });

  it("returns null for an unknown badge", async () => {
    const bootstrap = await operatorBootstrap([
      { employeeId: "op-a", login: "1001", pin: "1234", badge: "OPBADGE-1" },
    ]);
    await expect(verifyOperatorBadge("NOPE", bootstrap)).resolves.toBeNull();
  });

  it("rejects an inactive operator's badge", async () => {
    const bootstrap = await operatorBootstrap([
      { employeeId: "op-a", login: "1001", pin: "1234", badge: "OPBADGE-1", active: false },
    ]);
    await expect(verifyOperatorBadge("OPBADGE-1", bootstrap)).resolves.toBeNull();
  });

  it("costs ONE derivation regardless of operator roster size", async () => {
    const seeds: OperatorSeed[] = [];
    for (let i = 0; i < 20; i++) {
      seeds.push({ employeeId: `op-${i}`, login: `100${i}`, pin: "1234", badge: `OPBADGE-${i}` });
    }
    const bootstrap = await operatorBootstrap(seeds);

    const spy = vi.spyOn(crypto.subtle, "deriveBits");
    await verifyOperatorBadge("OPBADGE-19", bootstrap);
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });
});
