import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import { applyMigrations, readOperatorsMirror, type SqlExecutor } from "../src/lib/mirror.js";
import { createOperatorRosterRefresher, syncOperatorRoster } from "../src/lib/roster-sync.js";
import {
  clearRejectedCredentialState,
  createCredentialGeneration,
  sealCredentialGeneration,
} from "../src/lib/credential-recovery.js";

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

    await expect(syncOperatorRoster({ get }, exec)).resolves.toBe("updated");

    expect(get).toHaveBeenCalledWith("/station/operators");
    const rows = await readOperatorsMirror(exec);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ operatorId: "op-1", login: "1042" });
  });

  it("replaces the previous set so a removed operator stops authenticating", async () => {
    const exec = makeExec();
    await applyMigrations(exec);
    await expect(
      syncOperatorRoster(
        {
          get: vi.fn().mockResolvedValue({
            items: [OPERATOR, { ...OPERATOR, operatorId: "op-2", login: "1043" }],
          }),
        },
        exec,
      ),
    ).resolves.toBe("updated");
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
    ).resolves.toBe("unavailable");
    expect(await readOperatorsMirror(exec)).toHaveLength(1);
  });

  it("coalesces concurrent refresh callers onto one request", async () => {
    const exec = makeExec();
    await applyMigrations(exec);
    let resolve!: (value: { items: (typeof OPERATOR)[] }) => void;
    const getCalls = vi.fn();
    const get = <T>(_path: string) => {
      getCalls();
      return new Promise<T>((done) => {
        resolve = (value) => done(value as T);
      });
    };
    const refresh = createOperatorRosterRefresher({ get }, exec, createCredentialGeneration());

    const first = refresh();
    const second = refresh();

    expect(getCalls).toHaveBeenCalledTimes(1);
    resolve({ items: [OPERATOR] });
    await expect(Promise.all([first, second])).resolves.toEqual(["updated", "updated"]);
  });

  it("cannot publish a roster GET that resolves after credential cleanup", async () => {
    const exec = makeExec();
    await applyMigrations(exec);
    let resolveGet!: (value: { items: (typeof OPERATOR)[] }) => void;
    const response = new Promise<{ items: (typeof OPERATOR)[] }>((resolve) => {
      resolveGet = resolve;
    });
    const generation = createCredentialGeneration();
    const late = syncOperatorRoster({ get: vi.fn().mockReturnValue(response) }, exec, generation);

    await sealCredentialGeneration(generation);
    await clearRejectedCredentialState({ exec, clearCredential: async () => {} });
    resolveGet({ items: [OPERATOR] });
    await late;

    expect(await readOperatorsMirror(exec)).toEqual([]);
  });

  it("cannot replace a newly provisioned roster when an old GET resolves late", async () => {
    const exec = makeExec();
    await applyMigrations(exec);
    let resolveOld!: (value: { items: (typeof OPERATOR)[] }) => void;
    const oldResponse = new Promise<{ items: (typeof OPERATOR)[] }>((resolve) => {
      resolveOld = resolve;
    });
    const oldGeneration = createCredentialGeneration();
    const late = syncOperatorRoster(
      { get: vi.fn().mockReturnValue(oldResponse) },
      exec,
      oldGeneration,
    );
    await sealCredentialGeneration(oldGeneration);
    await clearRejectedCredentialState({ exec, clearCredential: async () => {} });

    const fresh = { ...OPERATOR, operatorId: "op-fresh", login: "900" };
    await syncOperatorRoster(
      { get: vi.fn().mockResolvedValue({ items: [fresh] }) },
      exec,
      createCredentialGeneration(),
    );
    resolveOld({ items: [OPERATOR] });
    await late;

    expect(await readOperatorsMirror(exec)).toEqual([fresh]);
  });
});
