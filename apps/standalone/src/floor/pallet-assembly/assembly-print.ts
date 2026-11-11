import {
  DomainError,
  labelTemplateUsesField,
  LOT_NUMBER_LABEL_FIELD,
  palletLabelFields,
  type LabelTemplateSpec,
} from "@markiro/domain";
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
  hasLotNumber = false,
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
  const fits = (id: string | null) => {
    const sibling = hasLotNumber
      ? templates.find((candidate) => candidate.enabled && candidate.lotNumberSourceId === id)
      : undefined;
    return checkTemplate(templates, sibling?.id ?? id, "pallet", product.chzGroupCode);
  };
  const preferred = fits(preference?.default_pallet_template_id ?? null);
  if (preferred.kind === "ok") return preferred.spec;
  const fallback = fits(defaults.pallet);
  if (fallback.kind === "ok") return fallback.spec;
  const matching = templates
    .map((template) => checkTemplate(templates, template.id, "pallet", product.chzGroupCode))
    .filter((result) => result.kind === "ok");
  const candidates = matching.filter(
    ({ template }) => !matching.some((base) => base.template.id === template.lotNumberSourceId),
  );
  const [only] = candidates;
  if (candidates.length !== 1 || only === undefined) return null;
  const selected = fits(only.template.id);
  return selected.kind === "ok" ? selected.spec : only.spec;
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
    lotNumber: label.lotNumber ?? null,
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
  if (
    pallet.label.lotNumber != null &&
    !labelTemplateUsesField(pallet.label.template, LOT_NUMBER_LABEL_FIELD)
  ) {
    return store.finishPrint(pallet.id, "failed", "lot_template_missing");
  }
  try {
    bytes = await render(pallet.label.template, assemblyLabelFields(pallet), printer);
  } catch (error) {
    const code =
      error instanceof DomainError && error.code === "LABEL_LOT_NUMBER_OVERFLOW"
        ? "lot_template_overflow"
        : "render_failed";
    return store.finishPrint(pallet.id, "failed", code);
  }
  if (!canSend()) return store.finishPrint(pallet.id, "failed", "not_sent");
  const answer = settleOutcome(
    await printing.send(pallet.id, printer.target, bytes, printerMode(printer)),
  );
  return store.finishPrint(pallet.id, answer.state, "code" in answer ? answer.code : undefined);
}
