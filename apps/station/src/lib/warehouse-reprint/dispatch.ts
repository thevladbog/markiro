import {
  UNIFIED_REPRINT_PROTOCOL,
  unifiedLookupResultSchema,
  resolveWarehouseReprintScan,
  palletDataSchema,
  palletLabelSourceSchema,
  palletDataFromLegacySource,
  palletProductionDeliverySchema,
  type PalletDataV3,
} from "@markiro/domain";
import type { SqlExecutor } from "../mirror.js";
import { StationApiError, type StationClient } from "../api-client.js";
import { AUTHORIZED_CREDENTIAL_OWNERS_SQL } from "../device-recovery.js";
import { palletMembership } from "./pallet-sources.js";
import {
  PalletDeliveryError,
  localPalletDiagnostic,
  palletOriginalIsResolved,
} from "./pallet-resolutions.js";
import { warehouseNetworkUnavailable } from "./sources.js";
import { recoverLegacyProductionPalletDeliveries } from "./production-delivery.js";
export type ReprintTarget = { kind: "unit" | "box" } | { kind: "pallet"; data: PalletDataV3 };
export function readCanonicalPalletData(value: unknown, expectedRevision?: string): PalletDataV3 {
  const current = palletDataSchema.safeParse(value);
  const source = current.success ? current.data : palletLabelSourceSchema.parse(value);
  if (expectedRevision !== undefined && source.revision !== expectedRevision)
    throw new Error("WAREHOUSE_PALLET_SOURCE_CORRUPT");
  return source.version === 3 ? source : palletDataFromLegacySource(source);
}
/** A unit or box scan never expands into its containing pallet. */
export async function resolveReprintTarget(
  client: StationClient,
  exec: SqlExecutor,
  owner: string,
  raw: string,
  operatorId: string,
): Promise<ReprintTarget> {
  const scan = resolveWarehouseReprintScan(raw);
  if (scan.kind === "invalid") throw new Error("WAREHOUSE_SCAN_INVALID");
  if (scan.kind === "unit") return { kind: "unit" };
  const sscc = scan.sscc;
  await recoverLegacyProductionPalletDeliveries(exec, owner, sscc);
  const membership = await palletMembership(exec, sscc);
  const [box] = await exec.all(
    "SELECT 1 FROM boxes_mirror WHERE sscc=? UNION SELECT 1 FROM inventory_repack_boxes_mirror WHERE new_sscc=? LIMIT 1",
    [sscc, sscc],
  );
  if (membership && box) throw new Error("WAREHOUSE_PALLET_AMBIGUOUS");
  const [row] = await exec.all<{
    value_json: string;
    revision: string;
    receive_status: string;
    eligibility_denied: number;
    production_delivery_json: string | null;
  }>(
    `SELECT value_json,revision,receive_status,eligibility_denied,production_delivery_json FROM warehouse_pallet_sources WHERE owner IN (${AUTHORIZED_CREDENTIAL_OWNERS_SQL}) AND sscc=? ORDER BY rowid ASC LIMIT 1`,
    [owner, sscc],
  );
  const local = row ? readCanonicalPalletData(JSON.parse(row.value_json), row.revision) : null;
  let resolvedAttempt: string | null = null;
  if (row?.production_delivery_json) {
    const receipt = palletProductionDeliverySchema.parse(JSON.parse(row.production_delivery_json));
    const resolved =
      (await palletOriginalIsResolved(exec, owner, sscc, receipt)) ||
      (membership &&
        [membership.pallet.print_verified_at, membership.pallet.print_skipped_at].some(
          (at) => at !== null && Date.parse(at) >= Date.parse(receipt.occurredAt),
        ));
    if (resolved) resolvedAttempt = receipt.attemptId;
    if (receipt.state === "delivery_unknown" && !resolved)
      throw new PalletDeliveryError(
        "WAREHOUSE_PALLET_DELIVERY_UNRESOLVED",
        await localPalletDiagnostic(exec, owner, sscc),
      );
  }
  if (membership) {
    const [unknown] = await exec.all(
      "SELECT 1 FROM printer_deliveries WHERE scope=? AND purpose='pallet' AND job_id=? AND state IN ('prepared','sending','delivery_unknown') AND resolved_at IS NULL AND attempt_id IS NOT ? LIMIT 1",
      [
        JSON.stringify([membership.pallet.shift_id, membership.pallet.terminal_id]),
        sscc,
        resolvedAttempt,
      ],
    );
    if (unknown)
      throw new PalletDeliveryError(
        "WAREHOUSE_PALLET_DELIVERY_UNRESOLVED",
        await localPalletDiagnostic(exec, owner, sscc),
      );
  }
  const assertMembership = (data: PalletDataV3) => {
    if (
      membership &&
      (membership.pallet.shift_id !== data.shiftId ||
        membership.compositionDigest !== data.compositionDigest ||
        membership.pallet.box_count !== data.boxCount ||
        membership.pallet.item_count !== data.itemCount ||
        JSON.stringify(membership.boxes) !== JSON.stringify([...data.boxSsccs].sort()))
    )
      throw new Error("WAREHOUSE_PALLET_COMPOSITION_CHANGED");
  };
  const offline = (): ReprintTarget => {
    if (membership) {
      if (!local) throw new Error("WAREHOUSE_PALLET_SNAPSHOT_MISSING");
      if (row?.eligibility_denied || row?.receive_status === "conflict")
        throw new Error("WAREHOUSE_PALLET_COMPOSITION_CHANGED");
      assertMembership(local);
      return { kind: "pallet", data: local };
    }
    if (local) throw new Error("WAREHOUSE_PALLET_NETWORK_REQUIRED");
    return { kind: "box" }; // The box resolver still applies its own offline source guards.
  };
  let result;
  try {
    if (typeof navigator !== "undefined" && !navigator.onLine)
      throw new TypeError("Failed to fetch");
    result = unifiedLookupResultSchema.parse(
      await client.post("/station/warehouse-reprint/lookup-v3", {
        protocol: UNIFIED_REPRINT_PROTOCOL,
        raw,
        operatorId,
      }),
    );
  } catch (error) {
    if (warehouseNetworkUnavailable(error)) return offline();
    // A legacy box lookup remains authoritative for boxes. A missing V3 route
    // never permits a cached pallet to dispatch or create an unsyncable V3 job.
    if (error instanceof StationApiError && error.status === 404 && !membership && !local)
      return { kind: "box" };
    throw error;
  }
  if (result.status !== "found") {
    if (
      local &&
      membership &&
      result.status === "unavailable" &&
      result.code === "snapshot_missing"
    )
      return offline();
    if (local && membership && result.status === "not_found" && row?.receive_status === "pending") {
      const [queued] = await exec.all("SELECT 1 FROM outbox WHERE shift_id=? LIMIT 1", [
        local.shiftId,
      ]);
      if (queued) return offline();
    }
    if (result.status === "unavailable" && result.code === "delivery_unresolved")
      throw new PalletDeliveryError(
        "WAREHOUSE_PALLET_DELIVERY_UNRESOLVED",
        result.diagnostic ?? null,
      );
    throw new Error(
      result.status === "not_found"
        ? "WAREHOUSE_NOT_FOUND"
        : `WAREHOUSE_PALLET_${result.code.toUpperCase()}`,
    );
  }
  if (result.kind !== "pallet") {
    if (membership || local) throw new Error("WAREHOUSE_PALLET_AMBIGUOUS");
    return { kind: result.kind };
  }
  assertMembership(result.data);
  if (local && local.compositionDigest !== result.data.compositionDigest)
    throw new Error("WAREHOUSE_PALLET_COMPOSITION_CHANGED");
  await exec.run(
    `INSERT INTO warehouse_pallet_sources(owner,sscc,revision,value_json,receive_status) SELECT ?,?,?,?,'accepted' WHERE NOT EXISTS(SELECT 1 FROM warehouse_pallet_sources WHERE owner IN (${AUTHORIZED_CREDENTIAL_OWNERS_SQL}) AND sscc=?) ON CONFLICT DO NOTHING`,
    [owner, sscc, result.data.revision, JSON.stringify(result.data), owner, sscc],
  );
  return { kind: "pallet", data: result.data };
}
