import type { DeviceReplacementWorkBlockers } from "./device-replacement-readiness-work";
import { schema } from "@markiro/db";
import { and, desc, eq } from "drizzle-orm";
import { deviceReplacementPreparationSchema } from "@markiro/platform-contracts";
import type { SubscriptionTransaction } from "../../subscriptions/entitlements.types";

export const REPLACEMENT_REPORT_TTL_MS = 60_000;
export const REPLACEMENT_INTENT_TTL_MS = 5 * 60_000;
export type ReplacementPreparation =
  typeof schema.workingDeviceReplacementPreparations.$inferSelect;
export async function replacementPreparationProjection(
  tx: SubscriptionTransaction,
  row: ReplacementPreparation,
  currentFingerprint?: string | null,
  currentWorkBlockers: DeviceReplacementWorkBlockers = [],
) {
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
  const stale =
    !report ||
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
  const eligibility = changed
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
    ...(intent
      ? {
          readiness: {
            intentId: intent.id,
            credentialEpoch: intent.credentialEpoch,
            receivedAt: report?.receivedAt.toISOString() ?? null,
            eligibility,
          },
        }
      : {}),
  });
}
