import { z } from "zod";

import { lotNumberSchema } from "./protocol.js";

const ssccSchema = z.string().regex(/^\d{18}$/);

/** `markiro_proto::BoxRegistryItem`. A removal carries only the identity and change time. */
export const boxRegistryItemSchema = z.object({
  kind: z.enum(["upsert", "remove"]),
  sscc: ssccSchema,
  updatedAt: z.iso.datetime(),
  boxId: z.string().optional(),
  productId: z.string().optional(),
  bottleCount: z.number().int().nonnegative().optional(),
  palletId: z.string().optional(),
  palletSscc: ssccSchema.optional(),
  palletActive: z.boolean().optional(),
  closedAt: z.iso.datetime().optional(),
  productionDate: z.iso.date().optional(),
  shiftNumber: z.string().optional(),
  lotNumber: lotNumberSchema,
});

export const boxRegistryPageSchema = z.object({
  until: z.iso.datetime(),
  items: z.array(boxRegistryItemSchema),
  nextCursor: z.string().min(1).optional(),
  restoreEpoch: z.string().optional(),
  canOpenPallets: z.boolean().optional(),
  lotNumbersSupported: z.boolean().optional(),
});

export type BoxRegistryItem = z.infer<typeof boxRegistryItemSchema>;
export type BoxRegistryPage = z.infer<typeof boxRegistryPageSchema>;

export const palletAssemblyCloseIssueSchema = z.object({
  id: z.uuid(),
  palletId: z.uuid(),
  sscc: ssccSchema,
  code: z.string(),
  status: z.enum(["pending", "approved", "cancelled", "reclosed"]),
  reportedBoxes: z.number().int().nonnegative(),
  currentBoxes: z.number().int().nonnegative(),
  currentBoxSsccs: z.array(ssccSchema),
  approvedBoxes: z.number().int().nonnegative().optional(),
  approvedBoxSsccs: z.array(ssccSchema).optional(),
  approvedLotNumber: lotNumberSchema,
  createdAt: z.iso.datetime(),
  deviceName: z.string().optional(),
});

export const palletAssemblyCloseIssuesSchema = z.object({
  issues: z.array(palletAssemblyCloseIssueSchema),
});
export type PalletAssemblyCloseIssue = z.infer<typeof palletAssemblyCloseIssueSchema>;
export type ResolvePalletAssemblyCloseIssue =
  | { action: "approve_reclose"; expectedBoxSsccs: string[] }
  | { action: "cancel"; labelRemoved: true };

export interface BoxRegistryQuery {
  since?: string;
  until?: string;
  cursor?: string;
}

export function boxRegistryPath(query: BoxRegistryQuery): string {
  const params = new URLSearchParams();
  for (const key of ["since", "until", "cursor"] as const) {
    const value = query[key];
    if (value !== undefined) params.set(key, value);
  }
  return params.size === 0 ? "/v1/device/box-registry" : `/v1/device/box-registry?${params}`;
}
