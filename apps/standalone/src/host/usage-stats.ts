import { z } from "zod";

// Usage statistics for the support bundle (beta 3 feedback): mirrors
// `markiro_proto::usage_stats`. `GET /v1/office/usage-stats`, administrators
// only. Counts by calendar month and nothing else (no code, name, SSCC, PIN,
// badge or hash); the answer is read loosely, and the support payload is
// built from the fields named here alone (`src/office/info/support-usage.ts`).
// `proto/fixtures/usage-stats.json` holds the shape both sides read.

/** How many calendar months the host's answer holds, the current one last (`USAGE_MONTHS`). */
export const USAGE_MONTHS = 12;

const count = z.number().int().nonnegative();

const usageShiftsSchema = z.object({
  aggregation: count,
  validation: count,
  validationPrint: count,
  fromOffice: count,
  fromStation: count,
  withPallets: count,
});

const usageScansSchema = z.object({ accepted: count, duplicates: count, rejected: count });
const usageBoxesSchema = z.object({ closed: count, disassembled: count, codes: count });
const usagePalletsSchema = z.object({ closed: count, disassembled: count });
const usageExceptionsSchema = z.object({
  boxUndo: count,
  boxClear: count,
  boxReprint: count,
  boxDisassemble: count,
  palletReprint: count,
  palletDisassemble: count,
});
const usageConflictsSchema = z.object({ late: count, displaced: count, reviewed: count });
const usageReprintsSchema = z.object({ warehouse: count, unitLabel: count });

export const usageMonthSchema = z.object({
  month: z.string().regex(/^[0-9]{4}-(0[1-9]|1[0-2])$/),
  shifts: usageShiftsSchema,
  scans: usageScansSchema,
  boxes: usageBoxesSchema,
  pallets: usagePalletsSchema,
  exceptions: usageExceptionsSchema,
  conflicts: usageConflictsSchema,
  reprints: usageReprintsSchema,
  disaggregationApplied: count,
  syncRejected: count,
});
export type UsageMonth = z.infer<typeof usageMonthSchema>;

export const usageStatsSchema = z.object({
  months: z.array(usageMonthSchema).min(1).max(USAGE_MONTHS),
  devices: z.object({ station: count, office: count, handheld: count }),
});
export type UsageStats = z.infer<typeof usageStatsSchema>;
