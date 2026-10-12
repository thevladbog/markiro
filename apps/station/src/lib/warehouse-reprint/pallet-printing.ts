import { bindPrintDestination } from "../print-destinations.js";
import { z } from "zod";
import {
  palletDataSchema,
  palletRenderingV3Schema,
  assertPalletRenderingV3MatchesData,
  palletSheetFactsFromData,
  UNIFIED_REPRINT_PROTOCOL,
  type PalletDataV3,
  type PalletRenderingV3,
  palletLabelSourceSchema,
  palletReprintEventSchema,
  palletReprintEventV2Schema,
  palletRenderingV2Schema,
  assertPalletRenderingMatchesSource,
  PALLET_REPRINT_V2_PROTOCOL,
  type PalletRenderingV2,
  validatePalletBranding,
  productLabelBytesDigest,
  productLabelValueDigest,
  type PalletLabelSourceV1,
} from "@markiro/domain";
import type { SqlExecutor } from "../mirror.js";
import {
  parsePrinterProfile,
  printerMode,
  serializePrinterOutput,
  type PrinterProfile,
} from "../printer-routing.js";
import { renderPrintArtifact } from "../print-artifact.js";
import { rasterizeDriverText, rasterizeText } from "../rasterizer.js";
import { parseOrganizationBranding } from "../organization-branding.js";
import {
  preparePalletSheet,
  parsePalletSheetPrintSnapshot,
} from "../pallet-sheet-print-snapshot.js";
import {
  dispatchWindowsDelivery,
  readPrintDelivery,
  type DeliveryKey,
} from "../print-deliveries.js";
import {
  tauriWindowsPrinting,
  bytesToBase64,
  type PrintTarget,
  type WindowsPrinting,
} from "../hardware.js";
import { AUTHORIZED_CREDENTIAL_OWNERS_SQL } from "../device-recovery.js";
import type { WarehouseSession } from "./types.js";
export interface PalletPrepareInput {
  exec: SqlExecutor;
  owner: string;
  accessOwner?: string;
  operatorId: string;
  reason: WarehouseSession["reason"];
  source: PalletLabelSourceV1;
  rendering?: PalletRenderingV2;
  sessionId?: string;
  profile: PrinterProfile;
  tenantId: string;
  render?: () => Promise<Uint8Array>;
  hardware?: WindowsPrinting;
}
export interface PalletDataPrepareInput extends Omit<PalletPrepareInput, "source" | "rendering"> {
  source: PalletDataV3;
  rendering: PalletRenderingV3;
}
type AnyPrepareInput = Omit<PalletPrepareInput, "source" | "rendering"> & {
  source: PalletLabelSourceV1 | PalletDataV3;
  rendering?: PalletRenderingV2 | PalletRenderingV3;
};
const rowSchema = z.object({
  owner: z.string(),
  job_id: z.uuid(),
  sscc: z.string(),
  source_revision: z.string(),
  source_json: z.string(),
  profile_json: z.string(),
  bytes_base64: z.string(),
  bytes_digest: z.string(),
  render_snapshot_json: z.string().nullable(),
  claim_id: z.string().nullable(),
  state: z.enum([
    "prepared",
    "sending",
    "sent",
    "failed_before_send",
    "delivery_unknown",
    "verified",
    "skipped",
  ]),
  event_json: z.string(),
  rendering_json: z.string().nullable().default(null),
  rendering_revision: z.string().nullable().default(null),
  protocol: z.string().nullable().default(null),
});
type Row = z.infer<typeof rowSchema>;
export interface PalletJobView {
  rendering: PalletRenderingV2 | null;
  deliveryScope: string;
  jobId: string;
  attemptId?: string;
  updatedAt?: string;
  source: PalletLabelSourceV1;
  profile: PrinterProfile;
  state: Row["state"];
}
export interface PalletDataJobView extends Omit<PalletJobView, "source" | "rendering"> {
  source: PalletDataV3;
  rendering: PalletRenderingV3;
}
function eventSchema(row: Pick<Row, "protocol">) {
  return row.protocol === PALLET_REPRINT_V2_PROTOCOL || row.protocol === UNIFIED_REPRINT_PROTOCOL
    ? palletReprintEventV2Schema
    : palletReprintEventSchema;
}
function decode(row: Row) {
  const source =
      row.protocol === UNIFIED_REPRINT_PROTOCOL
        ? palletDataSchema.parse(JSON.parse(row.source_json))
        : palletLabelSourceSchema.parse(JSON.parse(row.source_json)),
    profile = parsePrinterProfile(JSON.parse(row.profile_json)),
    event = eventSchema(row).parse(JSON.parse(row.event_json)),
    rendering = row.rendering_json
      ? row.protocol === UNIFIED_REPRINT_PROTOCOL
        ? palletRenderingV3Schema.parse(JSON.parse(row.rendering_json))
        : palletRenderingV2Schema.parse(JSON.parse(row.rendering_json))
      : null;
  if (rendering) {
    if (source.version === 3 && rendering.version === 3)
      assertPalletRenderingV3MatchesData(source, rendering);
    else if (source.version === 1 && rendering.version === 2)
      assertPalletRenderingMatchesSource(source, rendering);
    else throw new Error("WAREHOUSE_PALLET_SOURCE_CORRUPT");
    if (
      (row.protocol !== PALLET_REPRINT_V2_PROTOCOL && row.protocol !== UNIFIED_REPRINT_PROTOCOL) ||
      rendering.renderingRevision !== row.rendering_revision ||
      !("renderingRevision" in event) ||
      event.renderingRevision !== rendering.renderingRevision
    )
      throw new Error("WAREHOUSE_PALLET_SOURCE_CORRUPT");
  } else if (row.protocol !== null || row.rendering_revision !== null)
    throw new Error("WAREHOUSE_PALLET_SOURCE_CORRUPT");
  const bytes: Uint8Array = Uint8Array.from(atob(row.bytes_base64), (c) => c.charCodeAt(0));
  if (
    !profile ||
    source.revision !== row.source_revision ||
    source.sscc !== row.sscc ||
    event.jobId !== row.job_id ||
    event.sourceRevision !== source.revision ||
    productLabelBytesDigest(bytes) !== row.bytes_digest ||
    event.bytesDigest !== row.bytes_digest
  )
    throw new Error("WAREHOUSE_PALLET_SOURCE_CORRUPT");
  return { source, profile, event, bytes, rendering };
}
function view(row: Row): PalletJobView {
  const { source, profile, rendering, event } = decode(row);
  if (source.version !== 1 || rendering?.version === 3)
    throw new Error("WAREHOUSE_PALLET_SOURCE_CORRUPT");
  return {
    deliveryScope: JSON.stringify(["warehouse-pallet", row.owner, row.job_id]),
    jobId: row.job_id,
    attemptId: event.attemptId,
    updatedAt: event.occurredAt,
    rendering,
    source,
    profile,
    state: row.state,
  };
}
function dataView(row: Row): PalletDataJobView {
  const { source, profile, rendering, event } = decode(row);
  if (source.version !== 3 || rendering?.version !== 3)
    throw new Error("WAREHOUSE_PALLET_SOURCE_CORRUPT");
  return {
    deliveryScope: JSON.stringify(["warehouse-pallet", row.owner, row.job_id]),
    jobId: row.job_id,
    attemptId: event.attemptId,
    updatedAt: event.occurredAt,
    source,
    profile,
    rendering,
    state: row.state,
  };
}
export async function warehousePalletDataJobView(exec: SqlExecutor, owner: string, jobId: string) {
  return dataView(await read(exec, owner, jobId));
}
export async function findWarehousePalletDataJob(exec: SqlExecutor, owner: string) {
  const [row] = await exec.all(
    `SELECT * FROM warehouse_pallet_jobs WHERE owner IN (${AUTHORIZED_CREDENTIAL_OWNERS_SQL}) AND protocol='warehouse-unified-reprint-v3' AND state IN ('prepared','sending','failed_before_send','delivery_unknown') ORDER BY rowid DESC LIMIT 1`,
    [owner],
  );
  return row ? dataView(rowSchema.parse(row)) : null;
}
async function read(exec: SqlExecutor, owner: string, jobId: string) {
  const [value] = await exec.all(
    `SELECT * FROM warehouse_pallet_jobs WHERE owner IN (${AUTHORIZED_CREDENTIAL_OWNERS_SQL}) AND job_id=?`,
    [owner, jobId],
  );
  if (!value) throw new Error("WAREHOUSE_PALLET_SOURCE_CORRUPT");
  return rowSchema.parse(value);
}
export async function findWarehousePalletJob(exec: SqlExecutor, owner: string) {
  const [row] = await exec.all(
    `SELECT * FROM warehouse_pallet_jobs WHERE owner IN (${AUTHORIZED_CREDENTIAL_OWNERS_SQL}) AND (protocol IS NULL OR protocol<>'warehouse-unified-reprint-v3') AND state IN ('prepared','sending','failed_before_send','delivery_unknown') ORDER BY rowid DESC LIMIT 1`,
    [owner],
  );
  return row ? view(rowSchema.parse(row)) : null;
}
async function renderSource(input: AnyPrepareInput) {
  const profile = parsePrinterProfile(input.profile);
  let saved:
    | PalletLabelSourceV1["rendering"]
    | {
        kind: "a4";
        template: Extract<PalletRenderingV3["choice"], { kind: "a4" }>["snapshot"];
        facts: ReturnType<typeof palletSheetFactsFromData>;
        brandingJson: string;
      };
  if (input.source.version === 3) {
    if (input.rendering?.version !== 3) throw new Error("WAREHOUSE_PALLET_SOURCE_CORRUPT");
    assertPalletRenderingV3MatchesData(input.source, input.rendering);
    const chosen = input.rendering.choice;
    if (chosen.kind === "a4") {
      let brandingJson = input.rendering.brandingJson;
      if (brandingJson === null) {
        const [cached] = await input.exec.all<{ snapshot_json: string }>(
          `SELECT snapshot_json FROM station_organization_branding WHERE tenant_id=? AND owner_digest IN (${AUTHORIZED_CREDENTIAL_OWNERS_SQL}) ORDER BY rowid DESC LIMIT 1`,
          [input.tenantId, input.accessOwner ?? input.owner],
        );
        if (!cached) throw new Error("WAREHOUSE_PALLET_SNAPSHOT_MISSING");
        brandingJson = cached.snapshot_json;
      }
      saved = {
        kind: "a4",
        template: chosen.snapshot,
        facts: palletSheetFactsFromData(input.source),
        brandingJson,
      };
    } else
      saved = {
        kind: "thermal",
        rendererVersion: "thermal-v1",
        template: chosen.snapshot,
        fields: input.source.fields,
        brandingJson: input.rendering.brandingJson,
      };
  } else {
    const source = palletLabelSourceSchema.parse(input.source);
    saved = source.rendering;
    if (input.rendering) {
      if (input.rendering.version !== 2) throw new Error("WAREHOUSE_PALLET_SOURCE_CORRUPT");
      assertPalletRenderingMatchesSource(source, input.rendering);
      saved = input.rendering.rendering;
    }
  }
  if (!profile || profile.dpi === null) throw new Error("WAREHOUSE_PRINTER_DPI");
  if (saved.kind === "a4") {
    if (profile.paper !== "a4" || profile.target.kind !== "usb")
      throw new Error("WAREHOUSE_PALLET_PRINTER_FORMAT");
    const hardware = input.hardware ?? tauriWindowsPrinting;
    if (!hardware.getWindowsPageGeometry) throw new Error("WAREHOUSE_PALLET_PRINTER_FORMAT");
    const old = parseOrganizationBranding(saved.brandingJson);
    if (old.tenantId !== input.tenantId) throw new Error("WAREHOUSE_OWNER_CHANGED");
    const original = validatePalletBranding(saved.brandingJson);
    const { digest: ignored, ...content } = original;
    void ignored;
    const rebound = { ...content, ownerDigest: input.owner };
    const branding = parseOrganizationBranding(
      JSON.stringify({ ...rebound, digest: productLabelValueDigest(rebound) }),
    );
    const geometry = await hardware.getWindowsPageGeometry(profile.target.printer, {
      mode: "a4_sheet",
      orientation: saved.template.spec.page.orientation,
    });
    return preparePalletSheet(
      {
        profile,
        template: saved.template,
        facts: saved.facts,
        branding,
        geometry,
      },
      rasterizeDriverText,
    );
  }
  if (profile.paper === "a4") throw new Error("WAREHOUSE_PALLET_PRINTER_FORMAT");
  const branding =
    saved.brandingJson === null ? null : parseOrganizationBranding(saved.brandingJson);
  if (branding && branding.tenantId !== input.tenantId) throw new Error("WAREHOUSE_OWNER_CHANGED");
  const bytes = input.render
    ? await input.render()
    : (
        await renderPrintArtifact(
          saved.template,
          saved.fields,
          profile,
          printerMode(profile) === "windows_driver" ? rasterizeDriverText : rasterizeText,
          { logo: branding?.logo ?? null },
        )
      ).bytes;
  return { bytes, renderSnapshot: null };
}
async function createWarehousePalletJob(input: AnyPrepareInput): Promise<Row> {
  const { bytes, renderSnapshot } = await renderSource(input),
    jobId = crypto.randomUUID();
  const event = (input.rendering ? palletReprintEventV2Schema : palletReprintEventSchema).parse({
    ...(input.rendering ? { renderingRevision: input.rendering.renderingRevision } : {}),
    eventId: crypto.randomUUID(),
    jobId,
    attemptId: crypto.randomUUID(),
    sscc: input.source.sscc,
    sourceRevision: input.source.revision,
    operatorId: input.operatorId,
    reason: input.reason,
    occurredAt: new Date().toISOString(),
    state: "prepared",
    printFormat:
      printerMode(input.profile) === "windows_driver" ? "mono-raster-v1" : input.profile.language,
    bytesDigest: productLabelBytesDigest(bytes),
  });
  await input.exec.run(
    "INSERT INTO warehouse_pallet_jobs(owner,job_id,sscc,source_revision,source_json,profile_json,bytes_base64,bytes_digest,state,event_json,render_snapshot_json,rendering_json,rendering_revision,protocol,session_id) VALUES(?,?,?,?,?,?,?,?,'prepared',?,?,?,?,?,?)",
    [
      input.owner,
      jobId,
      input.source.sscc,
      input.source.revision,
      JSON.stringify(input.source),
      JSON.stringify(input.profile),
      bytesToBase64(bytes),
      event.bytesDigest,
      JSON.stringify(event),
      renderSnapshot ? JSON.stringify(renderSnapshot) : null,
      input.rendering ? JSON.stringify(input.rendering) : null,
      input.rendering?.renderingRevision ?? null,
      input.rendering
        ? input.rendering.version === 3
          ? UNIFIED_REPRINT_PROTOCOL
          : PALLET_REPRINT_V2_PROTOCOL
        : null,
      input.sessionId ?? null,
    ],
  );
  return read(input.exec, input.accessOwner ?? input.owner, jobId);
}
export async function prepareWarehousePalletJob(input: PalletPrepareInput): Promise<PalletJobView> {
  return view(await createWarehousePalletJob(input));
}
export async function prepareWarehousePalletDataJob(
  input: PalletDataPrepareInput,
): Promise<PalletDataJobView> {
  return dataView(await createWarehousePalletJob(input));
}
const live = new Set<string>();
function key(
  row: Row,
  event: ReturnType<typeof palletReprintEventSchema.parse>,
): DeliveryKey & { purpose: "pallet" } {
  return {
    scope: JSON.stringify(["warehouse-pallet", row.owner, row.job_id]),
    purpose: "pallet",
    jobId: row.sscc,
    attemptId: event.attemptId,
  };
}
async function stateEvent(
  exec: SqlExecutor,
  row: Row,
  state: ReturnType<typeof palletReprintEventSchema.parse>["state"],
  operatorId: string,
) {
  const event = eventSchema(row).parse({
    ...JSON.parse(row.event_json),
    eventId: crypto.randomUUID(),
    state,
    operatorId,
    occurredAt: new Date().toISOString(),
  });
  await exec.run(
    "UPDATE warehouse_pallet_jobs SET state=?,event_json=? WHERE owner=? AND job_id=? AND state=? AND claim_id IS ? AND event_json=?",
    [state, JSON.stringify(event), row.owner, row.job_id, row.state, row.claim_id, row.event_json],
  );
}
export async function sendWarehousePalletJob(input: {
  exec: SqlExecutor;
  owner: string;
  operatorId: string;
  jobId: string;
  profile: PrinterProfile;
  isCurrent: () => boolean;
  print: (target: PrintTarget, bytes: Uint8Array) => Promise<void>;
  retry?: boolean;
  tenantId?: string;
  hardware?: WindowsPrinting;
}): Promise<void> {
  let row = await read(input.exec, input.owner, input.jobId);
  const liveKey = JSON.stringify([row.owner, row.job_id]);
  if (live.has(liveKey)) return;
  if (!input.isCurrent()) throw new Error("WAREHOUSE_OWNER_CHANGED");
  if (row.state !== "prepared" && !input.retry) return;
  if (!["prepared", "failed_before_send", "delivery_unknown"].includes(row.state)) return;
  live.add(liveKey);
  try {
    const decoded = decode(row),
      source = decoded.source;
    let { profile, event, bytes } = decoded;
    let snapshot = row.render_snapshot_json;
    if (row.state !== "prepared") {
      if (
        row.state === "delivery_unknown" &&
        productLabelValueDigest(profile) !==
          productLabelValueDigest(parsePrinterProfile(input.profile))
      )
        throw new Error("WAREHOUSE_PRINTER_CHANGED");
      if (row.state === "failed_before_send") {
        const rendered = await renderSource({
          exec: input.exec,
          owner: input.owner,
          operatorId: input.operatorId,
          reason: event.reason,
          source,
          ...(decoded.rendering ? { rendering: decoded.rendering } : {}),
          profile: input.profile,
          tenantId: input.tenantId ?? "",
          ...(input.hardware ? { hardware: input.hardware } : {}),
        });
        bytes = rendered.bytes;
        profile = input.profile;
        snapshot = rendered.renderSnapshot ? JSON.stringify(rendered.renderSnapshot) : null;
      } else if (snapshot) {
        const old = parsePalletSheetPrintSnapshot(snapshot),
          { digest: ignored, ...content } = old;
        void ignored;
        const replay = {
          ...content,
          replayOf: {
            attemptId: event.attemptId,
            artifactDigest: row.bytes_digest,
            geometryFingerprint: old.geometry.fingerprint,
          },
        };
        snapshot = JSON.stringify({ ...replay, digest: productLabelValueDigest(replay) });
      }
      event = eventSchema(row).parse({
        ...event,
        eventId: crypto.randomUUID(),
        attemptId: crypto.randomUUID(),
        operatorId: input.operatorId,
        state: "prepared",
        bytesDigest: productLabelBytesDigest(bytes),
        printFormat:
          printerMode(profile) === "windows_driver" ? "mono-raster-v1" : profile.language,
        occurredAt: new Date().toISOString(),
      });
      await input.exec.run(
        "UPDATE warehouse_pallet_jobs SET state='prepared',profile_json=?,bytes_base64=?,bytes_digest=?,event_json=?,render_snapshot_json=? WHERE owner=? AND job_id=? AND state IN ('failed_before_send','delivery_unknown')",
        [
          JSON.stringify(profile),
          bytesToBase64(bytes),
          event.bytesDigest,
          JSON.stringify(event),
          snapshot,
          row.owner,
          row.job_id,
        ],
      );
      row = await read(input.exec, input.owner, input.jobId);
    } else if (
      productLabelValueDigest(profile) !==
      productLabelValueDigest(parsePrinterProfile(input.profile))
    )
      throw new Error("WAREHOUSE_PRINTER_CHANGED");
    const claim = crypto.randomUUID();
    await input.exec.run(
      "UPDATE warehouse_pallet_jobs SET state='sending',claim_id=? WHERE owner=? AND job_id=? AND state='prepared'",
      [claim, row.owner, row.job_id],
    );
    row = await read(input.exec, input.owner, input.jobId);
    if (row.claim_id !== claim) return;
    const outcome: { state: "sent" | "failed_before_send" | "delivery_unknown" } = {
      state: "delivery_unknown",
    };
    try {
      await serializePrinterOutput(profile.target, async () => {
        if (!input.isCurrent()) {
          outcome.state = "failed_before_send";
          throw new Error("WAREHOUSE_OWNER_CHANGED");
        }
        if (printerMode(profile) === "windows_driver") {
          await bindPrintDestination(input.exec, key(row, event), profile);
          await dispatchWindowsDelivery(
            input.exec,
            key(row, event),
            profile,
            bytes,
            input.hardware ?? tauriWindowsPrinting,
            input.isCurrent,
            undefined,
            snapshot,
          );
        } else await input.print(profile.target, bytes);
      });
      outcome.state = "sent";
    } catch {
      if (printerMode(profile) === "windows_driver" && outcome.state !== "failed_before_send") {
        const delivery = await readPrintDelivery(input.exec, key(row, event));
        outcome.state =
          delivery?.state === "failed_before_send"
            ? "failed_before_send"
            : delivery?.state === "sent"
              ? "sent"
              : "delivery_unknown";
      }
    }
    await stateEvent(input.exec, row, outcome.state, input.operatorId);
  } finally {
    live.delete(liveKey);
  }
}
export async function recoverWarehousePalletJobs(
  exec: SqlExecutor,
  owner: string,
  operatorId: string,
) {
  const rows = await exec.all(
    `SELECT * FROM warehouse_pallet_jobs WHERE owner IN (${AUTHORIZED_CREDENTIAL_OWNERS_SQL}) AND state='sending'`,
    [owner],
  );
  for (const value of rows) {
    const row = rowSchema.parse(value);
    if (live.has(JSON.stringify([row.owner, row.job_id]))) continue;
    const { event } = decode(row);
    const delivery = await readPrintDelivery(exec, key(row, event));
    await stateEvent(
      exec,
      row,
      delivery?.state === "sent"
        ? "sent"
        : delivery?.state === "failed_before_send"
          ? "failed_before_send"
          : "delivery_unknown",
      operatorId,
    );
  }
}
export async function settleWarehousePalletJob(
  exec: SqlExecutor,
  owner: string,
  jobId: string,
  operatorId: string,
  state: "verified" | "skipped",
) {
  const row = await read(exec, owner, jobId);
  if (live.has(JSON.stringify([row.owner, row.job_id]))) throw new Error("WAREHOUSE_BUSY");
  if (
    row.state === "sending" ||
    (state === "verified" && !["sent", "delivery_unknown"].includes(row.state)) ||
    (state === "skipped" &&
      !["prepared", "failed_before_send", "delivery_unknown"].includes(row.state))
  )
    throw new Error("WAREHOUSE_RECOVERY_REQUIRED");
  await stateEvent(exec, row, state, operatorId);
}
export async function warehousePalletJobView(exec: SqlExecutor, owner: string, jobId: string) {
  return view(await read(exec, owner, jobId));
}
