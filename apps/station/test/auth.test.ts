import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import { applyMigrations, replaceOperatorsMirror, type SqlExecutor } from "../src/lib/mirror.js";
import * as crypto from "../src/lib/crypto.js";
import { hashSecret } from "../src/lib/crypto.js";
import { verifyOperatorBadge, verifyOperatorPin } from "../src/lib/auth.js";

function makeExec(): SqlExecutor {
  const db = new DatabaseSync(":memory:");
  return {
    run: async (sql, params = []) => {
      db.prepare(sql).run(...(params as never[]));
    },
    all: async <T>(sql: string, params: unknown[] = []) =>
      db.prepare(sql).all(...(params as never[])) as T[],
  };
}

describe("operator auth (login + PIN)", () => {
  it("signs in the operator whose personnel number matches, not merely a matching PIN", async () => {
    const exec = makeExec();
    await applyMigrations(exec);
    const sharedPin = await hashSecret("1234");
    await replaceOperatorsMirror(exec, [
      {
        operatorId: "op-a",
        name: "Первый",
        login: "1001",
        role: "operator",
        pinHash: sharedPin,
        badgeHash: null,
        active: true,
      },
      {
        operatorId: "op-b",
        name: "Второй",
        login: "1002",
        role: "operator",
        // Same PIN as op-a — a PIN-only lookup would return whichever row came first.
        pinHash: await hashSecret("1234"),
        badgeHash: null,
        active: true,
      },
    ]);

    expect((await verifyOperatorPin(exec, "1002", "1234"))?.operatorId).toBe("op-b");
    expect(await verifyOperatorPin(exec, "1002", "9999")).toBeNull();
    expect(await verifyOperatorPin(exec, "9999", "1234")).toBeNull();
  });

  it("refuses an inactive operator and a malformed PIN", async () => {
    const exec = makeExec();
    await applyMigrations(exec);
    await replaceOperatorsMirror(exec, [
      {
        operatorId: "op-c",
        name: "Уволен",
        login: "2001",
        role: "operator",
        pinHash: await hashSecret("4321"),
        badgeHash: null,
        active: false,
      },
    ]);

    expect(await verifyOperatorPin(exec, "2001", "4321")).toBeNull();
    expect(await verifyOperatorPin(exec, "2001", "12")).toBeNull();
  });

  it("still signs in by badge without a personnel number", async () => {
    const exec = makeExec();
    await applyMigrations(exec);
    await replaceOperatorsMirror(exec, [
      {
        operatorId: "op-d",
        name: "Бейдж",
        login: "3001",
        role: "operator",
        pinHash: await hashSecret("1111"),
        badgeHash: await hashSecret("BADGE-77"),
        active: true,
      },
    ]);

    expect((await verifyOperatorBadge(exec, "BADGE-77"))?.operatorId).toBe("op-d");
    expect(await verifyOperatorBadge(exec, "BADGE-00")).toBeNull();
  });

  it("still performs a crypto verification when the login matches no operator (equal-work timing guard)", async () => {
    const exec = makeExec();
    await applyMigrations(exec);
    await replaceOperatorsMirror(exec, [
      {
        operatorId: "op-e",
        name: "Существующий",
        login: "5001",
        role: "operator",
        pinHash: await hashSecret("6789"),
        badgeHash: null,
        active: true,
      },
    ]);

    const verifyPinSpy = vi.spyOn(crypto, "verifyPin");
    try {
      // "9999" matches no operator's login at all — a short-circuit implementation
      // would return before ever calling verifyPin, which is exactly the timing
      // side channel this guards against.
      const result = await verifyOperatorPin(exec, "9999", "6789");
      expect(result).toBeNull();
      expect(verifyPinSpy).toHaveBeenCalled();
    } finally {
      verifyPinSpy.mockRestore();
    }
  });
});
