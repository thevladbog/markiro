import { z } from "zod";
import { receivingFinalizationSnapshotV2Schema } from "./receiving-finalization-v2.js";
import { receivingFinalizationSnapshotV1Schema } from "./receiving-finalization-v1.js";

const lotBinding = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("created") }).strict(),
  z.object({ kind: z.literal("linked") }).strict(),
  z
    .object({
      kind: z.literal("retained"),
      previousEventId: z.uuid(),
      previousLineNo: z.number().int().min(1).max(100),
    })
    .strict(),
]);
const v2 = receivingFinalizationSnapshotV2Schema.shape;
export const receivingFinalizationSnapshotV3Schema = z
  .object({
    ...v2,
    snapshotVersion: z.literal(3),
    items: z.array(v2.items.element.extend({ lotBinding }).strict()).min(1).max(100),
    confirmation: v2.confirmation
      .extend({ ruleVersion: z.literal("receiving-readiness-v4") })
      .strict(),
  })
  .strict()
  .superRefine((value, context) => {
    // Validation only. Return the untouched v3 data, never this projection or new live labels.
    const { reviewedExemptLines, ...confirmation } = value.confirmation;
    const common = receivingFinalizationSnapshotV1Schema.safeParse({
      ...value,
      snapshotVersion: 1,
      items: value.items.map(({ lotBinding: binding, receiptBasis: basis, ...item }) => {
        void binding;
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
    )
      context.addIssue({
        code: "custom",
        path: ["confirmation", "reviewedExemptLines"],
        message: "Reviewed lines must match the exempt receipt lines",
      });
    const bindings = new Set<string>();
    value.items.forEach((item, index) => {
      const binding = item.lotBinding;
      if (
        item.receiptBasis.kind === "exempt_assigned_tlc" &&
        (item.lotLinkMode !== "create_on_finalize" ||
          item.source.kind !== "location" ||
          (binding.kind !== "retained" &&
            item.source.locationId.toLowerCase() !== value.locationId.toLowerCase()))
      )
        context.addIssue({
          code: "custom",
          path: ["items", index, "receiptBasis"],
          message:
            "New own assignment requires the receiving location; retained assignment keeps its physical source",
        });
      if (
        (binding.kind === "created" && item.lotLinkMode !== "create_on_finalize") ||
        (binding.kind === "linked" && item.lotLinkMode !== "link_existing")
      )
        context.addIssue({
          code: "custom",
          path: ["items", index, "lotBinding"],
          message: "Lot binding disagrees with the original link mode",
        });
      if (binding.kind !== "retained") return;
      const key = `${binding.previousEventId.toLowerCase()}:${binding.previousLineNo}`;
      if (bindings.has(key))
        context.addIssue({
          code: "custom",
          path: ["items", index, "lotBinding"],
          message: "Duplicate predecessor line binding",
        });
      bindings.add(key);
    });
  });
export type ReceivingFinalizationSnapshotV3 = z.infer<typeof receivingFinalizationSnapshotV3Schema>;
