import { isTlcSourceReferenceUrl } from "@markiro/domain";
import { z } from "zod";
import { receivingFinalizationSnapshotV1Schema } from "./receiving-finalization-v1.js";

const reviewedLines = z
  .array(z.number().int().min(1).max(100))
  .max(100)
  .refine((lines) => lines.every((line, index) => index === 0 || line > (lines[index - 1] ?? 0)));
const reason = z
  .string()
  .max(2000)
  .refine(
    (value) => value.trim().length > 0 && !value.includes("\u0000") && !/\p{Cs}/u.test(value),
  );
const review = {
  reason,
  evidenceUrl: z.string().refine(isTlcSourceReferenceUrl),
  reviewedBy: reason.pipe(z.string().max(128)),
  reviewedAt: z.iso.datetime(),
};
const receiptBasis = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("ordinary") }).strict(),
  z.object({ kind: z.literal("exempt_existing_tlc"), ...review }).strict(),
  z.object({ kind: z.literal("exempt_assigned_tlc"), ...review, receivedTlc: z.null() }).strict(),
]);
const v1 = receivingFinalizationSnapshotV1Schema.shape;
export const receivingFinalizationSnapshotV2Schema = z
  .object({
    ...v1,
    snapshotVersion: z.literal(2),
    items: z.array(v1.items.element.extend({ receiptBasis })).min(1).max(100),
    confirmation: z
      .object({
        ...v1.confirmation.shape,
        ruleVersion: z.literal("receiving-readiness-v3"),
        reviewedExemptLines: reviewedLines,
      })
      .strict(),
  })
  .strict()
  .superRefine((value, context) => {
    const { reviewedExemptLines, ...confirmation } = value.confirmation;
    // Validation-only projection: never returned, saved or substituted for frozen data.
    const common = receivingFinalizationSnapshotV1Schema.safeParse({
      ...value,
      snapshotVersion: 1,
      items: value.items.map(({ receiptBasis: basis, ...item }) => {
        void basis;
        return item;
      }),
      confirmation: { ...confirmation, ruleVersion: "receiving-readiness-v2" },
    });
    if (!common.success) for (const issue of common.error.issues) context.addIssue({ ...issue });
    const expected = value.items.flatMap((item) =>
      item.receiptBasis.kind === "ordinary" ? [] : [item.lineNo],
    );
    if (
      expected.length !== reviewedExemptLines.length ||
      expected.some((line, index) => line !== reviewedExemptLines[index])
    ) {
      context.addIssue({
        code: "custom",
        path: ["confirmation", "reviewedExemptLines"],
        message: "Reviewed lines must match the exempt receipt lines",
      });
    }
    value.items.forEach((item, index) => {
      if (
        item.receiptBasis.kind === "exempt_assigned_tlc" &&
        (item.lotLinkMode !== "create_on_finalize" ||
          item.source.kind !== "location" ||
          item.source.locationId.toLowerCase() !== value.locationId.toLowerCase())
      ) {
        context.addIssue({
          code: "custom",
          path: ["items", index, "receiptBasis"],
          message: "Own assignment requires the physical receiving location and a new lot",
        });
      }
    });
  });
export type ReceivingFinalizationSnapshotV2 = z.infer<typeof receivingFinalizationSnapshotV2Schema>;
