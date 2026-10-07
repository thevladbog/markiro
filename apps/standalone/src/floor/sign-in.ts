import { verifyPhc } from "@markiro/domain";
import { z } from "zod";

import { hasCyrillic } from "../host/pairing-code.js";
import { hashBadge, isPinPhc } from "../lib/credentials.js";
import type { LocalExecutor } from "../local/executor.js";
import { copiesReady, type Pairing } from "../local/reference-sync.js";
import {
  clearOperatorFailures,
  lockRemainingMs,
  OPERATOR_LOCKOUT,
  operatorKey,
  recordFailure,
  STATION_LOCKOUT,
} from "./lockout.js";
import type { RosterEntry } from "./operator-search.js";

// The station's operator sign-in (stage 1 spec §5.6, plan 1f): offline, from
// the local copies of operators and badges only, never a call to the host.
// The PIN and the badge code stay in this module's arguments: nothing here
// logs, keeps or returns them, or a hash of either.

/** An operator signed in on this station: identity only, never a hash. */
export interface FloorOperator {
  id: string;
  /** The personnel number, leading zeros included. */
  login: string;
  name: string;
  role: string | null;
}

/** Why a sign-in did not go through. */
export type SignInRefusal =
  /** No operator matches: a wrong PIN, an unknown personnel number, an unknown badge. */
  | "wrong"
  /** The badge, or the personnel number, matches more than one operator. */
  | "ambiguous"
  /** No sync has begun to fill this pairing's copies, or they have no badge salt. */
  | "not_ready"
  /** The scan holds a GS1 group separator: a product's code, not a badge. */
  | "product_code"
  /** The scan arrived in Cyrillic: the keyboard layout is Russian. */
  | "layout"
  /** The scan cannot be a badge code: empty, longer than 256 or not printable ASCII. */
  | "not_badge";

export type SignInResult =
  | { kind: "signed_in"; operator: FloorOperator }
  | { kind: "refused"; reason: SignInRefusal }
  /**
   * Too many failures: the whole station's sign-in, or one operator's PIN,
   * is paused for `remainingMs` more (`src/floor/lockout.ts`).
   */
  | { kind: "locked"; scope: "station" | "operator"; remainingMs: number };

export interface SignInContext {
  local: LocalExecutor;
  /** The pairing whose copies the station reads (`DeviceStatus`). */
  pairing: Pairing;
  /** Unix milliseconds on this computer's clock, for the lockouts. */
  now: () => number;
}

/** A personnel number as the host keeps it: 3–12 ASCII digits (`operatorLoginRule`). */
const LOGIN = /^[0-9]{3,12}$/;
/** A PIN as the office takes it: 4–6 ASCII digits (`pinRule`). */
const PIN = /^[0-9]{4,6}$/;
/** A badge code as the office takes it: 1–256 printable ASCII characters (`badgeCodeRule`). */
const BADGE_CODE = /^[ -~]{1,256}$/;
/** The GS1 group separator a product's DataMatrix carries between its fields. */
const GROUP_SEPARATOR = "\u001d";

/**
 * A verifier no PIN is known to match, with the domain's 100 000 iterations:
 * an unknown personnel number still costs one full PBKDF2, as a known one
 * with a wrong PIN does, so the time of the answer does not tell them apart
 * (the cloud station's `DUMMY_PHC`, `apps/station/src/lib/auth.ts`).
 */
export const DUMMY_PIN_PHC =
  "pbkdf2$sha256$100000$fwGrIt01vwgBxxDlhqLVRQ==$PGnhdQA2lW09CcvuOhCmvp0z4HbztWXaYIq7+dqmLoQ=";

/** A copy's operator may sign in only while no newer record of it waits in quarantine. */
const NOT_QUARANTINED_OPERATOR =
  "NOT EXISTS (SELECT 1 FROM sync_quarantine AS q " +
  "WHERE q.entity = 'operators' AND q.id = o.id)";

const OPERATOR_BY_LOGIN =
  "SELECT o.id, o.login, o.name, o.role, o.pin_phc AS pinPhc, o.rev " +
  `FROM ref_operators AS o WHERE o.login = ? AND ${NOT_QUARANTINED_OPERATOR}`;

const OPERATOR_REV = `SELECT o.rev FROM ref_operators AS o WHERE o.id = ? AND ${NOT_QUARANTINED_OPERATOR}`;

/**
 * The operators a badge hash signs in: the badge's own record and its
 * operator's, neither waiting in quarantine. A badge never signs in on its
 * own: without its operator's copy it matches nobody.
 */
const BADGE_HOLDERS =
  "SELECT DISTINCT o.id, o.login, o.name, o.role " +
  "FROM ref_operator_badges AS b JOIN ref_operators AS o ON o.id = b.operator_id " +
  "WHERE b.badge_phc = ? AND NOT EXISTS (SELECT 1 FROM sync_quarantine AS q " +
  `WHERE q.entity = 'operator_badges' AND q.id = b.id) AND ${NOT_QUARANTINED_OPERATOR}`;

const SITE_SALT = "SELECT badge_salt AS badgeSalt FROM ref_site";

const OPERATOR_COUNT = `SELECT count(*) AS n FROM ref_operators AS o WHERE ${NOT_QUARANTINED_OPERATOR}`;

const ROSTER = `SELECT o.id, o.login, o.name FROM ref_operators AS o WHERE ${NOT_QUARANTINED_OPERATOR}`;

const rosterRow = z.object({ id: z.string(), login: z.string(), name: z.string() });

const operatorRow = z.object({
  id: z.string(),
  login: z.string(),
  name: z.string(),
  role: z.string().nullable(),
});
const credentialRow = operatorRow.extend({ pinPhc: z.string(), rev: z.number().int() });
const revRow = z.object({ rev: z.number().int() });
const saltRow = z.object({ badgeSalt: z.string() });
const countRow = z.object({ n: z.number().int().nonnegative() });

/**
 * The attempts' turn. A lockout is read before an attempt hashes and written
 * after it, so attempts that overlapped would all pass the same read and
 * hash, however many failures the limit allows, and a failure written after
 * the one that started a lockout would start the count over. One attempt at
 * a time: a scanner that sends many codes at once gets no more tries than a
 * keypad. A failed attempt (a database error) does not block the next one.
 *
 * An attempt that never settles (a local database call whose IPC never
 * answers) holds every later attempt until the application restarts, and the
 * sign-in screen stays pending. That is deliberate: a timeout inside the
 * queue that let the next attempt in would let it overlap the one still
 * running, which is the very bypass the queue closes. The screen may show
 * its own error after a wait, but must not release the queue.
 */
let turn: Promise<unknown> = Promise.resolve();

function oneAtATime(attempt: () => Promise<SignInResult>): Promise<SignInResult> {
  const result = turn.then(attempt);
  turn = result.catch(() => undefined);
  return result;
}

function refused(reason: SignInRefusal): SignInResult {
  return { kind: "refused", reason };
}

function locked(scope: "station" | "operator", remainingMs: number): SignInResult {
  return { kind: "locked", scope, remainingMs };
}

/** A sign-in that went through forgets that operator's failures, not the station's. */
async function signedIn(
  local: LocalExecutor,
  { id, login, name, role }: FloorOperator,
): Promise<SignInResult> {
  await clearOperatorFailures(local, id);
  return { kind: "signed_in", operator: { id, login, name, role } };
}

/**
 * Counts a wrong attempt: always against the station, and against the
 * operator whose PIN it was, when one was found. A lockout the attempt
 * started is the answer, the station's first; otherwise it is `wrong`.
 */
async function failed(context: SignInContext, operatorId: string | null): Promise<SignInResult> {
  const now = context.now();
  const station = await recordFailure(context.local, "station", STATION_LOCKOUT, now);
  const operator =
    operatorId === null
      ? 0
      : await recordFailure(context.local, operatorKey(operatorId), OPERATOR_LOCKOUT, now);
  if (station > 0) return locked("station", station);
  if (operator > 0) return locked("operator", operator);
  return refused("wrong");
}

/**
 * What the sign-in screen can offer: nothing until a sync has begun to fill
 * this pairing's copies (`copiesReady`), then how many operators may sign in.
 */
export type FloorReadiness = { kind: "not_ready" } | { kind: "ready"; operators: number };

export async function readFloorReadiness(context: SignInContext): Promise<FloorReadiness> {
  if (!(await copiesReady(context.local, context.pairing))) return { kind: "not_ready" };
  const [count] = await context.local.query(OPERATOR_COUNT, [], countRow);
  return { kind: "ready", operators: count?.n ?? 0 };
}

/**
 * The operators the name search may offer (`src/floor/operator-search.ts`):
 * this pairing's copies once a sync has begun to fill them (`copiesReady`),
 * none waiting in quarantine, identity only (never a hash); `null` while the
 * copies are not ready.
 */
export async function readOperatorRoster(context: SignInContext): Promise<RosterEntry[] | null> {
  if (!(await copiesReady(context.local, context.pairing))) return null;
  return context.local.query(ROSTER, [], rosterRow);
}

/**
 * A personnel number and a PIN against the copies. Exactly one operator must
 * have the number, and the PIN must match the hash of that operator's copy
 * (`verifyPhc`, which compares in constant time, with the count the hash
 * carries, which the sync accepted only within 10 000–1 000 000). Every
 * attempt with a well-formed number and PIN runs one full PBKDF2, the dummy
 * one for an unknown number. The operator's copy is read again after the
 * verification: a PIN change or a deactivation that landed meanwhile wins.
 *
 * A locked station, or a locked PIN of the operator with this number, is
 * answered before any hashing. A wrong attempt counts against the station
 * and, when the number names one operator, against that operator; a
 * malformed number or PIN (the keypad does not send one), an ambiguous
 * number and copies that are not ready count against nobody.
 */
async function pinAttempt(
  context: SignInContext,
  login: string,
  pin: string,
): Promise<SignInResult> {
  if (!LOGIN.test(login) || !PIN.test(pin)) return refused("wrong");
  const { local, pairing } = context;
  if (!(await copiesReady(local, pairing))) return refused("not_ready");
  const stationLock = await lockRemainingMs(local, "station", STATION_LOCKOUT, context.now());
  if (stationLock > 0) return locked("station", stationLock);
  const rows = await local.query(OPERATOR_BY_LOGIN, [login], credentialRow);
  const [only] = rows;
  const found = rows.length === 1 && only !== undefined ? only : null;
  if (found !== null) {
    const key = operatorKey(found.id);
    const operatorLock = await lockRemainingMs(local, key, OPERATOR_LOCKOUT, context.now());
    if (operatorLock > 0) return locked("operator", operatorLock);
  }
  const operator = found !== null && isPinPhc(found.pinPhc) ? found : null;
  const matched = await verifyPhc(pin, operator?.pinPhc ?? DUMMY_PIN_PHC);
  if (rows.length > 1) return refused("ambiguous");
  if (!matched || operator === null) return failed(context, found?.id ?? null);
  if (!(await copiesReady(local, pairing))) return refused("not_ready");
  const [current] = await local.query(OPERATOR_REV, [operator.id], revRow);
  if (current?.rev !== operator.rev) return refused("wrong");
  return signedIn(local, operator);
}

/**
 * What a scan is, before anything is hashed: a badge code (trimmed, as
 * `badgeCodeRule` trims it), or why it cannot be one. A product's code (a
 * GS1 group separator in it), a scan in Cyrillic (the Russian layout; never
 * read by key position) and anything else no badge could be never reach the
 * hash.
 */
export type BadgeScan =
  | { kind: "badge"; code: string }
  | { kind: "refused"; reason: "product_code" | "layout" | "not_badge" };

export function readBadgeScan(raw: string): BadgeScan {
  if (raw.includes(GROUP_SEPARATOR)) return { kind: "refused", reason: "product_code" };
  const code = raw.trim();
  if (hasCyrillic(code)) return { kind: "refused", reason: "layout" };
  if (!BADGE_CODE.test(code)) return { kind: "refused", reason: "not_badge" };
  return { kind: "badge", code };
}

/**
 * A scanned badge against the copies: the trimmed code hashed once with the
 * site's salt and exactly `BADGE_ITERATIONS` (`hashBadge`), and that whole
 * string compared with the badges' hashes. The badge signs in only with its
 * operator's copy, and a badge that matches more than one operator is
 * refused as ambiguous, never resolved to the first.
 *
 * A locked station is answered before any hashing; an unknown badge counts
 * against the station (a code typed by hand is a guess like a PIN). A
 * product's code, a Cyrillic scan, a non-badge and an ambiguous badge count
 * against nobody: none of them is a guess at a badge. An operator whose PIN
 * is locked still signs in with their badge, another credential.
 */
async function badgeAttempt(context: SignInContext, raw: string): Promise<SignInResult> {
  const scan = readBadgeScan(raw);
  if (scan.kind === "refused") return refused(scan.reason);
  const { local, pairing } = context;
  if (!(await copiesReady(local, pairing))) return refused("not_ready");
  const stationLock = await lockRemainingMs(local, "station", STATION_LOCKOUT, context.now());
  if (stationLock > 0) return locked("station", stationLock);
  const salts = await local.query(SITE_SALT, [], saltRow);
  const [site] = salts;
  if (salts.length !== 1 || site === undefined) return refused("not_ready");
  const phc = await hashBadge(scan.code, site.badgeSalt);
  const holders = await local.query(BADGE_HOLDERS, [phc], operatorRow);
  if (!(await copiesReady(local, pairing))) return refused("not_ready");
  if (holders.length > 1) return refused("ambiguous");
  const [holder] = holders;
  if (holder === undefined) return failed(context, null);
  return signedIn(local, holder);
}

const OPERATOR_PRESENT = `SELECT o.id FROM ref_operators AS o WHERE o.id = ? AND ${NOT_QUARANTINED_OPERATOR}`;

/**
 * Whether the signed-in operator would still be let in, after a sync:
 * `false` only when this pairing's copies are ready (a sync has begun to fill
 * them) and no longer hold the operator (the host turned them off, or their
 * record waits in quarantine). Copies that are not ready say nothing either
 * way.
 */
export async function operatorStillAllowed(
  context: SignInContext,
  operatorId: string,
): Promise<boolean> {
  if (!(await copiesReady(context.local, context.pairing))) return true;
  const rows = await context.local.query(
    OPERATOR_PRESENT,
    [operatorId],
    z.object({ id: z.string() }),
  );
  return rows.length > 0;
}

/** A personnel number and a PIN, one attempt at a time (`pinAttempt`). */
export function signInWithPin(
  context: SignInContext,
  login: string,
  pin: string,
): Promise<SignInResult> {
  return oneAtATime(() => pinAttempt(context, login, pin));
}

/** A scanned badge, one attempt at a time (`badgeAttempt`). */
export function signInWithBadge(context: SignInContext, raw: string): Promise<SignInResult> {
  return oneAtATime(() => badgeAttempt(context, raw));
}
