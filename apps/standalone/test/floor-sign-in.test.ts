import type { DatabaseSync } from "node:sqlite";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { deriveDigestB64, formatPhc, parsePhc, PHC_ITERATIONS, verifyPhc } from "@markiro/domain";
import type * as MarkiroDomain from "@markiro/domain";

import { STATION_QUIET_MS } from "../src/floor/lockout.js";
import {
  DUMMY_PIN_PHC,
  readBadgeScan,
  readFloorReadiness,
  signInWithBadge,
  signInWithPin,
  type SignInContext,
} from "../src/floor/sign-in.js";
import type { ChangeItem } from "../src/host/protocol.js";
import { hashBadge, hashPin, isPinPhc } from "../src/lib/credentials.js";
import type * as Credentials from "../src/lib/credentials.js";
import { LocalDbError, type LocalExecutor } from "../src/local/executor.js";
import { syncReferences } from "../src/local/reference-sync.js";
import { DEVICE_ID, HOST_ID } from "./support/fixtures.js";
import { openLocalDb } from "./support/local-db.js";

// Spies that call through: the real PBKDF2 still runs, the tests count it and
// see which hash it was given (the work an attempt costs is what keeps the
// answer's time from telling a known personnel number from an unknown one).
vi.mock("@markiro/domain", async (importOriginal) => {
  const actual = await importOriginal<typeof MarkiroDomain>();
  return { ...actual, verifyPhc: vi.fn(actual.verifyPhc) };
});
vi.mock("../src/lib/credentials.js", async (importOriginal) => {
  const actual = await importOriginal<typeof Credentials>();
  return { ...actual, hashBadge: vi.fn(actual.hashBadge) };
});

const ANNA = "8a3c1f0e-2b4d-4e6f-9a1b-3c5d7e9f1a2b";
const BORIS = "3c4d5e6f-7a8b-4c9d-8e0f-1a2b3c4d5e6f";
const PASS_7 = "c4e2a1b3-5d6f-4a8b-9c0d-1e2f3a4b5c6d";
const PASS_8 = "e7f6d5c4-b3a2-4918-8a7b-6c5d4e3f2a19";
/** The PIN 4821 and the badge «MRK-000742» under `SITE`'s salt, as the office hashed them (`proto/fixtures`). */
const PIN_PHC =
  "pbkdf2$sha256$100000$bWFya2lyby1waW4tc2FsdA==$3OKvrZ2+EfTB2zsCso90r5g8c6Ib6t+Bv+cGJOpgPmU=";
const BADGE_PHC =
  "pbkdf2$sha256$100000$AAECAwQFBgcICQoLDA0ODw==$LEcu0ewwRD5rBHrpCjvxni/q2cURiavbRlNRgDPb+n0=";
const BADGE_CODE = "MRK-000742";
const PAIRING = { hostId: HOST_ID, deviceId: DEVICE_ID };
/** This computer's clock in the tests: the lockouts read it. */
const NOW = 1_790_000_000_000;

const SITE: ChangeItem = {
  entity: "site",
  id: "1",
  rev: 1,
  deleted: false,
  data: { badgeSalt: "AAECAwQFBgcICQoLDA0ODw==", boxBlockSize: 2000, palletBlockSize: 200 },
};

function operator(id: string, rev: number, login: string, data: object = {}): ChangeItem {
  return {
    entity: "operators",
    id,
    rev,
    deleted: false,
    data: { login, name: "Анна Кузнецова", role: "Упаковщик", pinPhc: PIN_PHC, ...data },
  };
}

function badge(id: string, rev: number, operatorId: string): ChangeItem {
  return {
    entity: "operator_badges",
    id,
    rev,
    deleted: false,
    data: { operatorId, badgePhc: BADGE_PHC, label: null },
  };
}

const ANNA_SIGNED_IN = {
  kind: "signed_in",
  operator: { id: ANNA, login: "0042", name: "Анна Кузнецова", role: "Упаковщик" },
};

/** This pairing's copies after one complete sync of `items`. */
async function synced(
  items: ChangeItem[],
  rev = 10,
): Promise<{
  db: DatabaseSync;
  executor: LocalExecutor;
  context: SignInContext;
}> {
  const { db, executor } = openLocalDb();
  await syncReferences({
    changes: async () => ({ hostId: HOST_ID, rev, hasMore: false, items }),
    local: executor,
    ...PAIRING,
  });
  return { db, executor, context: { local: executor, pairing: PAIRING, now: () => NOW } };
}

describe("the station's PIN sign-in", () => {
  it("signs in the operator whose personnel number and PIN match their copy", async () => {
    const { context } = await synced([SITE, operator(ANNA, 5, "0042")]);
    expect(await signInWithPin(context, "0042", "4821")).toEqual(ANNA_SIGNED_IN);
  });

  it("refuses a wrong PIN and an unknown personnel number alike", async () => {
    const { context } = await synced([SITE, operator(ANNA, 5, "0042")]);
    expect(await signInWithPin(context, "0042", "1111")).toEqual({
      kind: "refused",
      reason: "wrong",
    });
    expect(await signInWithPin(context, "0043", "4821")).toEqual({
      kind: "refused",
      reason: "wrong",
    });
    // Leading zeros are part of the number: «42» is another number.
    expect(await signInWithPin(context, "042", "4821")).toEqual({
      kind: "refused",
      reason: "wrong",
    });
  });

  it("refuses a malformed personnel number or PIN before reading anything", async () => {
    const { context } = await synced([SITE, operator(ANNA, 5, "0042")]);
    for (const [login, pin] of [
      ["42", "4821"],
      ["0042", "482"],
      ["0042", "4821567"],
      ["0042", "48 1"],
      ["００４２", "4821"],
    ] as const) {
      expect(await signInWithPin(context, login, pin)).toEqual({
        kind: "refused",
        reason: "wrong",
      });
    }
  });

  it("verifies against the PIN copy the host sent last, not an earlier one", async () => {
    const { executor, context } = await synced([SITE, operator(ANNA, 5, "0042")]);
    const newPin = await hashPin("7305");
    await syncReferences({
      changes: async () => ({
        hostId: HOST_ID,
        rev: 11,
        hasMore: false,
        items: [operator(ANNA, 11, "0042", { pinPhc: newPin })],
      }),
      local: executor,
      ...PAIRING,
    });
    expect(await signInWithPin(context, "0042", "4821")).toEqual({
      kind: "refused",
      reason: "wrong",
    });
    expect(await signInWithPin(context, "0042", "7305")).toEqual(ANNA_SIGNED_IN);
  });

  it("refuses an operator the host turned off, once the tombstone reached the copies", async () => {
    const { executor, context } = await synced([SITE, operator(ANNA, 5, "0042")]);
    await syncReferences({
      changes: async () => ({
        hostId: HOST_ID,
        rev: 12,
        hasMore: false,
        items: [{ entity: "operators", id: ANNA, rev: 12, deleted: true }],
      }),
      local: executor,
      ...PAIRING,
    });
    expect(await signInWithPin(context, "0042", "4821")).toEqual({
      kind: "refused",
      reason: "wrong",
    });
  });

  it("fails closed for an operator whose newer record waits in quarantine", async () => {
    const { db, context } = await synced([SITE, operator(ANNA, 5, "0042")]);
    db.prepare(
      "INSERT INTO sync_quarantine (entity, id, rev, reason, seen_at) " +
        "VALUES ('operators', ?, 9, 'data: unrecognized_keys', 1790000000000)",
    ).run(ANNA);
    expect(await signInWithPin(context, "0042", "4821")).toEqual({
      kind: "refused",
      reason: "wrong",
    });
  });

  it("refuses a personnel number two copies share instead of choosing one", async () => {
    const { context } = await synced([
      SITE,
      operator(ANNA, 5, "0042"),
      operator(BORIS, 6, "0042", { name: "Борис Орлов" }),
    ]);
    expect(await signInWithPin(context, "0042", "4821")).toEqual({
      kind: "refused",
      reason: "ambiguous",
    });
  });

  it("reads nothing until this pairing's own copies are complete", async () => {
    const { db, context } = await synced([SITE, operator(ANNA, 5, "0042")]);
    // Copies of another pairing with the same host are not this pairing's.
    expect(
      await signInWithPin(
        { ...context, pairing: { hostId: HOST_ID, deviceId: BORIS } },
        "0042",
        "4821",
      ),
    ).toEqual({ kind: "refused", reason: "not_ready" });
    // A forget clears every table, `sync_state` included.
    db.prepare("DELETE FROM sync_state").run();
    expect(await signInWithPin(context, "0042", "4821")).toEqual({
      kind: "refused",
      reason: "not_ready",
    });
  });

  it("refuses when the operator's copy changed while the PIN was being verified", async () => {
    const { db, executor, context } = await synced([SITE, operator(ANNA, 5, "0042")]);
    // A sync lands between the verification and the read that follows it.
    const racing: LocalExecutor = {
      query: (sql, params, row) => {
        if (sql.startsWith("SELECT o.rev ")) {
          db.prepare("UPDATE ref_operators SET rev = 13 WHERE id = ?").run(ANNA);
        }
        return executor.query(sql, params, row);
      },
      transaction: (statements) => executor.transaction(statements),
    };
    expect(await signInWithPin({ ...context, local: racing }, "0042", "4821")).toEqual({
      kind: "refused",
      reason: "wrong",
    });
  });

  it("verifies an unknown personnel number against a dummy hash of the domain's work factor", () => {
    expect(isPinPhc(DUMMY_PIN_PHC)).toBe(true);
    expect(parsePhc(DUMMY_PIN_PHC)?.iterations).toBe(PHC_ITERATIONS);
  });
});

describe("the station's badge sign-in", () => {
  it("signs in the badge's operator: the trimmed scan hashed with the site's salt", async () => {
    const { context } = await synced([SITE, operator(ANNA, 5, "0042"), badge(PASS_7, 6, ANNA)]);
    expect(await signInWithBadge(context, BADGE_CODE)).toEqual(ANNA_SIGNED_IN);
    expect(await signInWithBadge(context, `  ${BADGE_CODE}\t`)).toEqual(ANNA_SIGNED_IN);
  });

  it("refuses an unknown badge and a badge whose operator has no copy", async () => {
    const { context } = await synced([SITE, badge(PASS_7, 6, ANNA)]);
    expect(await signInWithBadge(context, BADGE_CODE)).toEqual({
      kind: "refused",
      reason: "wrong",
    });
    expect(await signInWithBadge(context, "MRK-000743")).toEqual({
      kind: "refused",
      reason: "wrong",
    });
  });

  it("refuses a revoked badge once its tombstone reached the copies", async () => {
    const { executor, context } = await synced([
      SITE,
      operator(ANNA, 5, "0042"),
      badge(PASS_7, 6, ANNA),
    ]);
    await syncReferences({
      changes: async () => ({
        hostId: HOST_ID,
        rev: 12,
        hasMore: false,
        items: [{ entity: "operator_badges", id: PASS_7, rev: 12, deleted: true }],
      }),
      local: executor,
      ...PAIRING,
    });
    expect(await signInWithBadge(context, BADGE_CODE)).toEqual({
      kind: "refused",
      reason: "wrong",
    });
  });

  it("refuses a badge that matches two operators as ambiguous, never the first of them", async () => {
    const { context } = await synced([
      SITE,
      operator(ANNA, 5, "0042"),
      operator(BORIS, 6, "0099", { name: "Борис Орлов" }),
      badge(PASS_7, 7, ANNA),
      badge(PASS_8, 8, BORIS),
    ]);
    expect(await signInWithBadge(context, BADGE_CODE)).toEqual({
      kind: "refused",
      reason: "ambiguous",
    });
  });

  it("fails closed for a badge whose newer record waits in quarantine", async () => {
    const { db, context } = await synced([SITE, operator(ANNA, 5, "0042"), badge(PASS_7, 6, ANNA)]);
    db.prepare(
      "INSERT INTO sync_quarantine (entity, id, rev, reason, seen_at) " +
        "VALUES ('operator_badges', ?, 9, 'badgePhc: custom', 1790000000000)",
    ).run(PASS_7);
    expect(await signInWithBadge(context, BADGE_CODE)).toEqual({
      kind: "refused",
      reason: "wrong",
    });
  });

  it("reads nothing without this pairing's complete copies or without the site's salt", async () => {
    const { context } = await synced([operator(ANNA, 5, "0042"), badge(PASS_7, 6, ANNA)]);
    expect(await signInWithBadge(context, BADGE_CODE)).toEqual({
      kind: "refused",
      reason: "not_ready",
    });
    const other = { ...context, pairing: { hostId: HOST_ID, deviceId: BORIS } };
    expect(await signInWithBadge(other, BADGE_CODE)).toEqual({
      kind: "refused",
      reason: "not_ready",
    });
  });

  it("tells a product's code, a Cyrillic scan and a non-badge apart before hashing", () => {
    expect(readBadgeScan(" MRK-000742 ")).toEqual({ kind: "badge", code: BADGE_CODE });
    expect(readBadgeScan("0104600682000013215Abc\u001d91EE11")).toEqual({
      kind: "refused",
      reason: "product_code",
    });
    expect(readBadgeScan("ЬКЛ-000742")).toEqual({ kind: "refused", reason: "layout" });
    for (const raw of ["", "   ", "x".repeat(257), "MRK-№742", "MRK\u0007742"]) {
      expect(readBadgeScan(raw)).toEqual({ kind: "refused", reason: "not_badge" });
    }
    expect(readBadgeScan("x".repeat(256))).toEqual({ kind: "badge", code: "x".repeat(256) });
  });

  it("refuses those scans without signing anybody in", async () => {
    const { context } = await synced([SITE, operator(ANNA, 5, "0042"), badge(PASS_7, 6, ANNA)]);
    expect(await signInWithBadge(context, `${BADGE_CODE}\u001d`)).toEqual({
      kind: "refused",
      reason: "product_code",
    });
    expect(await signInWithBadge(context, "ЬКЛ-000742")).toEqual({
      kind: "refused",
      reason: "layout",
    });
  });
});

describe("the sign-in's lockouts", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function failures(db: DatabaseSync) {
    const sql = "SELECT key, failures, locked_at FROM floor_sign_in_failures ORDER BY key";
    return Array.from(db.prepare(sql).all(), (row) => ({ ...row }));
  }

  it("locks an operator's PIN after five wrong ones, answers the sixth without hashing, and keeps the badge working", async () => {
    const { db, context } = await synced([SITE, operator(ANNA, 5, "0042"), badge(PASS_7, 6, ANNA)]);
    for (let attempt = 1; attempt < 5; attempt += 1) {
      expect(await signInWithPin(context, "0042", "1111")).toEqual({
        kind: "refused",
        reason: "wrong",
      });
    }
    expect(await signInWithPin(context, "0042", "1111")).toEqual({
      kind: "locked",
      scope: "operator",
      remainingMs: 300_000,
    });
    const derive = vi.spyOn(crypto.subtle, "deriveBits");
    expect(await signInWithPin(context, "0042", "4821")).toEqual({
      kind: "locked",
      scope: "operator",
      remainingMs: 300_000,
    });
    expect(derive).not.toHaveBeenCalled();
    // Another credential: the badge still signs Anna in, and forgets her count, not the station's.
    expect(await signInWithBadge(context, BADGE_CODE)).toEqual(ANNA_SIGNED_IN);
    expect(failures(db)).toEqual([{ key: "station", failures: 5, locked_at: null }]);
  });

  it("pauses the whole station after ten failures of any kind, before hashing anything", async () => {
    const { db, context } = await synced([SITE, operator(ANNA, 5, "0042"), badge(PASS_7, 6, ANNA)]);
    let clock = NOW;
    const ticking = { ...context, now: () => clock };
    for (let attempt = 0; attempt < 9; attempt += 1) {
      clock += 1;
      const result =
        attempt % 2 === 0
          ? await signInWithPin(ticking, `00${50 + attempt}`, "4821")
          : await signInWithBadge(ticking, `MRK-${attempt}`);
      expect(result).toEqual({ kind: "refused", reason: "wrong" });
    }
    clock += 1;
    expect(await signInWithBadge(ticking, "MRK-999")).toEqual({
      kind: "locked",
      scope: "station",
      remainingMs: 60_000,
    });
    const derive = vi.spyOn(crypto.subtle, "deriveBits");
    clock += 30_000;
    expect(await signInWithPin(ticking, "0042", "4821")).toEqual({
      kind: "locked",
      scope: "station",
      remainingMs: 30_000,
    });
    expect(await signInWithBadge(ticking, BADGE_CODE)).toEqual({
      kind: "locked",
      scope: "station",
      remainingMs: 30_000,
    });
    expect(derive).not.toHaveBeenCalled();
    derive.mockRestore();

    clock += 30_000;
    expect(await signInWithPin(ticking, "0042", "4821")).toEqual(ANNA_SIGNED_IN);
    // The sign-in does not reset the station's count: the row of the lockout that ran out stays.
    expect(failures(db)).toEqual([{ key: "station", failures: 10, locked_at: NOW + 10 }]);
  });

  it("counts only guesses: not a malformed entry, a product's code, a Cyrillic scan or an ambiguous badge", async () => {
    const { db, context } = await synced([
      SITE,
      operator(ANNA, 5, "0042"),
      operator(BORIS, 6, "0099", { name: "Борис Орлов" }),
      badge(PASS_7, 7, ANNA),
      badge(PASS_8, 8, BORIS),
    ]);
    await signInWithPin(context, "42", "4821");
    await signInWithBadge(context, `${BADGE_CODE}\u001d`);
    await signInWithBadge(context, "ЬКЛ-000742");
    await signInWithBadge(context, "");
    await signInWithBadge(context, BADGE_CODE);
    expect(failures(db)).toEqual([]);
  });

  it("counts a wrong PIN against the station and the operator, an unknown number against the station only", async () => {
    const { db, context } = await synced([SITE, operator(ANNA, 5, "0042")]);
    await signInWithPin(context, "0042", "1111");
    await signInWithPin(context, "0043", "1111");
    expect(failures(db)).toEqual([
      { key: `operator:${ANNA}`, failures: 1, locked_at: null },
      { key: "station", failures: 2, locked_at: null },
    ]);
  });

  it("does not count a personnel number two copies share", async () => {
    const { db, context } = await synced([
      SITE,
      operator(ANNA, 5, "0042"),
      operator(BORIS, 6, "0042", { name: "Борис Орлов" }),
    ]);
    expect(await signInWithPin(context, "0042", "4821")).toEqual({
      kind: "refused",
      reason: "ambiguous",
    });
    expect(failures(db)).toEqual([]);
  });

  it("answers the station's lockout first when one attempt starts both", async () => {
    const { db, context } = await synced([SITE, operator(ANNA, 5, "0042")]);
    for (let attempt = 0; attempt < 4; attempt += 1) {
      await signInWithPin(context, "0042", "1111");
    }
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await signInWithBadge(context, `MRK-${attempt}`);
    }
    expect(await signInWithPin(context, "0042", "1111")).toEqual({
      kind: "locked",
      scope: "station",
      remainingMs: 60_000,
    });
    expect(failures(db)).toEqual([
      { key: `operator:${ANNA}`, failures: 5, locked_at: NOW },
      { key: "station", failures: 10, locked_at: NOW },
    ]);
  });

  it("locks one operator's PIN only, and another operator's sign-in leaves that lockout and counts alone", async () => {
    const { db, context } = await synced([
      SITE,
      operator(ANNA, 5, "0042"),
      operator(BORIS, 6, "0099", { name: "Борис Орлов" }),
    ]);
    await signInWithPin(context, "0099", "1111");
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await signInWithPin(context, "0042", "1111");
    }
    expect(await signInWithPin(context, "0042", "4821")).toEqual({
      kind: "locked",
      scope: "operator",
      remainingMs: 300_000,
    });
    expect(await signInWithPin(context, "0099", "4821")).toEqual({
      kind: "signed_in",
      operator: { id: BORIS, login: "0099", name: "Борис Орлов", role: "Упаковщик" },
    });
    expect(failures(db)).toEqual([
      { key: `operator:${ANNA}`, failures: 5, locked_at: NOW },
      { key: "station", failures: 6, locked_at: null },
    ]);
  });

  it("does not forget the station's failures at a sign-in, by PIN or by badge: an insider with a valid credential gains no guesses", async () => {
    const { db, context } = await synced([SITE, operator(ANNA, 5, "0042"), badge(PASS_7, 6, ANNA)]);
    let clock = NOW;
    const ticking = { ...context, now: () => clock };
    const wrong = async () => {
      clock += 1;
      return signInWithBadge(ticking, `MRK-${clock - NOW}`);
    };
    for (let attempt = 0; attempt < 5; attempt += 1) {
      expect(await wrong()).toEqual({ kind: "refused", reason: "wrong" });
    }
    expect(await signInWithPin(ticking, "0042", "4821")).toEqual(ANNA_SIGNED_IN);
    for (let attempt = 0; attempt < 4; attempt += 1) {
      expect(await wrong()).toEqual({ kind: "refused", reason: "wrong" });
    }
    expect(await signInWithBadge(ticking, BADGE_CODE)).toEqual(ANNA_SIGNED_IN);
    expect(failures(db)).toEqual([{ key: "station", failures: 9, locked_at: null }]);
    // The tenth failure since the first, whatever signed in between, pauses the station.
    expect(await wrong()).toEqual({ kind: "locked", scope: "station", remainingMs: 60_000 });
  });

  it("still counts a failure exactly one quiet interval after the last with the ones before it", async () => {
    const { db, context } = await synced([SITE]);
    let clock = NOW;
    const ticking = { ...context, now: () => clock };
    for (let attempt = 0; attempt < 9; attempt += 1) {
      clock += 1;
      await signInWithBadge(ticking, `MRK-${attempt}`);
    }
    clock += STATION_QUIET_MS;
    expect(await signInWithBadge(ticking, "MRK-9")).toEqual({
      kind: "locked",
      scope: "station",
      remainingMs: 60_000,
    });
    expect(failures(db)).toEqual([{ key: "station", failures: 10, locked_at: clock }]);
  });

  it("restarts the station's count when the last failure is older than the quiet interval", async () => {
    const { db, context } = await synced([SITE]);
    let clock = NOW;
    const ticking = { ...context, now: () => clock };
    for (let attempt = 0; attempt < 9; attempt += 1) {
      clock += 1;
      await signInWithBadge(ticking, `MRK-${attempt}`);
    }
    clock += STATION_QUIET_MS + 1;
    expect(await signInWithBadge(ticking, "MRK-9")).toEqual({ kind: "refused", reason: "wrong" });
    expect(failures(db)).toEqual([{ key: "station", failures: 1, locked_at: null }]);
  });

  it("answers a stack of simultaneous guesses one at a time: the lockout holds and later guesses are not hashed", async () => {
    const { db, context } = await synced([SITE, operator(ANNA, 5, "0042")]);
    const derive = vi.spyOn(crypto.subtle, "deriveBits");
    const results = await Promise.all(
      Array.from({ length: 12 }, (_, attempt) =>
        signInWithPin(context, `00${50 + attempt}`, "4821"),
      ),
    );
    expect(results).toEqual([
      ...Array.from({ length: 9 }, () => ({ kind: "refused", reason: "wrong" })),
      ...Array.from({ length: 3 }, () => ({
        kind: "locked",
        scope: "station",
        remainingMs: 60_000,
      })),
    ]);
    expect(derive).toHaveBeenCalledTimes(10);
    expect(failures(db)).toEqual([{ key: "station", failures: 10, locked_at: NOW }]);
  });

  it("gives no verdict it could not record, and a database error does not block the next attempt", async () => {
    const { db, executor } = await synced([SITE, operator(ANNA, 5, "0042")]);
    let broken: string | null = "INSERT INTO floor_sign_in_failures";
    const flaky: LocalExecutor = {
      query: (sql, params, row) => executor.query(sql, params, row),
      transaction: (statements) =>
        broken !== null && statements.some(({ sql }) => sql.startsWith(broken ?? ""))
          ? Promise.reject(new LocalDbError("statement_failed", "disk full"))
          : executor.transaction(statements),
    };
    const context = { local: flaky, pairing: PAIRING, now: () => NOW };
    // A wrong PIN whose failure cannot be counted is no "wrong": it throws.
    await expect(signInWithPin(context, "0042", "1111")).rejects.toBeInstanceOf(LocalDbError);
    expect(failures(db)).toEqual([]);
    // The next attempt is not left waiting behind it; a sign-in whose
    // forgetting of the failures cannot be written is no sign-in either.
    broken = "DELETE FROM floor_sign_in_failures";
    await expect(signInWithPin(context, "0042", "4821")).rejects.toBeInstanceOf(LocalDbError);
    broken = null;
    expect(await signInWithPin(context, "0042", "4821")).toEqual(ANNA_SIGNED_IN);
  });
});

describe("the sign-in's secrets", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("logs nothing, whether a sign-in succeeds or not", async () => {
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((method) =>
      vi.spyOn(console, method),
    );
    const { context } = await synced([SITE, operator(ANNA, 5, "0042"), badge(PASS_7, 6, ANNA)]);
    await signInWithPin(context, "0042", "4821");
    await signInWithPin(context, "0042", "1111");
    await signInWithBadge(context, BADGE_CODE);
    await signInWithBadge(context, "MRK-000743");
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  });
});

describe("the sign-in screen's readiness", () => {
  it("offers nothing before this pairing's copies, then counts the operators who may sign in", async () => {
    const { executor } = openLocalDb();
    expect(await readFloorReadiness({ local: executor, pairing: PAIRING, now: () => NOW })).toEqual(
      {
        kind: "not_ready",
      },
    );
    const { db, context } = await synced([
      SITE,
      operator(ANNA, 5, "0042"),
      operator(BORIS, 6, "0099"),
    ]);
    expect(await readFloorReadiness(context)).toEqual({ kind: "ready", operators: 2 });
    db.prepare(
      "INSERT INTO sync_quarantine (entity, id, rev, reason, seen_at) " +
        "VALUES ('operators', ?, 9, 'data: unrecognized_keys', 1790000000000)",
    ).run(BORIS);
    expect(await readFloorReadiness(context)).toEqual({ kind: "ready", operators: 1 });
  });
});

// Guards the plan's tests above do not reach on their own: each block names
// the one-line change of `sign-in.ts` it exists to catch.

const SALT = "bWFya2lyby1waW4tc2FsdA==";

/** The executor, counting the statements it was asked to read. */
function counted(executor: LocalExecutor): { local: LocalExecutor; sql: string[] } {
  const sql: string[] = [];
  return {
    sql,
    local: {
      query: (text, params, row) => {
        sql.push(text);
        return executor.query(text, params, row);
      },
      transaction: (statements) => executor.transaction(statements),
    },
  };
}

/** The executor, running `effect` once right after the first read whose SQL holds `marker`. */
function afterRead(executor: LocalExecutor, marker: string, effect: () => void): LocalExecutor {
  let fired = false;
  return {
    query: async (sql, params, row) => {
      const rows = await executor.query(sql, params, row);
      if (!fired && sql.includes(marker)) {
        fired = true;
        effect();
      }
      return rows;
    },
    transaction: (statements) => executor.transaction(statements),
  };
}

const PIN_READ = "o.pin_phc";
const BADGE_READ = "ref_operator_badges AS b";

describe("the PIN sign-in's work and guards", () => {
  beforeEach(() => {
    vi.mocked(verifyPhc).mockClear();
    vi.mocked(hashBadge).mockClear();
  });

  it("verifies the typed PIN against the copy's hash once, and nothing else", async () => {
    const { context } = await synced([SITE, operator(ANNA, 5, "0042")]);
    await signInWithPin(context, "0042", "1111");
    expect(vi.mocked(verifyPhc).mock.calls).toEqual([["1111", PIN_PHC]]);
  });

  it("still pays one PBKDF2, against the dummy hash, when no copy can match", async () => {
    const { db, context } = await synced([
      SITE,
      operator(ANNA, 5, "0042"),
      operator(BORIS, 6, "0099", { name: "Борис Орлов" }),
      operator("5b6c7d8e-9f0a-4b1c-8d2e-3f4a5b6c7d8e", 7, "0099"),
      operator("6c7d8e9f-0a1b-4c2d-9e3f-4a5b6c7d8e9f", 8, "0077"),
    ]);
    // 0043: unknown. 0099: two copies. 0077: quarantined newer record.
    db.prepare(
      "INSERT INTO sync_quarantine (entity, id, rev, reason, seen_at) " +
        "VALUES ('operators', '6c7d8e9f-0a1b-4c2d-9e3f-4a5b6c7d8e9f', 9, 'x', 1790000000000)",
    ).run();
    for (const login of ["0043", "0099", "0077"]) {
      vi.mocked(verifyPhc).mockClear();
      await signInWithPin(context, login, "4821");
      expect(vi.mocked(verifyPhc).mock.calls, login).toEqual([["4821", DUMMY_PIN_PHC]]);
    }
  });

  it("does not take a hash the sync would not have accepted, even for the right PIN", async () => {
    const { db, context } = await synced([SITE, operator(ANNA, 5, "0042")]);
    const weak = formatPhc(1, SALT, await deriveDigestB64("4821", SALT, 1));
    db.prepare("UPDATE ref_operators SET pin_phc = ? WHERE id = ?").run(weak, ANNA);
    vi.mocked(verifyPhc).mockClear();
    expect(await signInWithPin(context, "0042", "4821")).toEqual({
      kind: "refused",
      reason: "wrong",
    });
    expect(vi.mocked(verifyPhc).mock.calls).toEqual([["4821", DUMMY_PIN_PHC]]);
  });

  it("verifies exactly the personnel numbers of 3-12 digits and the PINs of 4-6", async () => {
    const { context } = await synced([SITE, operator(ANNA, 5, "0042")]);
    const cases: Array<[string, string, boolean]> = [
      ["042", "4821", true],
      ["42", "4821", false],
      ["123456789012", "4821", true],
      ["1234567890123", "4821", false],
      ["0042", "4821", true],
      ["0042", "123456", true],
      ["0042", "482", false],
      ["0042", "1234567", false],
      ["0042", "", false],
      ["", "4821", false],
      ["004a", "4821", false],
      ["0042", "48a1", false],
      ["0042", "4821\n", false],
      ["0042\n", "4821", false],
      ["００４２", "4821", false],
      ["0042", "４８２１", false],
    ];
    for (const [login, pin, verified] of cases) {
      const reads = counted(context.local);
      vi.mocked(verifyPhc).mockClear();
      const result = await signInWithPin({ ...context, local: reads.local }, login, pin);
      expect(vi.mocked(verifyPhc).mock.calls.length, `${login}/${pin}`).toBe(verified ? 1 : 0);
      if (!verified) {
        expect(result).toEqual({ kind: "refused", reason: "wrong" });
        expect(reads.sql, `${login}/${pin}`).toEqual([]);
      }
    }
  });

  it("verifies nothing while this pairing's copies are not complete", async () => {
    const { context } = await synced([SITE, operator(ANNA, 5, "0042")]);
    const reads = counted(context.local);
    const other = { ...context, local: reads.local, pairing: { hostId: HOST_ID, deviceId: BORIS } };
    expect(await signInWithPin(other, "0042", "4821")).toEqual({
      kind: "refused",
      reason: "not_ready",
    });
    expect(vi.mocked(verifyPhc)).not.toHaveBeenCalled();
    expect(reads.sql).toHaveLength(1);
    expect(reads.sql[0]).toContain("FROM sync_state");
  });

  it("is not stopped by another entity's quarantine record that shares the id", async () => {
    const { db, context } = await synced([SITE, operator(ANNA, 5, "0042")]);
    db.prepare(
      "INSERT INTO sync_quarantine (entity, id, rev, reason, seen_at) " +
        "VALUES ('operator_badges', ?, 9, 'x', 1790000000000)",
    ).run(ANNA);
    expect(await signInWithPin(context, "0042", "4821")).toEqual(ANNA_SIGNED_IN);
  });

  it("refuses when the copies stopped being this pairing's while the PIN was verified", async () => {
    const { db, context } = await synced([SITE, operator(ANNA, 5, "0042")]);
    const repaired = afterRead(context.local, PIN_READ, () => {
      db.prepare("DELETE FROM sync_state").run();
    });
    expect(await signInWithPin({ ...context, local: repaired }, "0042", "4821")).toEqual({
      kind: "refused",
      reason: "not_ready",
    });
  });

  it("refuses an operator the host turned off while the PIN was verified", async () => {
    const { db, context } = await synced([SITE, operator(ANNA, 5, "0042")]);
    const raced = afterRead(context.local, PIN_READ, () => {
      db.prepare("DELETE FROM ref_operators WHERE id = ?").run(ANNA);
    });
    expect(await signInWithPin({ ...context, local: raced }, "0042", "4821")).toEqual({
      kind: "refused",
      reason: "wrong",
    });
  });

  it("refuses an operator whose record went to quarantine while the PIN was verified", async () => {
    const { db, context } = await synced([SITE, operator(ANNA, 5, "0042")]);
    const raced = afterRead(context.local, PIN_READ, () => {
      db.prepare(
        "INSERT INTO sync_quarantine (entity, id, rev, reason, seen_at) " +
          "VALUES ('operators', ?, 9, 'x', 1790000000000)",
      ).run(ANNA);
    });
    expect(await signInWithPin({ ...context, local: raced }, "0042", "4821")).toEqual({
      kind: "refused",
      reason: "wrong",
    });
  });

  it("refuses the old PIN when the host rotated it while the old one was verified", async () => {
    const { db, context } = await synced([SITE, operator(ANNA, 5, "0042")]);
    const newPin = await hashPin("7305");
    const raced = afterRead(context.local, PIN_READ, () => {
      db.prepare("UPDATE ref_operators SET pin_phc = ?, rev = 11 WHERE id = ?").run(newPin, ANNA);
    });
    expect(await signInWithPin({ ...context, local: raced }, "0042", "4821")).toEqual({
      kind: "refused",
      reason: "wrong",
    });
  });
});

describe("the badge sign-in's work and guards", () => {
  beforeEach(() => {
    vi.mocked(verifyPhc).mockClear();
    vi.mocked(hashBadge).mockClear();
  });

  it("hashes the trimmed code once with the site's salt", async () => {
    const { context } = await synced([SITE, operator(ANNA, 5, "0042"), badge(PASS_7, 6, ANNA)]);
    expect(await signInWithBadge(context, `\t ${BADGE_CODE}\r\n`)).toEqual(ANNA_SIGNED_IN);
    expect(vi.mocked(hashBadge).mock.calls).toEqual([[BADGE_CODE, "AAECAwQFBgcICQoLDA0ODw=="]]);
    expect(vi.mocked(verifyPhc)).not.toHaveBeenCalled();
  });

  it("never hashes, and reads nothing, for a scan that cannot be a badge", async () => {
    const { context } = await synced([SITE, operator(ANNA, 5, "0042"), badge(PASS_7, 6, ANNA)]);
    const scans: Array<[string, string]> = [
      ["", "not_badge"],
      ["\r\n", "not_badge"],
      ["x".repeat(257), "not_badge"],
      ["x".repeat(100_000), "not_badge"],
      ["MRK\u007f742", "not_badge"],
      ["MRK\n742", "not_badge"],
      ["MRK\u001f742", "not_badge"],
      ["MRK 742", "not_badge"],
      ["MRK-№742", "not_badge"],
      [`${BADGE_CODE}\u001d`, "product_code"],
      ["\u001d", "product_code"],
      ["0104600682000013215Abc\u001d91EE11", "product_code"],
      // A product scanned under the Russian layout: the group separator wins.
      ["ЬКЛ\u001d91", "product_code"],
      ["ЬКЛ-000742", "layout"],
      ["MRK-000742я", "layout"],
    ];
    for (const [raw, reason] of scans) {
      const reads = counted(context.local);
      expect(await signInWithBadge({ ...context, local: reads.local }, raw), reason).toEqual({
        kind: "refused",
        reason,
      });
      expect(reads.sql, reason).toEqual([]);
    }
    expect(vi.mocked(hashBadge)).not.toHaveBeenCalled();
  });

  it("reads any run of printable ASCII, spaces inside it included, as a badge code", () => {
    for (const code of ["a b", "!~", "0", "MRK 000742", `${"~".repeat(255)}!`]) {
      expect(readBadgeScan(code)).toEqual({ kind: "badge", code });
    }
    expect(readBadgeScan(" a b \r\n")).toEqual({ kind: "badge", code: "a b" });
  });

  it("hashes nothing while this pairing's copies are not complete", async () => {
    const { context } = await synced([SITE, operator(ANNA, 5, "0042"), badge(PASS_7, 6, ANNA)]);
    const other = { ...context, pairing: { hostId: HOST_ID, deviceId: BORIS } };
    await signInWithBadge(other, BADGE_CODE);
    expect(vi.mocked(hashBadge)).not.toHaveBeenCalled();
  });

  it("refuses when the copies stopped being this pairing's while the code was hashed", async () => {
    const { db, context } = await synced([SITE, operator(ANNA, 5, "0042"), badge(PASS_7, 6, ANNA)]);
    const repaired = afterRead(context.local, BADGE_READ, () => {
      db.prepare("DELETE FROM sync_state").run();
    });
    expect(await signInWithBadge({ ...context, local: repaired }, BADGE_CODE)).toEqual({
      kind: "refused",
      reason: "not_ready",
    });
  });

  it("refuses a badge whose operator's record waits in quarantine", async () => {
    const { db, context } = await synced([SITE, operator(ANNA, 5, "0042"), badge(PASS_7, 6, ANNA)]);
    db.prepare(
      "INSERT INTO sync_quarantine (entity, id, rev, reason, seen_at) " +
        "VALUES ('operators', ?, 9, 'data: unrecognized_keys', 1790000000000)",
    ).run(ANNA);
    expect(await signInWithBadge(context, BADGE_CODE)).toEqual({
      kind: "refused",
      reason: "wrong",
    });
  });

  it("is not stopped by another entity's quarantine record that shares an id", async () => {
    const { db, context } = await synced([SITE, operator(ANNA, 5, "0042"), badge(PASS_7, 6, ANNA)]);
    for (const [entity, id] of [
      ["operators", PASS_7],
      ["operator_badges", ANNA],
    ] as const) {
      db.prepare(
        "INSERT INTO sync_quarantine (entity, id, rev, reason, seen_at) " +
          "VALUES (?, ?, 9, 'x', 1790000000000)",
      ).run(entity, id);
    }
    expect(await signInWithBadge(context, BADGE_CODE)).toEqual(ANNA_SIGNED_IN);
  });

  it("signs in an operator whose two badge records carry the same code: one operator, not two", async () => {
    const { context } = await synced([
      SITE,
      operator(ANNA, 5, "0042"),
      badge(PASS_7, 6, ANNA),
      badge(PASS_8, 7, ANNA),
    ]);
    expect(await signInWithBadge(context, BADGE_CODE)).toEqual(ANNA_SIGNED_IN);
  });

  it("refuses when the site's salt is not exactly one", async () => {
    const { db, context } = await synced([SITE, operator(ANNA, 5, "0042"), badge(PASS_7, 6, ANNA)]);
    db.prepare(
      "INSERT INTO ref_site (id, badge_salt, box_block_size, pallet_block_size, rev) " +
        "VALUES ('2', 'BQQDAgEAD/4NDAsKCQgHBg==', 2000, 200, 2)",
    ).run();
    expect(await signInWithBadge(context, BADGE_CODE)).toEqual({
      kind: "refused",
      reason: "not_ready",
    });
    expect(vi.mocked(hashBadge)).not.toHaveBeenCalled();
  });
});

describe("what the sign-in lets out", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns an operator's identity only: no PIN, code, hash or salt, and nothing in the console", async () => {
    const spies = (["log", "info", "warn", "error", "debug", "trace"] as const).map((method) =>
      vi.spyOn(console, method).mockImplementation(() => undefined),
    );
    const { db, context } = await synced([SITE, operator(ANNA, 5, "0042"), badge(PASS_7, 6, ANNA)]);
    db.prepare(
      "INSERT INTO sync_quarantine (entity, id, rev, reason, seen_at) " +
        "VALUES ('operators', ?, 9, 'x', 1790000000000)",
    ).run(BORIS);
    const other = { ...context, pairing: { hostId: HOST_ID, deviceId: BORIS } };
    const results = [
      await signInWithPin(context, "0042", "4821"),
      await signInWithPin(context, "0042", "1111"),
      await signInWithPin(context, "0043", "4821"),
      await signInWithPin(context, "42", "4821"),
      await signInWithPin(other, "0042", "4821"),
      await signInWithBadge(context, BADGE_CODE),
      await signInWithBadge(context, "MRK-000743"),
      await signInWithBadge(context, `${BADGE_CODE}\u001d`),
      await signInWithBadge(context, "ЬКЛ-000742"),
      await signInWithBadge(context, ""),
      await signInWithBadge(other, BADGE_CODE),
      readBadgeScan(BADGE_CODE),
      readBadgeScan("ЬКЛ-000742"),
      await readFloorReadiness(context),
      await readFloorReadiness(other),
    ];
    const text = JSON.stringify(results);
    for (const secret of [
      "4821",
      "1111",
      "pbkdf2",
      PIN_PHC,
      BADGE_PHC,
      "AAECAwQFBgcICQoLDA0ODw",
      "bWFya2lyby1waW4",
      "pinPhc",
      "badgePhc",
      "badgeSalt",
      "rev",
    ]) {
      expect(text, secret).not.toContain(secret);
    }
    // The badge's own code is returned by `readBadgeScan` (the caller's input), nowhere else.
    expect(JSON.stringify(results.slice(0, 11))).not.toContain(BADGE_CODE);
    for (const result of results) {
      if ("operator" in result) {
        expect(Object.keys(result.operator).sort()).toEqual(["id", "login", "name", "role"]);
      }
    }
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  });
});

describe("the sign-in screen's readiness, beyond the count", () => {
  it("is ready with no operators at all", async () => {
    const { context } = await synced([SITE]);
    expect(await readFloorReadiness(context)).toEqual({ kind: "ready", operators: 0 });
  });
});
