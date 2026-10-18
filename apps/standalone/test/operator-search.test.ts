import { describe, expect, it } from "vitest";

import {
  nameQueryLetters,
  normalizeOperatorName,
  searchOperatorsByName,
  type RosterEntry,
} from "../src/floor/operator-search.js";
import { readOperatorRoster } from "../src/floor/sign-in.js";
import type { ChangeItem } from "../src/host/protocol.js";
import { syncReferences } from "../src/local/reference-sync.js";
import { DEVICE_ID, HOST_ID } from "./support/fixtures.js";
import { openLocalDb } from "./support/local-db.js";

const ANNA = "8a3c1f0e-2b4d-4e6f-9a1b-3c5d7e9f1a2b";
const BORIS = "3c4d5e6f-7a8b-4c9d-8e0f-1a2b3c4d5e6f";
const PAIRING = { hostId: HOST_ID, deviceId: DEVICE_ID };
/** The PIN 4821 under a fixed salt (`proto/fixtures`). */
const PIN_PHC =
  "pbkdf2$sha256$100000$bWFya2lyby1waW4tc2FsdA==$3OKvrZ2+EfTB2zsCso90r5g8c6Ib6t+Bv+cGJOpgPmU=";

function entry(id: string, name: string, login: string): RosterEntry {
  return { id, name, login };
}

function operatorItem(id: string, login: string, name: string): ChangeItem {
  return {
    entity: "operators",
    id,
    rev: 5,
    deleted: false,
    data: { login, name, role: null, pinPhc: PIN_PHC },
  };
}

describe("the operator name search", () => {
  it("folds case and runs of spaces, and waits for two letters", () => {
    const roster = [entry("op-1", "Анна   Смирнова", "101")];
    expect(normalizeOperatorName("  АННА   см ")).toBe("анна см");
    expect(nameQueryLetters(" а1 2")).toBe(1);
    expect(searchOperatorsByName(roster, "а")).toEqual([]);
    expect(searchOperatorsByName(roster, "а 1")).toEqual([]);
    expect(searchOperatorsByName(roster, "  АН ")).toEqual([
      { id: "op-1", name: "Анна   Смирнова", login: "101" },
    ]);
  });

  it("offers at most five names, by name and then id", () => {
    const roster = [
      entry("op-6", "Alex Z", "106"),
      entry("op-3", "Alex C", "103"),
      entry("op-2b", "Alex B", "112"),
      entry("op-2a", "Alex B", "102"),
      entry("op-1", "Alex A", "101"),
      entry("op-4", "Alex D", "104"),
    ];
    expect(searchOperatorsByName(roster, "al").map((found) => found.id)).toEqual([
      "op-1",
      "op-2a",
      "op-2b",
      "op-3",
      "op-4",
    ]);
  });

  it("matches the words in order and skips a number the keypad could not type", () => {
    const roster = [
      entry("op-1", "Смирнов Алексей", "123"),
      entry("op-2", "Смирнова Алёна", "000123"),
      entry("op-3", "Алексей Смирнов", "124"),
      entry("op-4", "Смирнов Алексей", "12"),
    ];
    expect(searchOperatorsByName(roster, "см ал")).toEqual([
      { id: "op-1", name: "Смирнов Алексей", login: "123" },
      { id: "op-2", name: "Смирнова Алёна", login: "000123" },
    ]);
    // The middle of a word counts: «ирн» is in «Смирнов».
    expect(searchOperatorsByName(roster, "ирн").map((found) => found.id)).toEqual([
      "op-3",
      "op-1",
      "op-2",
    ]);
  });

  it("returns identity only, whatever else the entries carry", () => {
    const withHash = { ...entry("op-1", "Анна Кузнецова", "0042"), pinPhc: PIN_PHC };
    const roster: RosterEntry[] = [withHash];
    const [found] = searchOperatorsByName(roster, "ан");
    expect(found).toEqual({ id: "op-1", login: "0042", name: "Анна Кузнецова" });
    expect(Object.keys(found ?? {}).sort()).toEqual(["id", "login", "name"]);
  });
});

describe("the roster the name search reads", () => {
  async function synced(items: ChangeItem[]) {
    const { db, executor } = openLocalDb();
    await syncReferences({
      changes: async () => ({ hostId: HOST_ID, rev: 10, hasMore: false, items }),
      local: executor,
      ...PAIRING,
    });
    return { db, context: { local: executor, pairing: PAIRING, now: () => 0 } };
  }

  it("lists this pairing's operators without their hashes, and none waiting in quarantine", async () => {
    const { db, context } = await synced([
      operatorItem(ANNA, "0042", "Анна Кузнецова"),
      operatorItem(BORIS, "0077", "Борис Петров"),
    ]);
    db.prepare(
      "INSERT INTO sync_quarantine (entity, id, rev, reason, seen_at) " +
        "VALUES ('operators', ?, 9, 'data: unrecognized_keys', 1790000000000)",
    ).run(BORIS);
    const roster = await readOperatorRoster(context);
    expect(roster).toEqual([{ id: ANNA, login: "0042", name: "Анна Кузнецова" }]);
    expect(JSON.stringify(roster)).not.toContain("pbkdf2");
  });

  it("reads nothing from copies that are not this pairing's", async () => {
    const { db, context } = await synced([operatorItem(ANNA, "0042", "Анна Кузнецова")]);
    expect(
      await readOperatorRoster({ ...context, pairing: { hostId: HOST_ID, deviceId: BORIS } }),
    ).toBeNull();
    db.prepare("DELETE FROM sync_state").run();
    expect(await readOperatorRoster(context)).toBeNull();
  });
});
