import type { DeviceReplacementReadinessResponse } from "@markiro/platform-contracts";
import type { readDeviceLicensingWork } from "./device-licensing-work";

export type DeviceReplacementWorkBlockers = Extract<
  DeviceReplacementReadinessResponse["eligibility"],
  { status: "blocked" }
>["reasons"];

/** Re-evaluate current server work independently of the stable drain authority. */
export function deviceReplacementServerWorkBlockers(
  work: Awaited<ReturnType<typeof readDeviceLicensingWork>>,
  deviceId: string,
): DeviceReplacementWorkBlockers {
  const reasons: DeviceReplacementWorkBlockers = [];
  if (
    work.shifts.some((s) => s.owner === deviceId || s.deviceId === deviceId) ||
    work.inventories.some(
      (i) => i.deviceId === deviceId && (!i.leftAt || i.pendingEventCount || i.openBoxCount),
    )
  )
    reasons.push("active_tasks");
  for (const job of work.jobs.filter((job) => job.deviceId === deviceId)) {
    const projection = job.projection;
    if (
      !projection ||
      typeof projection !== "object" ||
      !("status" in projection) ||
      projection.status !== "completed"
    ) {
      reasons.push("pending_product_labels");
      if (
        projection &&
        typeof projection === "object" &&
        "attemptState" in projection &&
        projection.attemptState === "delivery_unknown"
      )
        reasons.push("unknown_prints");
    }
  }
  if (
    work.quarantine.some((q) => q.deviceId === deviceId) ||
    work.nativeEvidence.some((row) => row.deviceId === deviceId)
  )
    reasons.push("pending_exceptions");
  return [...new Set(reasons)];
}
