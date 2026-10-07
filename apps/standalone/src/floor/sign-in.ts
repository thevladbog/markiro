import { verifyPhc } from "@markiro/domain";
import { z } from "zod";

import { hasCyrillic } from "../host/pairing-code.js";
import { hashBadge, isPinPhc } from "../lib/credentials.js";
import type { LocalExecutor } from "../local/executor.js";
import { copiesReady, type Pairing } from "../local/reference-sync.js";

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
  /** The copies are not this pairing's complete copies, or have no badge salt. */
  | "not_ready"
  /** The scan holds a GS1 group separator: a product's code, not a badge. */
  | "product_code"
  /** The scan arrived in Cyrillic: the keyboard layout is Russian. */
  | "layout"
  /** The scan cannot be a badge code: empty, longer than 256 or not printable ASCII. */
  | "not_badge";

export type SignInResult =
  { kind: "signed_in"; operator: FloorOperator } | { kind: "refused"; reason: SignInRefusal };

export interface SignInContext {
  local: LocalExecutor;
  /** The pairing whose copies the station reads (`DeviceStatus`). */
  pairing: Pairing;
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
 * (the cloud station's `DUMMY_PIN_PHC`).
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

function refused(reason: SignInRefusal): SignInResult {
  return { kind: "refused", reason };
}

function signedIn({ id, login, name, role }: FloorOperator): SignInResult {
  return { kind: "signed_in", operator: { id, login, name, role } };
}

/**
 * What the sign-in screen can offer: nothing until this pairing's copies are
 * complete (`copiesReady`), then how many operators may sign in.
 */
export type FloorReadiness = { kind: "not_ready" } | { kind: "ready"; operators: number };

export async function readFloorReadiness(context: SignInContext): Promise<FloorReadiness> {
  if (!(await copiesReady(context.local, context.pairing))) return { kind: "not_ready" };
  const [count] = await context.local.query(OPERATOR_COUNT, [], countRow);
  return { kind: "ready", operators: count?.n ?? 0 };
}

/**
 * A personnel number and a PIN against the copies. Exactly one operator must
 * have the number, and the PIN must match the hash of that operator's copy
 * (`verifyPhc`, which compares in constant time, with the count the hash
 * carries, which the sync accepted only within 10 000–1 000 000). Every
 * attempt with a well-formed number and PIN runs one full PBKDF2, the dummy
 * one for an unknown number. The operator's copy is read again after the
 * verification: a PIN change or a deactivation that landed meanwhile wins.
 */
export async function signInWithPin(
  context: SignInContext,
  login: string,
  pin: string,
): Promise<SignInResult> {
  if (!LOGIN.test(login) || !PIN.test(pin)) return refused("wrong");
  const { local, pairing } = context;
  if (!(await copiesReady(local, pairing))) return refused("not_ready");
  const rows = await local.query(OPERATOR_BY_LOGIN, [login], credentialRow);
  const [only] = rows;
  const operator = rows.length === 1 && only !== undefined && isPinPhc(only.pinPhc) ? only : null;
  const matched = await verifyPhc(pin, operator?.pinPhc ?? DUMMY_PIN_PHC);
  if (rows.length > 1) return refused("ambiguous");
  if (!matched || operator === null) return refused("wrong");
  if (!(await copiesReady(local, pairing))) return refused("not_ready");
  const [current] = await local.query(OPERATOR_REV, [operator.id], revRow);
  if (current?.rev !== operator.rev) return refused("wrong");
  return signedIn(operator);
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
 */
export async function signInWithBadge(context: SignInContext, raw: string): Promise<SignInResult> {
  const scan = readBadgeScan(raw);
  if (scan.kind === "refused") return refused(scan.reason);
  const { local, pairing } = context;
  if (!(await copiesReady(local, pairing))) return refused("not_ready");
  const salts = await local.query(SITE_SALT, [], saltRow);
  const [site] = salts;
  if (salts.length !== 1 || site === undefined) return refused("not_ready");
  const phc = await hashBadge(scan.code, site.badgeSalt);
  const holders = await local.query(BADGE_HOLDERS, [phc], operatorRow);
  if (!(await copiesReady(local, pairing))) return refused("not_ready");
  if (holders.length > 1) return refused("ambiguous");
  const [holder] = holders;
  if (holder === undefined) return refused("wrong");
  return signedIn(holder);
}
