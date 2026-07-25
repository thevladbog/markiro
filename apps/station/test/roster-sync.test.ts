import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import { applyMigrations, readOperatorsMirror, type SqlExecutor } from "../src/lib/mirror.js";
import { syncOperatorRoster } from "../src/lib/roster-sync.js";

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

const OPERATOR = {
  operatorId: "op-1",
  name: "Смирнов А.",
  login: "1042",
  role: "operator",
  pinHash: "pbkdf2$sha256$100000$c2FsdA==$aGFzaA==",
  badgeHash: null,
  active: true,
};

describe("syncOperatorRoster", () => {
  it("pulls the roster into the mirror before any sign-in", async () => {
    const exec = makeExec();
    await applyMigrations(exec);
    const get = vi.fn().mockResolvedValue({ items: [OPERATOR] });

    await syncOperatorRoster({ get }, exec);

    expect(get).toHaveBeenCalledWith("/station/operators");
    const rows = await readOperatorsMirror(exec);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ operatorId: "op-1", login: "1042" });
  });

  it("replaces the previous set so a removed operator stops authenticating", async () => {
    const exec = makeExec();
    await applyMigrations(exec);
    await syncOperatorRoster(
      {
        get: vi
          .fn()
          .mockResolvedValue({
            items: [OPERATOR, { ...OPERATOR, operatorId: "op-2", login: "1043" }],
          }),
      },
      exec,
    );
    expect(await readOperatorsMirror(exec)).toHaveLength(2);

    await syncOperatorRoster({ get: vi.fn().mockResolvedValue({ items: [OPERATOR] }) }, exec);
    const rows = await readOperatorsMirror(exec);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.operatorId).toBe("op-1");
  });

  it("never throws when offline — the device keeps its cached roster", async () => {
    const exec = makeExec();
    await applyMigrations(exec);
    await syncOperatorRoster({ get: vi.fn().mockResolvedValue({ items: [OPERATOR] }) }, exec);

    await expect(
      syncOperatorRoster({ get: vi.fn().mockRejectedValue(new Error("offline")) }, exec),
    ).resolves.toBeUndefined();
    expect(await readOperatorsMirror(exec)).toHaveLength(1);
  });
});
