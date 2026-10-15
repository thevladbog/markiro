import { canonicalExportEqual } from "./us-demo-canonical.js";
import { schema } from "@markiro/db";

import { and, asc, eq, inArray, isNull, or } from "drizzle-orm";
import type { UsDemoTransaction } from "./us-demo-atomic-stage-contract.js";
import type { UsDatasetContext } from "./us-dataset-contract.js";
import type {
  UsDatasetCasesEvidence,
  UsDatasetCasesContentError,
} from "./us-dataset-cases-content.js";
import type { caseDemoAuditIdentity } from "./us-dataset-cases-contract.js";
import { lockUsDatasetCasesSupport } from "./us-dataset-cases-locks.js";
import { readUsDatasetCasesSupport } from "./us-dataset-cases-support.js";

/** Content only: caller owns authorization, codec, canonical receipts and origin locks. */
export async function verifyUsDatasetCasesContent(
  tx: UsDemoTransaction,
  context: UsDatasetContext,
  result: UsDatasetCasesEvidence,
  identity: Readonly<{ digest: string; seed: ReturnType<typeof caseDemoAuditIdentity> }>,
  error: UsDatasetCasesContentError,
): Promise<void> {
  const mismatch = () => error("us_dataset_cases_mismatch");
  const equal = (a: unknown, b: unknown) => {
    if (!canonicalExportEqual(a, b)) throw mismatch();
  };
  await lockUsDatasetCasesSupport(tx, context, result.input, error);
  equal(await readUsDatasetCasesSupport(tx, context, result.input, error), result.support);
  const links = schema.traceLotBoxes;
  const rows = await tx
    .select()
    .from(links)
    .where(
      and(
        eq(links.tenantId, context.tenantId),
        or(
          inArray(
            links.boxId,
            result.input.support.boxes.map((box) => box.id),
          ),
          and(eq(links.lotId, result.input.outputLotId), isNull(links.unlinkedAt)),
        ),
      ),
    )
    .orderBy(asc(links.ssccAtLink), asc(links.boxId));
  equal(
    rows.map((row) => ({
      ...row,
      linkedAt: row.linkedAt.toISOString(),
      unlinkedAt: row.unlinkedAt?.toISOString() ?? null,
    })),
    result.linked.created.map((row) => ({
      id: row.linkId,
      tenantId: context.tenantId,
      boxId: row.boxId,
      lotId: row.lotId,
      ssccAtLink: row.ssccAtLink,
      linkSource: "demo_seed",
      linkedBy: context.actorUserId,
      linkedAt: row.linkedAt,
      unlinkedAt: null,
      unlinkedBy: null,
      unlinkReason: null,
    })),
  );
  const operations = schema.traceLotBoxOperations;
  const [operation] = await tx
    .select()
    .from(operations)
    .where(
      and(
        eq(operations.tenantId, context.tenantId),
        eq(operations.command, "case.link"),
        eq(operations.operationKey, result.operationKey),
      ),
    );
  if (!operation) throw mismatch();
  equal(
    {
      tenantId: operation.tenantId,
      command: operation.command,
      operationKey: operation.operationKey,
      inputDigest: operation.inputDigest,
      targetId: operation.targetId,
      result: operation.result,
    },
    {
      tenantId: context.tenantId,
      command: "case.link",
      operationKey: result.operationKey,
      inputDigest: identity.digest,
      targetId: result.input.outputLotId,
      result: result.linked,
    },
  );
  const audit = schema.tenantAuditEvents;
  const audits = await tx
    .select()
    .from(audit)
    .where(
      and(
        eq(audit.organizationId, context.tenantId),
        eq(audit.requestId, result.requestId),
        eq(audit.action, "case.link"),
        eq(audit.targetId, result.input.outputLotId),
      ),
    );
  equal(
    audits.map(
      ({
        organizationId,
        actorUserId,
        action,
        outcome,
        targetType,
        targetId,
        before,
        after,
        requestId,
        createdAt,
      }) => ({
        organizationId,
        actorUserId,
        action,
        outcome,
        targetType,
        targetId,
        before,
        after,
        requestId,
        createdAt: createdAt.toISOString(),
      }),
    ),
    [
      {
        organizationId: context.tenantId,
        actorUserId: context.actorUserId,
        action: "case.link",
        outcome: "success",
        targetType: "traceability_lot",
        targetId: result.input.outputLotId,
        before: { links: [] },
        after: {
          tenantId: context.tenantId,
          operationKey: result.operationKey,
          lotId: result.input.outputLotId,
          source: "demo_seed",
          result: result.linked,
          seed: identity.seed,
        },
        requestId: result.requestId,
        createdAt: operation.createdAt.toISOString(),
      },
    ],
  );
  for (const row of [
    ...result.support.boxes.map((box) => box.openedAt),
    ...result.support.markers.map((marker) => marker.createdAt),
    result.support.shift.createdAt,
    ...result.linked.created.map((link) => link.linkedAt),
  ])
    equal(row, operation.createdAt.toISOString());
}
