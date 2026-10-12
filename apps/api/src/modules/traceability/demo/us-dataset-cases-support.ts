import type {
  UsDatasetCasesContentInput,
  UsDatasetCasesContentError,
} from "./us-dataset-cases-content.js";
import { schema } from "@markiro/db";
import { and, eq, inArray, or } from "drizzle-orm";
import type { UsDemoTransaction } from "./us-demo-atomic-stage-contract.js";
import type { UsDatasetContext } from "./us-dataset-contract.js";
import {
  datasetCasesError,
  type UsDatasetCasesSupportEvidence,
} from "./us-dataset-cases-contract.js";

const ownedConstraints = new Set([
  "shifts_pkey",
  "shifts_tenant_id_uq",
  "shifts_tenant_month_seq_uq",
  "boxes_pkey",
  "boxes_tenant_id_uq",
  "boxes_tenant_sscc_uq",
  "boxes_device_box_uq",
  "traceability_synthetic_case_origins_tenant_id_box_id_pk",
]);
function ownedCollision(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  if (
    "code" in error &&
    error.code === "23505" &&
    "constraint" in error &&
    typeof error.constraint === "string" &&
    ownedConstraints.has(error.constraint)
  )
    return true;
  return "cause" in error && ownedCollision(error.cause);
}

/** Only call after preparation in the journal transaction. Never adopts existing rows. */
export async function insertUsDatasetCasesSupport(
  tx: UsDemoTransaction,
  context: UsDatasetContext,
  input: UsDatasetCasesContentInput,
  error: UsDatasetCasesContentError = (code, cause) =>
    datasetCasesError(code, input.transformation.unitKey, cause),
): Promise<UsDatasetCasesSupportEvidence> {
  try {
    await tx.insert(schema.shifts).values({
      id: input.support.shiftId,
      tenantId: context.tenantId,
      productId: input.outputProductId,
      status: "planned",
      mode: "aggregation",
      numberMonthKey: input.support.numberMonthKey,
      numberSeq: input.support.numberSeq,
    });
    await tx.insert(schema.boxes).values(
      input.support.boxes.map((box) => ({
        ...box,
        tenantId: context.tenantId,
        shiftId: input.support.shiftId,
      })),
    );
    await tx.insert(schema.traceabilitySyntheticCaseOrigins).values(
      input.support.boxes.map((box) => ({
        tenantId: context.tenantId,
        boxId: box.id,
        seedId: input.references.datasetId,
        seedVersion: 1,
      })),
    );
  } catch (cause) {
    if (ownedCollision(cause)) throw error("us_dataset_cases_conflict", cause);
    throw cause;
  }
  return readUsDatasetCasesSupport(tx, context, input, error);
}

/** Explicit physical defaults are verified separately from the bounded immutable receipt. */
export async function readUsDatasetCasesSupport(
  tx: UsDemoTransaction,
  context: UsDatasetContext,
  input: UsDatasetCasesContentInput,
  error: UsDatasetCasesContentError = (code, cause) =>
    datasetCasesError(code, input.transformation.unitKey, cause),
): Promise<UsDatasetCasesSupportEvidence> {
  const fail = () => error("us_dataset_cases_mismatch");
  const t = schema.shifts,
    b = schema.boxes,
    m = schema.traceabilitySyntheticCaseOrigins;
  const [shift] = await tx
    .select()
    .from(t)
    .where(and(eq(t.tenantId, context.tenantId), eq(t.id, input.support.shiftId)));
  if (
    !shift ||
    shift.productId !== input.outputProductId ||
    shift.status !== "planned" ||
    shift.mode !== "aggregation" ||
    shift.numberMonthKey !== input.support.numberMonthKey ||
    shift.numberSeq !== input.support.numberSeq ||
    shift.palletsEnabled !== false ||
    shift.createdFrom !== "admin" ||
    shift.stationClosePolicy !== "single_device" ||
    [
      shift.lineId,
      shift.counterpartyId,
      shift.labelTemplateId,
      shift.ssccIssuerCounterpartyId,
      shift.boxLabelTemplateId,
      shift.plannedQty,
      shift.boxCapacity,
      shift.palletCapacity,
      shift.stationCloseOwnerDeviceId,
      shift.plannedDate,
      shift.productionDate,
      shift.firstBoxClosureAt,
      shift.openedAt,
      shift.closedAt,
      shift.closeReason,
      shift.lateDataAt,
    ].some((value) => value !== null)
  )
    throw fail();
  const ids = input.support.boxes.map((box) => box.id);
  const boxes = await tx
    .select()
    .from(b)
    .where(and(eq(b.tenantId, context.tenantId), or(eq(b.shiftId, shift.id), inArray(b.id, ids))));
  const markers = await tx
    .select()
    .from(m)
    .where(and(eq(m.tenantId, context.tenantId), inArray(m.boxId, ids)));
  if (boxes.length !== ids.length || markers.length !== ids.length) throw fail();
  const evidenceBoxes: UsDatasetCasesSupportEvidence["boxes"][number][] = [];
  const evidenceMarkers: UsDatasetCasesSupportEvidence["markers"][number][] = [];
  for (const binding of input.support.boxes) {
    const box = boxes.find((row) => row.id === binding.id),
      marker = markers.find((row) => row.boxId === binding.id);
    if (
      !box ||
      box.shiftId !== shift.id ||
      box.deviceBoxId !== binding.deviceBoxId ||
      box.sscc !== binding.sscc ||
      [
        box.terminalId,
        box.operatorId,
        box.closedAt,
        box.closureReceivedAt,
        box.printVerifiedAt,
        box.printSkippedAt,
        box.disassembledAt,
      ].some((value) => value !== null) ||
      !marker ||
      marker.seedId !== input.references.datasetId ||
      marker.seedVersion !== 1
    )
      throw fail();
    evidenceBoxes.push({
      id: box.id,
      shiftId: box.shiftId,
      deviceBoxId: box.deviceBoxId,
      sscc: binding.sscc,
      openedAt: box.openedAt.toISOString(),
    });
    evidenceMarkers.push({
      boxId: marker.boxId,
      seedId: marker.seedId,
      seedVersion: 1,
      createdAt: marker.createdAt.toISOString(),
    });
  }
  // Physical rows, including removed/displaced items, are incompatible with synthetic support.
  const items = schema.boxItems;
  if (
    (
      await tx
        .select({ id: items.boxId })
        .from(items)
        .where(and(eq(items.tenantId, context.tenantId), inArray(items.boxId, ids)))
        .limit(1)
    ).length
  )
    throw fail();
  for (const table of [
    schema.scanEvents,
    schema.codes,
    schema.codeRegistry,
    schema.shiftDeviceParticipants,
    schema.stationShiftCloseEvents,
    schema.boxExceptions,
  ] as const) {
    if (
      (
        await tx
          .select({ id: table.shiftId })
          .from(table)
          .where(and(eq(table.tenantId, context.tenantId), eq(table.shiftId, shift.id)))
          .limit(1)
      ).length
    )
      throw fail();
  }
  return {
    shift: {
      id: shift.id,
      productId: shift.productId,
      status: "planned",
      mode: "aggregation",
      numberMonthKey: shift.numberMonthKey,
      numberSeq: shift.numberSeq,
      createdAt: shift.createdAt.toISOString(),
    },
    boxes: evidenceBoxes,
    markers: evidenceMarkers,
  };
}
