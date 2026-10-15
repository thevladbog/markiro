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

const count = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const noControl = (value: string) => !/\p{Cc}/u.test(value);
const text = (max: number) => z.string().min(1).max(max).refine(noControl);
const instant = z.iso.datetime();
const uuidLower = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);

export const standaloneMonthKeySchema = z.string().regex(/^[0-9]{4}-(0[1-9]|1[0-2])$/);

export const standaloneUsageMonthSchema = z
  .object({
    month: standaloneMonthKeySchema,
    shifts: z
      .object({
        aggregation: count,
        validation: count,
        validationPrint: count,
        fromOffice: count,
        fromStation: count,
        withPallets: count,
      })
      .strict(),
    scans: z.object({ accepted: count, duplicates: count, rejected: count }).strict(),
    boxes: z.object({ closed: count, disassembled: count, codes: count }).strict(),
    pallets: z.object({ closed: count, disassembled: count }).strict(),
    exceptions: z
      .object({
        boxUndo: count,
        boxClear: count,
        boxReprint: count,
        boxDisassemble: count,
        palletReprint: count,
        palletDisassemble: count,
      })
      .strict(),
    conflicts: z.object({ late: count, displaced: count, reviewed: count }).strict(),
    reprints: z.object({ warehouse: count, unitLabel: count }).strict(),
    disaggregationApplied: count,
    syncRejected: count,
  })
  .strict();
export type StandaloneUsageMonth = z.infer<typeof standaloneUsageMonthSchema>;

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
  devices: z.object({ station: count, office: count, handheld: count }).strict(),
};

export const standaloneSupportPayloadV1Schema = z.object({ v: z.literal(1), ...common }).strict();
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
  .strict();
export const standaloneSupportPayloadSchema = z.discriminatedUnion("v", [
  standaloneSupportPayloadV1Schema,
  standaloneSupportPayloadV2Schema,
]);
export type StandaloneSupportPayload = z.infer<typeof standaloneSupportPayloadSchema>;
