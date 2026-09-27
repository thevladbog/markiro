import { parseScannedSscc } from "@markiro/domain";
import { z } from "zod";

const id = z.uuid();
const sscc = z.string().transform((raw, ctx) => {
  const value = parseScannedSscc(raw);
  if (value === null) {
    ctx.addIssue({ code: "custom", message: "invalid_sscc" });
    return z.NEVER;
  }
  return value;
});
const reason = z.string().trim().min(3).max(2000);
const instant = z.iso.datetime({ offset: true });
const cursor = z
  .string()
  .max(200)
  .refine((raw) => {
    if (!/^[A-Za-z0-9_-]+$/.test(raw)) return false;
    try {
      const decoded = atob(raw.replaceAll("-", "+").replaceAll("_", "/"));
      if (btoa(decoded).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "") !== raw)
        return false;
      const pair: unknown = JSON.parse(decoded);
      return (
        Array.isArray(pair) &&
        pair.length === 2 &&
        instant.safeParse(pair[0]).success &&
        id.safeParse(pair[1]).success
      );
    } catch {
      return false;
    }
  });

export const caseLinkCommandSchema = z
  .object({
    operationKey: id,
    ssccs: z.array(sscc).min(1).max(100),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (new Set(value.ssccs).size !== value.ssccs.length) {
      ctx.addIssue({ code: "custom", path: ["ssccs"], message: "duplicate_sscc" });
    }
  });
export const caseUnlinkCommandSchema = z.object({ operationKey: id, reason }).strict();
export const caseListQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(100).default(50),
    history: z
      .enum(["true", "false"])
      .default("false")
      .transform((value) => value === "true"),
    cursor: cursor.optional(),
  })
  .strict();
export const caseLookupQuerySchema = z.object({ sscc }).strict();

export const caseRowSchema = z
  .object({
    linkId: id,
    boxId: id,
    lotId: id,
    ssccAtLink: z.string().regex(/^\d{18}$/),
    linkSource: z.enum(["manual", "demo_seed"]),
    provenance: z.enum(["synthetic_demo", "existing_record"]),
    linkedAt: instant,
    linkedBy: z.string().min(1),
    unlinkedAt: instant.nullable(),
    unlinkedBy: z.string().min(1).nullable(),
    unlinkReason: reason.nullable(),
    originState: z.enum(["current", "gap"]),
    ssccState: z.enum(["consistent", "inconsistent"]),
  })
  .strict();
export const caseLinkResultSchema = z
  .object({
    lotId: id,
    created: z.array(caseRowSchema),
    unchanged: z.array(caseRowSchema),
  })
  .strict();
export const caseUnlinkResultSchema = z
  .object({
    linkId: id,
    lotId: id,
    unlinkedAt: instant,
    unlinkedBy: z.string().min(1),
    reason,
  })
  .strict();
export const caseListResultSchema = z
  .object({
    lotId: id,
    originState: z.enum(["current", "gap"]),
    activeCount: z.number().int().nonnegative(),
    rows: z.array(caseRowSchema),
    nextCursor: cursor.nullable(),
  })
  .strict();
export const caseLookupResultSchema = z
  .object({
    boxId: id,
    sscc: z.string().regex(/^\d{18}$/),
    provenance: z.enum(["synthetic_demo", "existing_record"]),
    activeLink: caseRowSchema.nullable(),
  })
  .strict();

export type CaseRow = z.infer<typeof caseRowSchema>;
export type CaseLinkCommand = z.infer<typeof caseLinkCommandSchema>;
export type CaseUnlinkCommand = z.infer<typeof caseUnlinkCommandSchema>;
export type CaseListQuery = z.infer<typeof caseListQuerySchema>;
export type CaseLookupQuery = z.infer<typeof caseLookupQuerySchema>;
export type CaseLinkResult = z.infer<typeof caseLinkResultSchema>;
export type CaseUnlinkResult = z.infer<typeof caseUnlinkResultSchema>;
export type CaseListResult = z.infer<typeof caseListResultSchema>;
export type CaseLookupResult = z.infer<typeof caseLookupResultSchema>;
