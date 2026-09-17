import { replacementDrainEligibility } from "./device-replacement-capability";
import type { DeviceReplacementWorkBlockers } from "./device-replacement-readiness-work";
import { schema } from "@markiro/db";
import { and, desc, eq, max } from "drizzle-orm";
import {
  deviceReplacementPreparationSchema,
  deviceReplacementReceiptSchema,
  deviceReplacementReadinessRequestSchema,
} from "@markiro/platform-contracts";
import type { SubscriptionTransaction } from "../../subscriptions/entitlements.types";

export const REPLACEMENT_REPORT_TTL_MS = 60_000;
export const REPLACEMENT_INTENT_TTL_MS = 5 * 60_000;
export type ReplacementPreparation =
  typeof schema.workingDeviceReplacementPreparations.$inferSelect;
/** Rejected/out-of-order reports are still durable observations and cannot lower this fence. */
export async function replacementStorageRevisionHighWater(
  tx: SubscriptionTransaction,
  intent: { tenantId: string; deviceId: string; id: string; credentialEpoch: number },
) {
  const reports = schema.workingDeviceReplacementReadinessReports;
  const [row] = await tx
    .select({ revision: max(reports.storageRevision) })
    .from(reports)
    .where(
      and(
        eq(reports.tenantId, intent.tenantId),
        eq(reports.deviceId, intent.deviceId),
        eq(reports.intentId, intent.id),
        eq(reports.credentialEpoch, intent.credentialEpoch),
      ),
    );
  return row?.revision ?? 0;
}

export async function replacementPreparationProjection(
  tx: SubscriptionTransaction,
  row: ReplacementPreparation,
  currentFingerprint?: string | null,
  currentWorkBlockers: DeviceReplacementWorkBlockers = [],
) {
  const [execution] = await tx
    .select()
    .from(schema.workingDeviceReplacementExecutions)
    .where(
      and(
        eq(schema.workingDeviceReplacementExecutions.tenantId, row.tenantId),
        eq(schema.workingDeviceReplacementExecutions.preparationId, row.id),
      ),
    );
  const [intent] = await tx
    .select()
    .from(schema.workingDeviceReplacementReadinessIntents)
    .where(
      and(
        eq(schema.workingDeviceReplacementReadinessIntents.tenantId, row.tenantId),
        eq(schema.workingDeviceReplacementReadinessIntents.preparationId, row.id),
      ),
    )
    .orderBy(desc(schema.workingDeviceReplacementReadinessIntents.requestedAt))
    .limit(1);
  const [report] = intent
    ? await tx
        .select()
        .from(schema.workingDeviceReplacementReadinessReports)
        .where(
          and(
            eq(schema.workingDeviceReplacementReadinessReports.tenantId, row.tenantId),
            eq(schema.workingDeviceReplacementReadinessReports.intentId, intent.id),
          ),
        )
        .orderBy(desc(schema.workingDeviceReplacementReadinessReports.reportSequence))
        .limit(1)
    : [];
  const measured = report ? deviceReplacementReadinessRequestSchema.parse(report.payload) : null;
  const readiness = intent
    ? {
        intentId: intent.id,
        credentialEpoch: intent.credentialEpoch,
        receivedAt: report?.receivedAt.toISOString() ?? null,
        eligibility: report?.eligibility ?? { status: "blocked", reasons: ["report_stale"] },
        report: measured
          ? {
              reportSequence: measured.reportSequence,
              clientBuild: measured.clientBuild,
              storageRevision: measured.storageRevision,
              pending: measured.pending,
              conflicts: measured.conflicts,
              unknownPrints: measured.unknownPrints,
              activeTasks: measured.activeTasks,
              installedGrants: measured.installedGrants,
              journal: measured.journal,
            }
          : null,
      }
    : null;
  if (row.state === "completed" && execution?.response) {
    const saved = deviceReplacementReceiptSchema.parse(execution.response).preparation;
    return deviceReplacementPreparationSchema.parse({
      ...saved,
      ...(readiness ? { readiness } : {}),
      execution: {
        ...saved.execution,
        revision: execution.revision,
        recoveryState: execution.recoveryState,
      },
      recovery: {
        state: execution.recoveryState,
        closedAt: execution.recoveryClosedAt?.toISOString() ?? null,
      },
    });
  }
  const storageHighWater = intent ? await replacementStorageRevisionHighWater(tx, intent) : 0;
  const stale =
    !report ||
    report.storageRevision < storageHighWater ||
    Date.now() - report.receivedAt.getTime() >= REPLACEMENT_REPORT_TTL_MS ||
    !intent ||
    Date.now() >= intent.expiresAt.getTime();
  const [configuration] = intent
    ? await tx
        .select({
          id: schema.deviceGrantConfigurations.id,
          sequence: schema.deviceGrantConfigurations.sequence,
        })
        .from(schema.deviceGrantConfigurations)
        .where(
          and(
            eq(schema.deviceGrantConfigurations.tenantId, row.tenantId),
            eq(schema.deviceGrantConfigurations.stationDeviceId, row.deviceId),
          ),
        )
        .orderBy(desc(schema.deviceGrantConfigurations.sequence))
        .limit(1)
    : [];
  const changed =
    intent &&
    currentFingerprint !== undefined &&
    (intent.factsFingerprint !== currentFingerprint ||
      (configuration?.id ?? null) !== intent.grantConfigurationId ||
      (configuration?.sequence ?? null) !== intent.grantConfigurationSequence);
  const drainEligibility = ["prepared", "draining", "ready"].includes(row.state)
    ? await replacementDrainEligibility(tx, row.tenantId, row.deviceId)
    : undefined;
  const eligibility =
    drainEligibility?.status === "blocked"
      ? drainEligibility
      : changed
        ? { status: "blocked", reasons: ["facts_changed"] }
        : stale
          ? { status: "blocked", reasons: ["report_stale"] }
          : currentWorkBlockers.length
            ? {
                status: "blocked",
                reasons: [
                  ...new Set([
                    ...(report.eligibility.status === "blocked" ? report.eligibility.reasons : []),
                    ...currentWorkBlockers,
                  ]),
                ],
              }
            : report.eligibility;
  return deviceReplacementPreparationSchema.parse({
    id: row.id,
    sourceDeviceId: row.deviceId,
    revision: row.revision,
    state: row.state === "ready" && eligibility.status === "blocked" ? "draining" : row.state,
    preparedAt: row.preparedAt.toISOString(),
    cancelledAt: row.cancelledAt?.toISOString() ?? null,
    observation: row.observation,
    ...(drainEligibility ? { drainEligibility } : {}),
    ...(execution
      ? {
          execution: {
            id: execution.id,
            revision: execution.revision,
            step: execution.step,
            mode: execution.mode,
            targetDeviceId: execution.targetDeviceId,
            executedAt: execution.executedAt?.toISOString() ?? null,
            newWorkAllowedAt: execution.newWorkAllowedAt.toISOString(),
            recoveryState: execution.recoveryState,
          },
          recovery: {
            state: execution.recoveryState,
            closedAt: execution.recoveryClosedAt?.toISOString() ?? null,
          },
        }
      : {}),
    ...(intent
      ? {
          readiness: {
            ...readiness,
            eligibility,
          },
        }
      : {}),
  });
}
