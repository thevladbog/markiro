import { palletLabelFields, type LabelTemplateSpec } from "@markiro/domain";
import { z } from "zod";

import { issuerPrefix, THIRTEEN_DIGITS } from "../../lib/rules.js";
import type { LocalExecutor } from "../../local/executor.js";
import type { LabelFields } from "../print/label-render.js";
import { settleOutcome, type RenderLabel } from "../print/print-jobs.js";
import type { PrintRuntime } from "../print/print-runtime.js";
import { printerMode, type PrinterProfile } from "../setup/workstation-settings.js";
import {
  checkTemplate,
  readOrgDefaults,
  readWarehouseTemplates,
} from "../warehouse/warehouse-templates.js";
import type { PalletAssemblyPallet, PalletAssemblyStore } from "./contracts.js";

const glnRow = z.object({ gln: z.string().nullable() });
const preferenceRow = z.object({ default_pallet_template_id: z.string().nullable() });

export async function assemblyIssuerPrefix(local: LocalExecutor): Promise<string | null> {
  const [org] = await local.query("SELECT gln FROM ref_org", [], glnRow);
  const gln = org?.gln;
  return gln != null && THIRTEEN_DIGITS.test(gln) ? issuerPrefix(gln) : null;
}

export async function assemblyTemplate(
  local: LocalExecutor,
  product: PalletAssemblyPallet["product"],
): Promise<LabelTemplateSpec | null> {
  const [templates, defaults, [preference]] = await Promise.all([
    readWarehouseTemplates(local),
    readOrgDefaults(local),
    local.query(
      "SELECT default_pallet_template_id FROM ref_products WHERE id = ?",
      [product.id],
      preferenceRow,
    ),
  ]);
  const fits = (id: string | null) => checkTemplate(templates, id, "pallet", product.chzGroupCode);
  const preferred = fits(preference?.default_pallet_template_id ?? null);
  if (preferred.kind === "ok") return preferred.spec;
  const fallback = fits(defaults.pallet);
  if (fallback.kind === "ok") return fallback.spec;
  const matching = templates
    .map((template) => fits(template.id))
    .filter((result) => result.kind === "ok");
  return matching.length === 1 ? (matching[0]?.spec ?? null) : null;
}

export function assemblyLabelFields(pallet: PalletAssemblyPallet): LabelFields {
  const { closedAt, sscc, label, product } = pallet;
  if (closedAt === null || sscc === null || label === null) {
    throw new Error("A label requires a frozen closed pallet");
  }
  const fields = palletLabelFields({
    sscc,
    closedAt,
    boxCount: label.boxCount,
    itemCount: label.itemCount,
    productName: product.name,
    productPrintName: product.printName,
    gtin14: product.gtin14,
    egaisCode: null,
    shelfLifeDays: product.shelfLifeDays,
    operatorName: null,
    counterpartyName: null,
    productionDate: label.productionDate,
    shiftNumber: null,
  });
  return label.productionDate === null ? { ...fields, date: "", expiry: "" } : fields;
}

interface AssemblyPrintRequest {
  store: Pick<PalletAssemblyStore, "startPrint" | "finishPrint">;
  pallet: PalletAssemblyPallet;
  printer: PrinterProfile;
  printing: PrintRuntime;
  render: RenderLabel;
  allowUnknown?: boolean;
  canSend?: () => boolean;
}

/** Claims the job before rendering or sending. A lost response remains an explicit operator decision. */
export async function sendAssemblyLabel({
  store,
  pallet,
  printer,
  printing,
  render,
  allowUnknown,
  canSend = () => true,
}: AssemblyPrintRequest): Promise<boolean> {
  if (
    !canSend() ||
    pallet.label === null ||
    printer.paper === "a4" ||
    printing.isInFlight(pallet.id)
  )
    return false;
  if (!(await store.startPrint(pallet.id, pallet.labelVersion, allowUnknown))) return false;
  let bytes: Uint8Array;
  try {
    bytes = await render(pallet.label.template, assemblyLabelFields(pallet), printer);
  } catch {
    return store.finishPrint(pallet.id, "failed", "render_failed");
  }
  if (!canSend()) return store.finishPrint(pallet.id, "failed", "not_sent");
  const answer = settleOutcome(
    await printing.send(pallet.id, printer.target, bytes, printerMode(printer)),
  );
  return store.finishPrint(pallet.id, answer.state, "code" in answer ? answer.code : undefined);
}
