import { z } from "zod";

/**
 * The plaintext inside a support token `MKS1.<kid>.<body>` (the client:
 * `apps/standalone/src/office/info/support-usage.ts`). Strict at every level:
 * a field the client does not send is a refusal, so a hand-made token cannot
 * smuggle a name, a code or a secret into the history. v1 is beta 3 (counts
 * only); v2 adds the host's id, the PC role, the system and a license summary.
 */
export const STANDALONE_SUPPORT_MAX_MONTHS = 12;
export const STANDALONE_SUPPORT_QUOTA_KEYS = [
  "lines",
  "stations",
  "kiosks",
  "cabinetUsers",
] as const;
export const STANDALONE_SUPPORT_FEATURE_KEYS = [
  "labelEditor",
  "publicApi",
  "pallets",
  "chzIntegration",
  "inventory",
  "commerceMl",
  "handheld",
  "customLogo",
] as const;

/**
 * One month's counter from one host. 1e9 is far above any real site (a line scans millions a
 * month) and keeps the sum over a tenant's hosts inside the safe-integer range the statistics
 * response promises; a larger value is a broken or hand-made token, not a fact to keep.
 */
export const STANDALONE_SUPPORT_MAX_COUNTER = 1_000_000_000;
/** A device count: far above a site's fleet, and inside the Postgres `integer` the history stores. */
export const STANDALONE_SUPPORT_MAX_DEVICES = 1_000_000;
/** How far back, and (for a skewed clock) ahead, of `generatedAt` a reported month may lie. */
export const STANDALONE_SUPPORT_MONTHS_BACK = 36;
export const STANDALONE_SUPPORT_MONTHS_AHEAD = 1;

const boundedCount = z.number().int().min(0).max(STANDALONE_SUPPORT_MAX_COUNTER);
const count = boundedCount;
const noControl = (value: string) => !/\p{Cc}/u.test(value);
const text = (max: number) => z.string().min(1).max(max).refine(noControl);
const instant = z.iso.datetime();
const uuidLower = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);

export const standaloneMonthKeySchema = z.string().regex(/^[0-9]{4}-(0[1-9]|1[0-2])$/);

/** The month's shape with `n` as the counter type: bounded for one host, wide for a sum over hosts. */
const usageMonthShape = (n: z.ZodNumber) =>
  z
    .object({
      month: standaloneMonthKeySchema,
      shifts: z
        .object({
          aggregation: n,
          validation: n,
          validationPrint: n,
          fromOffice: n,
          fromStation: n,
          withPallets: n,
        })
        .strict(),
      scans: z.object({ accepted: n, duplicates: n, rejected: n }).strict(),
      boxes: z.object({ closed: n, disassembled: n, codes: n }).strict(),
      pallets: z.object({ closed: n, disassembled: n }).strict(),
      exceptions: z
        .object({
          boxUndo: n,
          boxClear: n,
          boxReprint: n,
          boxDisassemble: n,
          palletReprint: n,
          palletDisassemble: n,
        })
        .strict(),
      conflicts: z.object({ late: n, displaced: n, reviewed: n }).strict(),
      reprints: z.object({ warehouse: n, unitLabel: n }).strict(),
      disaggregationApplied: n,
      syncRejected: n,
    })
    .strict();
export const standaloneUsageMonthSchema = usageMonthShape(boundedCount);
/** The sum of one month over a tenant's hosts: still integers, but no longer one host's ceiling. */
export const standaloneUsageTotalsSchema = usageMonthShape(
  z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
);
export type StandaloneUsageMonth = z.infer<typeof standaloneUsageMonthSchema>;

const devicesCount = z.number().int().min(0).max(STANDALONE_SUPPORT_MAX_DEVICES);
const quotaUse = z.object({ limit: count.nullable(), used: count, over: z.boolean() }).strict();

export const standaloneSupportLicenseSchema = z
  .object({
    state: text(64),
    plan: text(64).nullable(),
    licenseId: uuidLower.nullable(),
    sequence: z.number().int().positive().max(2_147_483_647).nullable(),
    kid: text(128).nullable(),
    validFrom: instant.nullable(),
    validUntil: instant.nullable(),
    graceDays: count.max(366).nullable(),
    daysLeft: count.nullable(),
    quotas: z
      .object({
        lines: quotaUse,
        stations: quotaUse,
        kiosks: quotaUse,
        cabinetUsers: quotaUse,
      })
      .strict(),
    features: z
      .object({
        labelEditor: z.boolean(),
        publicApi: z.boolean(),
        pallets: z.boolean(),
        chzIntegration: z.boolean(),
        inventory: z.boolean(),
        commerceMl: z.boolean(),
        handheld: z.boolean(),
        customLogo: z.boolean(),
      })
      .strict(),
    innMatches: z.boolean().nullable(),
  })
  .strict();
export type StandaloneSupportLicense = z.infer<typeof standaloneSupportLicenseSchema>;

const months = z
  .array(standaloneUsageMonthSchema)
  .min(1)
  .max(STANDALONE_SUPPORT_MAX_MONTHS)
  .refine((items) =>
    items.every((item, at) => at === 0 || (items[at - 1]?.month ?? "") < item.month),
  );
const common = {
  generatedAt: instant,
  appVersion: text(64).nullable(),
  hostVersion: text(64).nullable(),
  months,
  devices: z
    .object({ station: devicesCount, office: devicesCount, handheld: devicesCount })
    .strict(),
};

const monthIndex = (year: number, month: number) => year * 12 + month - 1;
/** Every reported month lies in [generatedAt - 36 months, generatedAt + 1 month]; others expand into nothing real. */
function monthsNearGeneratedAt(payload: {
  generatedAt: string;
  months: readonly { month: string }[];
}) {
  const generated = new Date(payload.generatedAt);
  if (Number.isNaN(generated.getTime())) return false;
  const at = monthIndex(generated.getUTCFullYear(), generated.getUTCMonth() + 1);
  return payload.months.every((item) => {
    const index = monthIndex(Number(item.month.slice(0, 4)), Number(item.month.slice(5, 7)));
    return (
      index >= at - STANDALONE_SUPPORT_MONTHS_BACK && index <= at + STANDALONE_SUPPORT_MONTHS_AHEAD
    );
  });
}

export const standaloneSupportPayloadV1Schema = z
  .object({ v: z.literal(1), ...common })
  .strict()
  .refine(monthsNearGeneratedAt);
export const standaloneSupportPayloadV2Schema = z
  .object({
    v: z.literal(2),
    ...common,
    hostId: uuidLower.nullable(),
    role: z.enum(["host", "station", "office"]).nullable(),
    os: text(120).nullable(),
    arch: text(120).nullable(),
    webview: text(120).nullable(),
    license: standaloneSupportLicenseSchema.nullable(),
  })
  .strict()
  .refine(monthsNearGeneratedAt);
export const standaloneSupportPayloadSchema = z.discriminatedUnion("v", [
  standaloneSupportPayloadV1Schema,
  standaloneSupportPayloadV2Schema,
]);
export type StandaloneSupportPayload = z.infer<typeof standaloneSupportPayloadSchema>;
