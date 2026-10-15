import type { schema } from "@markiro/db";
import {
  standaloneDiagnosticSummarySchema,
  standaloneSupportPayloadSchema,
  standaloneUsageTotalsSchema,
  type StandaloneDiagnosticSummary,
  type StandaloneUsageMonth,
} from "@markiro/platform-contracts";

export type DiagnosticRow = typeof schema.standaloneSupportDiagnostics.$inferSelect;

/** What the pages need about a report; the system fields live in the payload (v2 only). */
export function diagnosticSummary(row: DiagnosticRow): StandaloneDiagnosticSummary {
  const parsed = standaloneSupportPayloadSchema.safeParse(row.payload);
  const v2 = parsed.success && parsed.data.v === 2 ? parsed.data : null;
  return standaloneDiagnosticSummarySchema.parse({
    id: row.id,
    hostKey: row.hostKey,
    siteId: row.siteId,
    generatedAt: row.generatedAt.toISOString(),
    receivedAt: row.receivedAt.toISOString(),
    kid: row.kid,
    payloadVersion: row.payloadVersion,
    appVersion: row.appVersion,
    hostVersion: row.hostVersion,
    pcRole: row.pcRole,
    os: v2?.os ?? null,
    arch: v2?.arch ?? null,
    webview: v2?.webview ?? null,
    licenseState: v2?.license?.state ?? null,
  });
}

type Json = unknown;
const isRecord = (value: Json): value is Record<string, Json> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function addTree(a: Json, b: Json): Json {
  if (typeof a === "number" && typeof b === "number")
    return Math.min(a + b, Number.MAX_SAFE_INTEGER);
  if (isRecord(a) && isRecord(b))
    return Object.fromEntries(Object.keys(a).map((key) => [key, addTree(a[key], b[key])]));
  return a;
}

/** The month over hosts: every counter added (saturating at 2^53 - 1, never past the schema); done here so the counters' shape stays out of SQL. */
export function sumUsageMonths(items: readonly StandaloneUsageMonth[]): StandaloneUsageMonth {
  const [first, ...rest] = items;
  if (first === undefined) throw new Error("no month to sum");
  const total = rest.reduce<Json>((sum, item) => addTree(sum, item), first);
  return standaloneUsageTotalsSchema.parse(
    isRecord(total) ? { ...total, month: first.month } : total,
  );
}

const VERSION = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/u;

function compareIdentifiers(a: string, b: string): number {
  const numeric = /^\d+$/u;
  if (numeric.test(a) && numeric.test(b)) return Number(a) - Number(b);
  if (numeric.test(a)) return -1;
  if (numeric.test(b)) return 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

/** `current` is older than `latest`; `null` when either is not a semantic version. */
export function isOlderVersion(current: string, latest: string): boolean | null {
  const a = VERSION.exec(current);
  const b = VERSION.exec(latest);
  if (a === null || b === null) return null;
  for (const at of [1, 2, 3]) {
    const delta = Number(a[at]) - Number(b[at]);
    if (delta !== 0) return delta < 0;
  }
  const pa = a[4];
  const pb = b[4];
  if (pa === undefined && pb === undefined) return false;
  if (pa === undefined) return false; // a release is newer than its pre-release
  if (pb === undefined) return true;
  const left = pa.split(".");
  const right = pb.split(".");
  for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
    const x = left[i];
    const y = right[i];
    if (x === undefined) return true;
    if (y === undefined) return false;
    const delta = compareIdentifiers(x, y);
    if (delta !== 0) return delta < 0;
  }
  return false;
}

export function encodeHistoryCursor(generatedAt: Date, id: string): string {
  return Buffer.from(`${generatedAt.toISOString()}|${id}`).toString("base64url");
}

export function decodeHistoryCursor(cursor: string): { generatedAt: Date; id: string } | null {
  const [iso, id, extra] = Buffer.from(cursor, "base64url").toString("utf8").split("|");
  if (iso === undefined || id === undefined || extra !== undefined) return null;
  const generatedAt = new Date(iso);
  if (Number.isNaN(generatedAt.getTime()) || generatedAt.toISOString() !== iso) return null;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(id)) return null;
  return { generatedAt, id };
}

/** The retention horizon (decision В6): 24 calendar months before `now`. */
export function retentionCutoff(now: Date): Date {
  const cutoff = new Date(now);
  cutoff.setUTCMonth(cutoff.getUTCMonth() - 24);
  return cutoff;
}
