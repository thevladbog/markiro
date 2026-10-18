import { z } from "zod";
import {
  codeSearchPath,
  officeCodeCardSchema,
  officeCodeItemSchema,
  type CodeSearchQuery,
} from "./code-search.js";

export const CODE_REGISTRY_SOURCES = ["all", "local", "cloud"] as const;
export type CodeRegistrySource = (typeof CODE_REGISTRY_SOURCES)[number];
export interface CodeRegistryQuery extends CodeSearchQuery {
  source?: CodeRegistrySource;
}
const instant = z.iso.datetime({ offset: true });
const codeHash = z.string().regex(/^[0-9a-f]{64}$/);
export const cloudCodeItemSchema = z.object({
  id: z.string(),
  codeHash,
  canonical: z.string().nullable(),
  gtin14: z.string().nullable(),
  serial: z.string().nullable(),
  scannedAt: instant,
  sourceTimeZone: z.string(),
  state: z.enum(["owned", "released", "historical"]),
  releasedAt: instant.nullable(),
  shiftId: z.string(),
  shiftNumber: z.string(),
  shiftAvailable: z.boolean(),
  productionDate: z.string().nullable(),
  productName: z.string().nullable(),
  lineName: z.string().nullable(),
  boxId: z.string().nullable(),
  boxSscc: z.string().nullable(),
  boxClosedAt: instant.nullable(),
  boxDisassembledAt: instant.nullable(),
  boxAvailable: z.boolean(),
  palletId: z.string().nullable(),
  palletSscc: z.string().nullable(),
  palletDisassembledAt: instant.nullable(),
  palletAvailable: z.boolean(),
});
export type CloudCodeItem = z.infer<typeof cloudCodeItemSchema>;
export const codeRegistryItemSchema = z.discriminatedUnion("source", [
  z.object({ source: z.literal("local"), item: officeCodeItemSchema }),
  z.object({ source: z.literal("cloud"), item: cloudCodeItemSchema }),
]);
export type CodeRegistryItem = z.infer<typeof codeRegistryItemSchema>;
export const codeRegistryPageSchema = z.object({
  items: z.array(codeRegistryItemSchema),
  page: z.number().int().positive(),
  pageCount: z.number().int().positive(),
  total: z.number().int().nonnegative(),
  capped: z.boolean(),
});
export type CodeRegistryPage = z.infer<typeof codeRegistryPageSchema>;
export const codeRegistryCardSchema = z.object({
  codeHash,
  local: officeCodeCardSchema.nullable(),
  cloud: z.array(cloudCodeItemSchema),
  cloudCapped: z.boolean(),
  currentOwner: codeRegistryItemSchema.nullable(),
});
export type CodeRegistryCard = z.infer<typeof codeRegistryCardSchema>;
export function codeRegistryPath(query: CodeRegistryQuery): string {
  const path = codeSearchPath(query).replace("/office/codes?", "/office/code-registry?");
  if (query.source === undefined) return path;
  if (!CODE_REGISTRY_SOURCES.includes(query.source)) throw new RangeError("not a registry source");
  return `${path}${path.endsWith("?") ? "" : "&"}source=${query.source}`;
}
