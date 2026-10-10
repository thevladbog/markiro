import { productLabelBytesDigest, productLabelValueDigest } from "@markiro/domain";
import type { SqlExecutor } from "./mirror.js";
import { tauriWindowsPrinting, type WindowsPrinting } from "./hardware.js";
import { bindPrintDestination } from "./print-destinations.js";
import {
  dispatchWindowsDelivery,
  preparePrintDelivery,
  recoverPrintDeliveries,
  resolvePrintDelivery,
  type DeliveryKey,
  type PrintDeliveryRow,
} from "./print-deliveries.js";
import {
  parsePalletSheetPrintSnapshot,
  rebuildPalletSheet,
  type PalletSheetPrintSnapshotV1,
} from "./pallet-sheet-print-snapshot.js";
import { rasterizeDriverText } from "./rasterizer.js";
import { parsePrinterProfile, type PrinterProfile } from "./printer-routing.js";
import { parseOrganizationBranding } from "./organization-branding.js";
import { credentialOwnsRetainedWork } from "./device-recovery.js";
export interface PreparedPalletSheet {
  bytes: Uint8Array;
  renderSnapshot: PalletSheetPrintSnapshotV1;
}
/** Caller owns the credential/production lease; this function never retries automatically. */
export async function printPalletSheet(input: {
  exec: SqlExecutor;
  key: DeliveryKey & { purpose: "pallet" };
  profile: PrinterProfile;
  prepare: () => Promise<PreparedPalletSheet>;
  explicitRetry: boolean;
  isCurrent: () => boolean;
  owner: { tenantId: string; ownerDigest: string };
  hardware?: WindowsPrinting;
}): Promise<Uint8Array> {
  const { exec } = input,
    profile = parsePrinterProfile(input.profile),
    hardware = input.hardware ?? tauriWindowsPrinting;
  if (!profile || profile.paper !== "a4" || profile.target.kind !== "usb")
    throw new Error("A4 Windows printer required");
  if (!input.isCurrent()) throw new Error("owner_changed");
  const initialBound = await bindPrintDestination(exec, input.key, profile);
  if (!initialBound || JSON.stringify(initialBound) !== JSON.stringify(profile))
    throw new Error("Print destination changed");
  await recoverPrintDeliveries(exec);
  const [previous] = await exec.all<PrintDeliveryRow>(
    "SELECT * FROM printer_deliveries WHERE scope=? AND purpose=? AND job_id=? ORDER BY updated_at DESC,rowid DESC LIMIT 1",
    [input.key.scope, input.key.purpose, input.key.jobId],
  );
  let key = input.key,
    prepared: PreparedPalletSheet;
  if (previous) {
    if (previous.state === "sending" || (!input.explicitRetry && previous.state !== "prepared"))
      throw new Error("PRINT_DELIVERY_REQUIRES_RECOVERY");
    if (!previous.render_snapshot_json) throw new Error("Saved label is not an A4 sheet");
    const saved = parsePalletSheetPrintSnapshot(previous.render_snapshot_json);
    const branding = parseOrganizationBranding(saved.brandingJson);
    if (
      branding.tenantId !== input.owner.tenantId ||
      !(await credentialOwnsRetainedWork(exec, input.owner.ownerDigest, branding.ownerDigest))
    )
      throw new Error("Sheet owner changed");
    if (
      saved.replayOf === null &&
      (previous.state === "failed_before_send" ||
        (previous.state === "prepared" && input.explicitRetry))
    ) {
      // Reprepare from the previous attempt's own facts/spec/resources, never the catalog.
      if (!hardware.getWindowsPageGeometry) throw new Error("A4 support unavailable");
      const geometry = await hardware.getWindowsPageGeometry(profile.target.printer, {
        mode: "a4_sheet",
        orientation: saved.template.spec.page.orientation,
      });
      const { digest: oldDigest, ...content } = saved;
      void oldDigest;
      const updated = { ...content, geometry };
      const renderSnapshot = parsePalletSheetPrintSnapshot(
        JSON.stringify({ ...updated, digest: productLabelValueDigest(updated) }),
      );
      prepared = {
        bytes: await rebuildPalletSheet(renderSnapshot, rasterizeDriverText),
        renderSnapshot,
      };
    } else {
      const bytes = previous.artifact_base64
        ? Uint8Array.from(atob(previous.artifact_base64), (c) => c.charCodeAt(0))
        : await rebuildPalletSheet(saved, rasterizeDriverText);
      if (productLabelBytesDigest(bytes) !== previous.artifact_digest)
        throw new Error("Saved sheet raster changed");
      if (previous.state === "delivery_unknown" && saved.replayOf === null) {
        const { digest: ignored, ...content } = saved;
        void ignored;
        const replay = {
          ...content,
          replayOf: {
            attemptId: previous.attempt_id,
            artifactDigest: previous.artifact_digest,
            geometryFingerprint: saved.geometry.fingerprint,
          },
        };
        prepared = {
          bytes,
          renderSnapshot: parsePalletSheetPrintSnapshot(
            JSON.stringify({ ...replay, digest: productLabelValueDigest(replay) }),
          ),
        };
      } else prepared = { bytes, renderSnapshot: saved };
    }
    key = {
      ...input.key,
      attemptId:
        previous.state === "prepared" && !input.explicitRetry
          ? previous.attempt_id
          : crypto.randomUUID(),
    };
  } else prepared = await input.prepare();
  const branding = parseOrganizationBranding(prepared.renderSnapshot.brandingJson);
  if (
    branding.tenantId !== input.owner.tenantId ||
    !(await credentialOwnsRetainedWork(exec, input.owner.ownerDigest, branding.ownerDigest))
  )
    throw new Error("Sheet owner changed");
  if (!input.isCurrent()) throw new Error("owner_changed");
  const bound = await bindPrintDestination(exec, key, profile);
  if (!bound || JSON.stringify(bound) !== JSON.stringify(profile))
    throw new Error("Print destination changed");
  const snapshot = JSON.stringify(prepared.renderSnapshot);
  await preparePrintDelivery(exec, key, profile, prepared.bytes, snapshot);
  if (previous && key.attemptId !== previous.attempt_id)
    await resolvePrintDelivery(exec, {
      scope: previous.scope,
      purpose: previous.purpose,
      jobId: previous.job_id,
      attemptId: previous.attempt_id,
    });
  await dispatchWindowsDelivery(
    exec,
    key,
    profile,
    prepared.bytes,
    hardware,
    input.isCurrent,
    undefined,
    snapshot,
  );
  return prepared.bytes;
}
