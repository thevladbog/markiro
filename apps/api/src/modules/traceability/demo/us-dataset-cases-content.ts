import { isValidSscc } from "@markiro/domain";
import {
  caseLinkResultSchema,
  platformUuidSchema,
  type CaseLinkResult,
} from "@markiro/platform-contracts";
import { z } from "zod";
import type { UsDatasetCasesSupportInput } from "./us-dataset-cases-contract.js";

/** Validated projection for shared persistence/checks; this is not an accepted input codec. */
export type UsDatasetCasesContentInput = Readonly<{
  references: Readonly<{ datasetId: string }>;
  transformation: Readonly<{ unitKey: string }>;
  outputLotId: string;
  outputProductId: string;
  support: UsDatasetCasesSupportInput;
}>;
export type UsDatasetCasesSupportEvidence = Readonly<{
  shift: Readonly<{
    id: string;
    productId: string;
    status: "planned";
    mode: "aggregation";
    numberMonthKey: string;
    numberSeq: number;
    createdAt: string;
  }>;
  boxes: readonly Readonly<{
    id: string;
    shiftId: string;
    deviceBoxId: string;
    sscc: string;
    openedAt: string;
  }>[];
  markers: readonly Readonly<{
    boxId: string;
    seedId: string;
    seedVersion: 1;
    createdAt: string;
  }>[];
}>;
export type UsDatasetCasesEvidence = Readonly<{
  input: UsDatasetCasesContentInput;
  support: UsDatasetCasesSupportEvidence;
  operationKey: string;
  requestId: string;
  linked: CaseLinkResult;
}>;
export type UsDatasetCasesContentError = (
  code: "us_dataset_cases_conflict" | "us_dataset_cases_mismatch",
  cause?: unknown,
) => Error;

// Preserve the regular receipt schemas and semantics exactly. The corrected codec
// adds its own stronger ID boundary after the shared checker.
const uuid = platformUuidSchema.refine((value) => /^[0-9a-f-]+$/.test(value));
const text = z.string().trim().min(1);
const instant = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
  .refine((value) => {
    const parsed = new Date(value);
    return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value;
  });
const boxSchema = z
  .object({
    id: uuid,
    deviceBoxId: text,
    sscc: z
      .string()
      .regex(/^\d{18}$/)
      .refine(isValidSscc),
  })
  .strict();
export const usDatasetCasesEvidenceFields = {
  operationKey: uuid,
  requestId: text,
  linked: caseLinkResultSchema,
  support: z
    .object({
      shift: z
        .object({
          id: uuid,
          productId: uuid,
          status: z.literal("planned"),
          mode: z.literal("aggregation"),
          numberMonthKey: z.string(),
          numberSeq: z.number().int().positive(),
          createdAt: instant,
        })
        .strict(),
      boxes: z
        .array(boxSchema.extend({ shiftId: uuid, openedAt: instant }).strict())
        .min(1)
        .max(100),
      markers: z
        .array(
          z
            .object({ boxId: uuid, seedId: uuid, seedVersion: z.literal(1), createdAt: instant })
            .strict(),
        )
        .min(1)
        .max(100),
    })
    .strict(),
};
function valid(condition: boolean): asserts condition {
  if (!condition) throw new Error("us_dataset_cases_evidence_invalid");
}

/** Checks already parsed evidence. Current database content remains the verifier's responsibility. */
export function checkUsDatasetCasesEvidence(result: UsDatasetCasesEvidence): void {
  const input = result.input;
  const shift = result.support.shift,
    captured = input.support;
  valid(shift.id === captured.shiftId && shift.productId === input.outputProductId);
  valid(shift.numberMonthKey === captured.numberMonthKey && shift.numberSeq === captured.numberSeq);
  valid(
    result.support.boxes.length === captured.boxes.length &&
      result.support.markers.length === captured.boxes.length,
  );
  captured.boxes.forEach((box, index) => {
    const saved = result.support.boxes[index],
      marker = result.support.markers[index];
    valid(saved !== undefined && marker !== undefined);
    valid(
      saved.id === box.id &&
        saved.shiftId === shift.id &&
        saved.deviceBoxId === box.deviceBoxId &&
        saved.sscc === box.sscc,
    );
    valid(marker.boxId === box.id && marker.seedId === input.references.datasetId);
  });
  const linked = result.linked,
    ordered = [...captured.boxes].sort(
      (a, b) => a.sscc.localeCompare(b.sscc) || a.id.localeCompare(b.id),
    );
  valid(
    linked.lotId === input.outputLotId &&
      linked.unchanged.length === 0 &&
      linked.created.length === ordered.length,
  );
  valid(new Set(linked.created.map((link) => link.linkId)).size === linked.created.length);
  const actor = linked.created[0]?.linkedBy;
  ordered.forEach((box, index) => {
    const link = linked.created[index];
    valid(link !== undefined);
    valid(
      uuid.safeParse(link.linkId).success &&
        link.boxId === box.id &&
        link.lotId === input.outputLotId &&
        link.ssccAtLink === box.sscc,
    );
    valid(
      link.linkSource === "demo_seed" &&
        link.provenance === "synthetic_demo" &&
        link.originState === "current" &&
        link.ssccState === "consistent",
    );
    valid(link.unlinkedAt === null && link.unlinkedBy === null && link.unlinkReason === null);
    valid(
      instant.safeParse(link.linkedAt).success &&
        text.safeParse(link.linkedBy).success &&
        link.linkedBy.trim() === link.linkedBy &&
        link.linkedBy === actor,
    );
  });
}
