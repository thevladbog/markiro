import { z } from "zod";
import { DomainError } from "../errors.js";
import { productLabelValueDigest } from "../product-labels/km.js";
import { parsePalletSheetSpec, type PalletSheetSpecV2 } from "./pallet-sheet-model.js";
export const PALLET_SHEET_PROTOCOL = "pallet-sheet-v2";
const boundedSpec = z.unknown().transform((value, ctx) => {
  try {
    return parsePalletSheetSpec(value);
  } catch (error) {
    ctx.addIssue({
      code: "custom",
      message: error instanceof Error ? error.message : "Invalid sheet spec",
    });
    return z.NEVER;
  }
});
const snapshotContentSchema = z.strictObject({
  id: z.uuid().toLowerCase(),
  name: z.string().min(1).max(255),
  revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  spec: boundedSpec,
});
export const palletSheetTemplateSnapshotSchema = snapshotContentSchema
  .extend({ digest: z.string().regex(/^[0-9a-f]{64}$/) })
  .superRefine((snapshot, ctx) => {
    try {
      const { digest, ...content } = snapshot;
      if (productLabelValueDigest(content) !== digest)
        ctx.addIssue({
          code: "custom",
          path: ["digest"],
          message: "Pallet sheet digest does not match its selected revision and content",
        });
    } catch {
      ctx.addIssue({ code: "custom", path: ["spec"], message: "Snapshot is not canonical JSON" });
    }
  });
export type PalletSheetTemplateSnapshot = z.infer<typeof palletSheetTemplateSnapshotSchema>;
export function createPalletSheetSnapshot(value: {
  id: string;
  name: string;
  revision: number;
  spec: PalletSheetSpecV2;
}): PalletSheetTemplateSnapshot {
  const content = snapshotContentSchema.parse(value);
  const raw: unknown = JSON.parse(JSON.stringify(content));
  const canonical = snapshotContentSchema.parse(raw);
  return parsePalletSheetSnapshot({ ...canonical, digest: productLabelValueDigest(canonical) });
}
export function parsePalletSheetSnapshot(value: unknown): PalletSheetTemplateSnapshot {
  const result = palletSheetTemplateSnapshotSchema.safeParse(value);
  if (!result.success)
    throw new DomainError("LABEL_SHEET_SNAPSHOT", "Invalid pallet sheet snapshot", {
      cause: result.error.issues.map((issue) => ({
        path: issue.path.join("."),
        message: issue.message,
      })),
    });
  if (new TextEncoder().encode(JSON.stringify(result.data)).byteLength > 258 * 1024)
    throw new DomainError("LABEL_SHEET_SNAPSHOT", "Pallet sheet snapshot exceeds 258 KiB");
  return result.data;
}
