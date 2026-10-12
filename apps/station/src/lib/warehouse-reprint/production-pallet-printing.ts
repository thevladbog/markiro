import { parseOrganizationBranding } from "../organization-branding.js";
import { productLabelBytesDigest, warehouseSourceSchema } from "@markiro/domain";
import type { BoxPrintInput, BoxPrintAttempt } from "../box-printing.js";
import type { CredentialGeneration } from "../credential-recovery.js";
import { acquireCredentialCommitLease } from "../credential-recovery.js";
import { bindPrintDestination } from "../print-destinations.js";
import {
  printerMode,
  outputPrinterProfile,
  serializePrinterOutput,
  type PrinterProfile,
} from "../printer-routing.js";
import {
  dispatchWindowsDelivery,
  prepareWindowsReprint,
  type DeliveryKey,
} from "../print-deliveries.js";
import { renderPrintArtifact } from "../print-artifact.js";
import { rasterizeDriverText } from "../rasterizer.js";
import {
  retainPalletClosureSource,
  retainProductionPalletSource,
  thermalPalletBranding,
} from "./pallet-sources.js";
/** Only the production-pallet path retains metadata; the shared box path is unchanged. */
export async function attemptProductionPalletPrint(
  input: BoxPrintInput & {
    generation: CredentialGeneration;
    owner: string;
    tenantId: string;
    sscc: string;
  },
): Promise<BoxPrintAttempt> {
  if (!input.template) return { kind: "failed", code: "template_missing" };
  if (!input.destination) return { kind: "failed", code: "persistence_failed" };
  const destination = input.destination;
  const lease = acquireCredentialCommitLease(input.generation);
  if (!lease) return { kind: "failed", code: "persistence_failed" };
  const current = () => !input.generation.sealed;
  try {
    let profile: PrinterProfile | null;
    try {
      profile = await bindPrintDestination(
        destination.exec,
        destination.key,
        input.printing ? outputPrinterProfile(input.printing) : null,
      );
    } catch {
      return { kind: "failed", code: "persistence_failed" };
    }
    const print = destination.print ?? input.printing?.print;
    if (!profile || !print) return { kind: "failed", code: "printer_unconfigured" };
    let bytes: Uint8Array;
    let key: DeliveryKey = destination.key;
    const retained = await retainPalletClosureSource(destination.exec, input.owner, input.sscc);
    if (retained?.rendering.kind === "a4") return { kind: "failed", code: "printer_unconfigured" };
    const fields =
        retained?.rendering.fields ?? warehouseSourceSchema.shape.fields.parse(input.fields),
      template = retained?.rendering.template ?? input.template;
    const logo = retained
      ? retained.rendering.brandingJson
        ? parseOrganizationBranding(retained.rendering.brandingJson).logo
        : null
      : template.elements.some((e) => e.kind === "organization_logo") && input.loadLogo
        ? await input.loadLogo()
        : null;
    const render = async () =>
      printerMode(profile) === "windows_driver"
        ? (await renderPrintArtifact(template, fields, profile, rasterizeDriverText, { logo }))
            .bytes
        : await input.render(template, fields, profile.language, profile.dpi, logo);
    try {
      const previous =
        input.explicitRetry && printerMode(profile) === "windows_driver"
          ? await prepareWindowsReprint(destination.exec, key, profile, render)
          : null;
      bytes = previous?.bytes ?? (await render());
      if (previous) key = previous.key;
    } catch {
      return { kind: "failed", code: "render_failed" };
    }
    try {
      const brandingJson = retained
        ? retained.rendering.brandingJson
        : await thermalPalletBranding(destination.exec, input.owner, input.tenantId, logo);
      await retainProductionPalletSource(
        destination.exec,
        input.owner,
        input.sscc,
        { kind: "thermal", rendererVersion: "thermal-v1", template, fields, brandingJson },
        {
          scope: key.scope,
          attemptId: key.attemptId,
          bytesDigest: productLabelBytesDigest(bytes),
          geometryFingerprint: null,
        },
      );
    } catch {
      return { kind: "failed", code: "persistence_failed" };
    }
    try {
      await serializePrinterOutput(profile.target, async () => {
        if (!current()) throw new Error("owner_changed");
        if (printerMode(profile) === "windows_driver")
          await dispatchWindowsDelivery(destination.exec, key, profile, bytes, undefined, current);
        else await print(profile.target, bytes);
      });
    } catch {
      return { kind: "failed", code: "transport_failed" };
    }
    return { kind: "printed", bytes };
  } finally {
    lease.release();
  }
}
