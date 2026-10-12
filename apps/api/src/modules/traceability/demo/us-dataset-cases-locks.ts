import type {
  UsDatasetCasesContentInput,
  UsDatasetCasesContentError,
} from "./us-dataset-cases-content.js";
import { schema } from "@markiro/db";
import { and, asc, eq, inArray, or } from "drizzle-orm";
import type { UsDemoTransaction } from "./us-demo-atomic-stage-contract.js";
import type { UsDatasetContext } from "./us-dataset-contract.js";
import { datasetCasesError } from "./us-dataset-cases-contract.js";

/** Preparation has already acquired operation, origin roots/revisions, lots and references.
 * Never discovers roots via box links; this is the final support tier only. */
export async function lockUsDatasetCasesSupport(
  tx: UsDemoTransaction,
  context: UsDatasetContext,
  input: UsDatasetCasesContentInput,
  error: UsDatasetCasesContentError = (code, cause) =>
    datasetCasesError(code, input.transformation.unitKey, cause),
): Promise<void> {
  const t = schema.shifts,
    b = schema.boxes,
    m = schema.traceabilitySyntheticCaseOrigins;
  const fail = () => error("us_dataset_cases_mismatch");
  const shifts = await tx
    .select({ id: t.id })
    .from(t)
    .where(and(eq(t.tenantId, context.tenantId), eq(t.id, input.support.shiftId)))
    .for("share");
  if (shifts.length !== 1) throw fail();
  const ids = input.support.boxes.map((box) => box.id);
  const boxes = await tx
    .select({ id: b.id })
    .from(b)
    .where(
      and(
        eq(b.tenantId, context.tenantId),
        or(eq(b.shiftId, input.support.shiftId), inArray(b.id, ids)),
      ),
    )
    .orderBy(asc(b.sscc), asc(b.id))
    .for("update");
  if (boxes.length !== ids.length || boxes.some((box) => !ids.includes(box.id))) throw fail();
  const markers = await tx
    .select({ id: m.boxId })
    .from(m)
    .where(and(eq(m.tenantId, context.tenantId), inArray(m.boxId, ids)))
    .orderBy(asc(m.boxId))
    .for("share");
  if (markers.length !== ids.length) throw fail();
}
