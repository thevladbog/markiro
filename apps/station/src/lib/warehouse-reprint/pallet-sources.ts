import { recoverLegacyProductionPalletDeliveries } from "./production-delivery.js";
import {
  PalletDeliveryError,
  localPalletDiagnostic,
  palletOriginalIsResolved,
} from "./pallet-resolutions.js";
import { z } from "zod";
import {
  palletDataFromLegacySource,
  palletDataSchema,
  makePalletLabelSource,
  palletCompositionDigest,
  labelTemplateSpecSchema,
  palletSheetTemplateSnapshotSchema,
  palletLabelSourceSchema,
  palletProductionDeliverySchema,
  palletLookupResultSchema,
  PALLET_REPRINT_PROTOCOL,
  PALLET_REPRINT_V2_PROTOCOL,
  palletLookupV2ResultSchema,
  palletDeliveryDiagnosticSchema,
  PALLET_PRODUCTION_DELIVERY_PROTOCOL,
  resolveWarehouseReprintScan,
  type PalletLabelSourceV1,
  type MonoBitmap,
} from "@markiro/domain";
import type { SqlExecutor } from "../mirror.js";
import type { StationClient } from "../api-client.js";
import { StationApiError } from "../api-client.js";
import {
  credentialOwnsRetainedWork,
  readDeviceRecovery,
  AUTHORIZED_CREDENTIAL_OWNERS_SQL,
} from "../device-recovery.js";
import { warehouseNetworkUnavailable } from "./sources.js";
import { syncWarehousePalletEvidence } from "./pallet-diagnostics.js";
import { loadPalletSheetPrintSnapshot } from "../pallet-sheet-print-snapshot.js";
interface Membership {
  sscc: string;
  pallet_id: string;
  shift_id: string;
  terminal_id: string | null;
  closed_at: string | null;
  print_verified_at: string | null;
  print_skipped_at: string | null;
  disassembled_at: string | null;
  print_state: string;
  box_count: number;
  item_count: number;
}
export async function palletMembership(
  exec: SqlExecutor,
  sscc: string,
): Promise<{ pallet: Membership; boxes: string[]; compositionDigest: string } | null> {
  const [pallet] = await exec.all<Membership>(
    `SELECT p.*,(SELECT COUNT(*) FROM boxes_mirror b WHERE b.pallet_id=p.pallet_id AND b.disassembled_at IS NULL AND b.closed_at IS NOT NULL) box_count,
    (SELECT COUNT(*) FROM codes_mirror c JOIN boxes_mirror b ON b.box_id=c.box_id WHERE b.pallet_id=p.pallet_id AND b.disassembled_at IS NULL) item_count
    FROM pallets_mirror p WHERE p.sscc=?`,
    [sscc],
  );
  if (!pallet) return null;
  if (!pallet.closed_at || pallet.disassembled_at || !pallet.box_count || !pallet.item_count)
    throw new Error("WAREHOUSE_PALLET_COMPOSITION_CHANGED");
  const [conflict] = await exec.all(
    `SELECT 1 FROM codes_mirror c JOIN boxes_mirror b ON b.box_id=c.box_id JOIN conflicts_mirror x ON x.code_hash=c.code_hash WHERE b.pallet_id=? LIMIT 1`,
    [pallet.pallet_id],
  );
  if (conflict) throw new Error("WAREHOUSE_PALLET_COMPOSITION_CHANGED");
  const rows = await exec.all<{ sscc: string }>(
    "SELECT sscc FROM boxes_mirror WHERE pallet_id=? AND disassembled_at IS NULL AND closed_at IS NOT NULL AND sscc IS NOT NULL ORDER BY sscc",
    [pallet.pallet_id],
  );
  const items = await exec.all<{ boxSscc: string; codeHash: string; acceptedAt: string }>(
    "SELECT b.sscc boxSscc,c.code_hash codeHash,c.scanned_at acceptedAt FROM codes_mirror c JOIN boxes_mirror b ON b.box_id=c.box_id WHERE b.pallet_id=? AND b.disassembled_at IS NULL",
    [pallet.pallet_id],
  );
  return {
    pallet,
    boxes: rows.map((b) => b.sscc),
    compositionDigest: palletCompositionDigest(items),
  };
}
export async function savePalletLabelSource(
  exec: SqlExecutor,
  owner: string,
  source: PalletLabelSourceV1,
) {
  const parsed = palletLabelSourceSchema.parse(source);
  await exec.run(
    `INSERT INTO warehouse_pallet_sources(owner,sscc,revision,value_json)
     SELECT ?,?,?,? WHERE NOT EXISTS(SELECT 1 FROM warehouse_pallet_sources WHERE owner IN (${AUTHORIZED_CREDENTIAL_OWNERS_SQL}) AND sscc=?) ON CONFLICT DO NOTHING`,
    [owner, parsed.sscc, parsed.revision, JSON.stringify(parsed), owner, parsed.sscc],
  );
  const [saved] = await exec.all<{ value_json: string }>(
    `SELECT value_json FROM warehouse_pallet_sources WHERE owner IN (${AUTHORIZED_CREDENTIAL_OWNERS_SQL}) AND sscc=? ORDER BY rowid ASC LIMIT 1`,
    [owner, parsed.sscc],
  );
  if (
    !saved ||
    palletLabelSourceSchema.parse(JSON.parse(saved.value_json)).revision !== parsed.revision
  )
    throw new Error("WAREHOUSE_PALLET_SOURCE_CONFLICT");
}
/** First production render is retained before transport; later recovery cannot replace it. */
export async function retainProductionPalletSource(
  exec: SqlExecutor,
  owner: string,
  sscc: string,
  rendering: PalletLabelSourceV1["rendering"],
  originalAttempt: PalletLabelSourceV1["originalAttempt"],
  canonical = false,
) {
  const [existing] = await exec.all(
    `SELECT 1 FROM warehouse_pallet_sources WHERE owner IN (${AUTHORIZED_CREDENTIAL_OWNERS_SQL}) AND sscc=? LIMIT 1`,
    [owner, sscc],
  );
  const membership = await palletMembership(exec, sscc);
  if (!membership?.pallet.closed_at) throw new Error("WAREHOUSE_PALLET_COMPOSITION_CHANGED");
  if (rendering.kind === "thermal") {
    const [closure] = await exec.all("SELECT 1 FROM warehouse_pallet_closures WHERE sscc=?", [
      sscc,
    ]);
    if (!closure) return; // Legacy thermal labels without a frozen context are not invented.
  }
  const source = makePalletLabelSource({
    version: 1,
    sscc,
    shiftId: membership.pallet.shift_id,
    closedAt: new Date(membership.pallet.closed_at).toISOString(),
    boxCount: membership.pallet.box_count,
    itemCount: membership.pallet.item_count,
    boxSsccs: membership.boxes,
    compositionDigest: membership.compositionDigest,
    rendering,
    originalAttempt,
  });
  if (existing) return source;
  if (canonical) {
    const data = palletDataFromLegacySource(source);
    await exec.run(
      `INSERT INTO warehouse_pallet_sources(owner,sscc,revision,value_json) SELECT ?,?,?,? WHERE NOT EXISTS(SELECT 1 FROM warehouse_pallet_sources WHERE owner IN (${AUTHORIZED_CREDENTIAL_OWNERS_SQL}) AND sscc=?) ON CONFLICT DO NOTHING`,
      [owner, data.sscc, data.revision, JSON.stringify(data), owner, data.sscc],
    );
  } else await savePalletLabelSource(exec, owner, source);
  return source;
}
export async function retainPalletClosureSource(
  exec: SqlExecutor,
  owner: string,
  sscc: string,
  paper?: "thermal" | "a4",
  canonical = false,
) {
  const [saved] = await exec.all<{ value_json: string }>(
    `SELECT value_json FROM warehouse_pallet_sources WHERE owner IN (${AUTHORIZED_CREDENTIAL_OWNERS_SQL}) AND sscc=? ORDER BY rowid ASC LIMIT 1`,
    [owner, sscc],
  );
  if (saved) {
    const parsed = palletLabelSourceSchema.safeParse(JSON.parse(saved.value_json));
    if (parsed.success) return parsed.data;
    palletDataSchema.parse(JSON.parse(saved.value_json));
  }
  const [closure] = await exec.all<{ context_json: string }>(
    "SELECT context_json FROM warehouse_pallet_closures WHERE sscc=?",
    [sscc],
  );
  if (!closure) return null;
  const membership = await palletMembership(exec, sscc);
  if (!membership) return null;
  if (closure) {
    const capture = z
      .object({
        thermalTemplate: z.unknown().optional(),
        sheetTemplate: z.unknown().optional(),
        brandingJson: z.string().nullable().optional(),
        boxSsccs: z.array(z.string()),
        items: z.array(
          z.object({ boxSscc: z.string(), codeHash: z.string(), acceptedAt: z.string() }),
        ),
      })
      .parse(JSON.parse(closure.context_json));
    if (
      palletCompositionDigest(capture.items) !== membership.compositionDigest ||
      JSON.stringify(capture.boxSsccs) !== JSON.stringify(membership.boxes)
    )
      throw new Error("WAREHOUSE_PALLET_COMPOSITION_CHANGED");
    const fields = await readProductionPalletFields(exec, sscc, {
      boxCount: capture.boxSsccs.length,
      itemCount: capture.items.length,
    });
    const parseSaved = (value: unknown) =>
      typeof value === "string" ? (JSON.parse(value) as unknown) : value;
    let rendering: PalletLabelSourceV1["rendering"] | null = null;
    if (
      fields &&
      paper !== "thermal" &&
      capture.sheetTemplate &&
      capture.brandingJson &&
      (paper === "a4" || !capture.thermalTemplate)
    )
      rendering = {
        kind: "a4",
        rendererVersion: "pallet-sheet-v1",
        template: palletSheetTemplateSnapshotSchema.parse(parseSaved(capture.sheetTemplate)),
        facts: fields.facts,
        brandingJson: capture.brandingJson,
      };
    else if (
      fields &&
      paper !== "a4" &&
      capture.thermalTemplate &&
      (paper === "thermal" || !capture.sheetTemplate)
    )
      rendering = {
        kind: "thermal",
        rendererVersion: "thermal-v1",
        template: labelTemplateSpecSchema.parse(parseSaved(capture.thermalTemplate)),
        fields: fields.fields,
        brandingJson: capture.brandingJson ?? null,
      };
    if (rendering) {
      if (rendering.brandingJson) {
        const recovery = await readDeviceRecovery(exec);
        const { parseOrganizationBranding } = await import("../organization-branding.js");
        const branding = parseOrganizationBranding(rendering.brandingJson);
        if (
          recovery?.owner &&
          (recovery.owner.tenantId !== branding.tenantId ||
            !(await credentialOwnsRetainedWork(exec, owner, branding.ownerDigest)))
        )
          throw new Error("WAREHOUSE_OWNER_CHANGED");
      }
      const created = await retainProductionPalletSource(
        exec,
        owner,
        sscc,
        rendering,
        null,
        canonical,
      );
      if (canonical || saved) return created ?? null;
      const [row] = await exec.all<{ value_json: string }>(
        `SELECT value_json FROM warehouse_pallet_sources WHERE owner IN (${AUTHORIZED_CREDENTIAL_OWNERS_SQL}) AND sscc=? ORDER BY rowid ASC LIMIT 1`,
        [owner, sscc],
      );
      return row ? palletLabelSourceSchema.parse(JSON.parse(row.value_json)) : null;
    }
  }
  return null;
}
async function localSource(exec: SqlExecutor, owner: string, sscc: string) {
  await recoverLegacyProductionPalletDeliveries(exec, owner, sscc);
  const membership = await palletMembership(exec, sscc);
  const [saved] = await exec.all<{
    value_json: string;
    eligibility_denied: number;
    receive_status: string;
    production_delivery_json: string | null;
  }>(
    `SELECT value_json,eligibility_denied,receive_status,production_delivery_json FROM warehouse_pallet_sources WHERE owner IN (${AUTHORIZED_CREDENTIAL_OWNERS_SQL}) AND sscc=? ORDER BY rowid DESC LIMIT 1`,
    [owner, sscc],
  );
  if (saved?.eligibility_denied || saved?.receive_status === "conflict")
    throw new Error("WAREHOUSE_PALLET_COMPOSITION_CHANGED");
  let resolvedAttempt: string | null = null;
  if (saved?.production_delivery_json) {
    const evidence = palletProductionDeliverySchema.parse(
      JSON.parse(saved.production_delivery_json),
    );
    const decision = await palletOriginalIsResolved(exec, owner, sscc, evidence);
    if (decision) resolvedAttempt = evidence.attemptId;
    const resolved =
      decision ||
      (membership &&
        [membership.pallet.print_verified_at, membership.pallet.print_skipped_at].some(
          (at) => at !== null && Date.parse(at) >= Date.parse(evidence.occurredAt),
        ));
    if (evidence.state !== "sent" && !resolved)
      throw new Error("WAREHOUSE_PALLET_DELIVERY_UNRESOLVED");
  }
  let source = saved ? palletLabelSourceSchema.parse(JSON.parse(saved.value_json)) : null;
  if (!source && membership) {
    const scope = JSON.stringify([membership.pallet.shift_id, membership.pallet.terminal_id]);
    const [delivery] = await exec.all<{
      render_snapshot_json: string;
      attempt_id: string;
      artifact_digest: string;
    }>(
      "SELECT render_snapshot_json,attempt_id,artifact_digest FROM printer_deliveries WHERE scope=? AND purpose='pallet' AND job_id=? AND render_snapshot_json IS NOT NULL AND (state='sent' OR resolved_at IS NOT NULL) ORDER BY updated_at DESC,rowid DESC LIMIT 1",
      [scope, sscc],
    );
    if (delivery) {
      const snapshot = await loadPalletSheetPrintSnapshot(exec, delivery.render_snapshot_json);
      const { parseOrganizationBranding } = await import("../organization-branding.js");
      const branding = parseOrganizationBranding(snapshot.brandingJson),
        recovery = await readDeviceRecovery(exec);
      if (
        !recovery?.owner ||
        recovery.owner.tenantId !== branding.tenantId ||
        !(await credentialOwnsRetainedWork(exec, owner, branding.ownerDigest))
      )
        throw new Error("WAREHOUSE_OWNER_CHANGED");
      await retainProductionPalletSource(
        exec,
        owner,
        sscc,
        {
          kind: "a4",
          rendererVersion: "pallet-sheet-v1",
          template: snapshot.template,
          facts: snapshot.facts,
          brandingJson: snapshot.brandingJson,
        },
        {
          scope,
          attemptId: delivery.attempt_id,
          bytesDigest: delivery.artifact_digest,
          geometryFingerprint: snapshot.geometry.fingerprint,
        },
      );
      const [row] = await exec.all<{ value_json: string }>(
        `SELECT value_json FROM warehouse_pallet_sources WHERE owner IN (${AUTHORIZED_CREDENTIAL_OWNERS_SQL}) AND sscc=? ORDER BY rowid ASC LIMIT 1`,
        [owner, sscc],
      );
      source = row ? palletLabelSourceSchema.parse(JSON.parse(row.value_json)) : null;
    }
  }
  if (!source && membership && ["printed", "skipped"].includes(membership.pallet.print_state))
    source = await retainPalletClosureSource(exec, owner, sscc);
  if (source && membership) {
    if (
      membership.compositionDigest !== source.compositionDigest ||
      membership.pallet.box_count !== source.boxCount ||
      membership.pallet.item_count !== source.itemCount ||
      JSON.stringify(membership.boxes) !== JSON.stringify([...source.boxSsccs].sort())
    )
      throw new Error("WAREHOUSE_PALLET_COMPOSITION_CHANGED");
    if (!["printed", "skipped"].includes(membership.pallet.print_state) && !resolvedAttempt)
      throw new Error("WAREHOUSE_PALLET_DELIVERY_UNRESOLVED");
    const [unknown] = await exec.all(
      "SELECT 1 FROM printer_deliveries WHERE scope=? AND purpose='pallet' AND job_id=? AND state IN ('sending','delivery_unknown','prepared') AND resolved_at IS NULL AND attempt_id IS NOT ? LIMIT 1",
      [
        JSON.stringify([membership.pallet.shift_id, membership.pallet.terminal_id]),
        sscc,
        resolvedAttempt,
      ],
    );
    if (unknown) throw new Error("WAREHOUSE_PALLET_DELIVERY_UNRESOLVED");
  }
  return source;
}
export async function resolveWarehousePalletSource(
  client: StationClient,
  exec: SqlExecutor,
  owner: string,
  raw: string,
  operatorId: string,
) {
  const scan = resolveWarehouseReprintScan(raw);
  if (scan.kind === "invalid") throw new Error("WAREHOUSE_SCAN_INVALID");
  const rows = await exec.all<{ sscc: string }>(
    scan.kind === "box"
      ? `SELECT sscc FROM pallets_mirror WHERE sscc=? UNION SELECT p.sscc FROM boxes_mirror b JOIN pallets_mirror p ON p.pallet_id=b.pallet_id WHERE b.sscc=? AND b.disassembled_at IS NULL`
      : `SELECT p.sscc FROM codes_mirror c JOIN boxes_mirror b ON b.box_id=c.box_id JOIN pallets_mirror p ON p.pallet_id=b.pallet_id WHERE c.code_hash=? AND b.disassembled_at IS NULL`,
    scan.kind === "box" ? [scan.sscc, scan.sscc] : [scan.codeHash],
  );
  const lookupKey = scan.kind === "box" ? `sscc:${scan.sscc}` : `unit:${scan.codeHash}`;
  if (!rows.length)
    rows.push(
      ...(await exec.all<{ sscc: string }>(
        `SELECT sscc FROM warehouse_pallet_sources WHERE owner IN (${AUTHORIZED_CREDENTIAL_OWNERS_SQL}) AND eligibility_denied=0 AND receive_status<>'conflict' AND (sscc=? OR EXISTS(SELECT 1 FROM json_each(value_json,'$.boxSsccs') WHERE value=?) OR EXISTS(SELECT 1 FROM json_each(lookup_keys_json) WHERE value=?))`,
        [
          owner,
          scan.kind === "box" ? scan.sscc : "",
          scan.kind === "box" ? scan.sscc : "",
          lookupKey,
        ],
      )),
    );
  const identities = [...new Set(rows.map((r) => r.sscc).filter(Boolean))];
  if (identities.length > 1) throw new Error("WAREHOUSE_PALLET_AMBIGUOUS");
  let local: PalletLabelSourceV1 | null = null,
    localError: Error | undefined;
  if (identities[0])
    try {
      local = await localSource(exec, owner, identities[0]);
    } catch (error) {
      localError = error instanceof Error ? error : new Error(String(error));
      if (localError.message === "WAREHOUSE_PALLET_DELIVERY_UNRESOLVED")
        localError = new PalletDeliveryError(
          localError.message,
          await localPalletDiagnostic(exec, owner, identities[0]),
        );
    }
  const offline = () => {
    if (localError) throw localError;
    if (!local) throw new Error("WAREHOUSE_PALLET_NETWORK_REQUIRED");
    return { source: local, offline: true };
  };
  if (typeof navigator !== "undefined" && !navigator.onLine) return offline();
  try {
    const caps = z
      .strictObject({ protocols: z.array(z.string()) })
      .parse(await client.get("/station/warehouse-reprint/source-capabilities"));
    if (!caps.protocols.includes(PALLET_REPRINT_PROTOCOL)) return offline();
    const v2 = caps.protocols.includes(PALLET_REPRINT_V2_PROTOCOL);
    const lookup = async () => {
      const response = await client.post(
        v2
          ? "/station/warehouse-reprint/pallet-lookup-v2"
          : "/station/warehouse-reprint/pallet-lookup",
        { protocol: v2 ? PALLET_REPRINT_V2_PROTOCOL : PALLET_REPRINT_PROTOCOL, raw, operatorId },
      );
      return v2
        ? palletLookupV2ResultSchema.parse(response)
        : palletLookupResultSchema.parse(response);
    };
    let result = await lookup();
    if (
      result.status === "unavailable" &&
      result.code === "delivery_unresolved" &&
      local &&
      !localError &&
      caps.protocols.includes(PALLET_PRODUCTION_DELIVERY_PROTOCOL)
    ) {
      try {
        if (await syncWarehousePalletEvidence(client, exec, owner, local.sscc)) {
          result = await lookup();
        }
      } catch (error) {
        // A failed repair must not turn an authoritative unresolved response into offline eligibility.
        throw new Error("WAREHOUSE_PALLET_DELIVERY_UNRESOLVED", { cause: error });
      }
    }
    if (result.status === "unavailable" && result.code === "delivery_unresolved") {
      const localDiagnostic = identities[0]
        ? await localPalletDiagnostic(exec, owner, identities[0])
        : null;
      const serverDiagnostic =
        "diagnostic" in result
          ? palletDeliveryDiagnosticSchema.nullable().parse(result.diagnostic)
          : null;
      const diagnostic = localDiagnostic ?? serverDiagnostic;
      if (
        local &&
        localDiagnostic &&
        serverDiagnostic &&
        localDiagnostic.attemptId === serverDiagnostic.attemptId &&
        localDiagnostic.productionSequence === serverDiagnostic.productionSequence &&
        localDiagnostic.sourceRevision === serverDiagnostic.sourceRevision &&
        (await palletOriginalIsResolved(exec, owner, local.sscc, {
          sourceRevision: local.revision,
          sequence: localDiagnostic.productionSequence ?? 0,
          attemptId: localDiagnostic.attemptId ?? "",
        }))
      )
        return { source: local, offline: true };
      throw new PalletDeliveryError("WAREHOUSE_PALLET_DELIVERY_UNRESOLVED", diagnostic);
    }
    if (result.status !== "found") {
      if (
        result.status === "unavailable" &&
        result.code === "snapshot_missing" &&
        local &&
        !localError
      )
        return { source: local, offline: false };
      if (result.status === "not_found" && local && !localError) {
        const [pending] = await exec.all(
          `SELECT 1 FROM warehouse_pallet_sources s JOIN warehouse_pallet_closures c ON c.sscc=s.sscc WHERE s.owner IN (${AUTHORIZED_CREDENTIAL_OWNERS_SQL}) AND s.sscc=? AND s.receive_status='pending' AND EXISTS(SELECT 1 FROM outbox WHERE shift_id=c.shift_id)`,
          [owner, local.sscc],
        );
        if (pending) return { source: local, offline: true };
      }
      if (
        identities[0] &&
        !(result.status === "unavailable" && result.code === "delivery_unresolved")
      )
        await exec.run(
          `UPDATE warehouse_pallet_sources SET eligibility_denied=1 WHERE owner IN (${AUTHORIZED_CREDENTIAL_OWNERS_SQL}) AND sscc=?`,
          [owner, identities[0]],
        );
      const message = `WAREHOUSE_PALLET_${result.status === "not_found" ? "NOT_FOUND" : result.code.toUpperCase()}`;
      if (result.status === "unavailable" && "diagnostic" in result)
        throw new PalletDeliveryError(
          message,
          palletDeliveryDiagnosticSchema.nullable().parse(result.diagnostic),
        );
      throw new Error(message);
    }
    const currentMembership = await palletMembership(exec, result.source.sscc);
    if (
      currentMembership &&
      (currentMembership.compositionDigest !== result.source.compositionDigest ||
        (!["printed", "skipped"].includes(currentMembership.pallet.print_state) && !local))
    )
      throw new Error("WAREHOUSE_PALLET_COMPOSITION_CHANGED");
    let authoritativeResolvedAttempt: string | null = null;
    const [localEvidence] = await exec.all<{ production_delivery_json: string | null }>(
      `SELECT production_delivery_json FROM warehouse_pallet_sources WHERE owner IN (${AUTHORIZED_CREDENTIAL_OWNERS_SQL}) AND sscc=? ORDER BY rowid DESC LIMIT 1`,
      [owner, result.source.sscc],
    );
    if (localEvidence?.production_delivery_json) {
      const evidence = palletProductionDeliverySchema.parse(
        JSON.parse(localEvidence.production_delivery_json),
      );
      const decision = await palletOriginalIsResolved(exec, owner, result.source.sscc, evidence);
      if (decision) authoritativeResolvedAttempt = evidence.attemptId;
      const resolved =
        decision ||
        (currentMembership &&
          [
            currentMembership.pallet.print_verified_at,
            currentMembership.pallet.print_skipped_at,
          ].some((at) => at !== null && Date.parse(at) >= Date.parse(evidence.occurredAt)));
      if (evidence.state !== "sent" && !resolved)
        throw new Error("WAREHOUSE_PALLET_DELIVERY_UNRESOLVED");
    }
    if (currentMembership) {
      const [unknown] = await exec.all(
        "SELECT 1 FROM printer_deliveries WHERE scope=? AND purpose='pallet' AND job_id=? AND state IN ('sending','delivery_unknown','prepared') AND resolved_at IS NULL AND attempt_id IS NOT ? LIMIT 1",
        [
          JSON.stringify([currentMembership.pallet.shift_id, currentMembership.pallet.terminal_id]),
          result.source.sscc,
          authoritativeResolvedAttempt,
        ],
      );
      if (unknown) throw new Error("WAREHOUSE_PALLET_DELIVERY_UNRESOLVED");
    }
    await savePalletLabelSource(exec, owner, result.source);
    await exec.run(
      `UPDATE warehouse_pallet_sources SET eligibility_denied=0,receive_status='accepted' WHERE rowid=(SELECT rowid FROM warehouse_pallet_sources WHERE owner IN (${AUTHORIZED_CREDENTIAL_OWNERS_SQL}) AND sscc=? ORDER BY rowid ASC LIMIT 1) AND revision=?`,
      [owner, result.source.sscc, result.source.revision],
    );
    await exec.run(
      `UPDATE warehouse_pallet_sources SET lookup_keys_json=json_insert(lookup_keys_json,'$[#]',?) WHERE rowid=(SELECT rowid FROM warehouse_pallet_sources WHERE owner IN (${AUTHORIZED_CREDENTIAL_OWNERS_SQL}) AND sscc=? ORDER BY rowid ASC LIMIT 1) AND revision=? AND json_array_length(lookup_keys_json)<1000 AND NOT EXISTS(SELECT 1 FROM json_each(lookup_keys_json) WHERE value=?)`,
      [lookupKey, owner, result.source.sscc, result.source.revision, lookupKey],
    );
    return { source: result.source, offline: false };
  } catch (error) {
    if (
      warehouseNetworkUnavailable(error) ||
      (error instanceof StationApiError && error.status === 404)
    )
      return offline();
    throw error;
  }
}
const closureContext = z.object({
  productName: z.string().nullable(),
  productPrintName: z.string().nullable(),
  gtin14: z.string().nullable(),
  egaisCode: z.string().nullable(),
  shelfLifeDays: z.number().int().nullable(),
  productionDate: z.string().nullable(),
  shiftNumber: z.string().nullable(),
  counterpartyName: z.string().nullable(),
  operatorName: z.string().nullable().optional(),
  acceptedLocalDate: z.string().optional(),
});
export async function readProductionPalletFields(
  exec: SqlExecutor,
  sscc: string,
  counts: { boxCount: number; itemCount: number },
) {
  const [row] = await exec.all<{ context_json: string; closed_at: string }>(
    "SELECT context_json,closed_at FROM warehouse_pallet_closures WHERE sscc=?",
    [sscc],
  );
  if (!row) return null;
  const c = closureContext.parse(JSON.parse(row.context_json));
  if (c.productName === null || c.gtin14 === null) return null;
  const { palletLabelFields } = await import("@markiro/domain");
  return {
    fields: palletLabelFields({
      ...c,
      productName: c.productName,
      gtin14: c.gtin14,
      ...counts,
      sscc,
      closedAt: row.closed_at,
      operatorName: c.operatorName ?? null,
      productionDate: c.productionDate ?? c.acceptedLocalDate ?? null,
    }),
    facts: {
      sscc,
      ...counts,
      productPrintName: c.productPrintName || c.productName,
      gtin14: c.gtin14,
      egaisCode: c.egaisCode,
      shelfLifeDays: c.shelfLifeDays,
      productionDate: c.productionDate,
      shiftNumber: c.shiftNumber,
    },
  };
}
export async function thermalPalletBranding(
  exec: SqlExecutor,
  owner: string,
  tenantId: string,
  logo: MonoBitmap | null,
) {
  if (!logo) return null;
  const [row] = await exec.all<{ snapshot_json: string }>(
    "SELECT snapshot_json FROM station_organization_branding WHERE tenant_id=? AND owner_digest=?",
    [tenantId, owner],
  );
  const { parseOrganizationBranding } = await import("../organization-branding.js");
  const { sheetLogoFingerprint } = await import("@markiro/domain");
  if (
    !row ||
    sheetLogoFingerprint(logo) !== parseOrganizationBranding(row.snapshot_json).logo.digest
  )
    throw new Error("WAREHOUSE_PALLET_SOURCE_CONFLICT");
  return row.snapshot_json;
}
