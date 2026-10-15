import {
  assertDuplicateTemplate,
  isValidGtin,
  labelTemplateSpecSchema,
  parsePalletSheetSpec,
  type LabelTemplateSpec,
  type MonoBitmap,
  type PalletSheetSpecV2,
} from "@markiro/domain";

import { shiftSnapshotSchema, type ShiftSnapshot } from "../../host/protocol.js";
import { logoFromWire } from "../../labels/logo.js";

/**
 * A snapshot this build can work a shift from: the host's frozen product,
 * issuer prefix and counterparty, and the box layout read by the domain's
 * `labelTemplateSpecSchema`, the model the label is printed from (stage 2a
 * spec, decisions 3 and 22).
 */
export interface CheckedSnapshot {
  product: ShiftSnapshot["product"];
  boxTemplate: SnapshotTemplate;
  issuerPrefix: string;
  counterpartyName: string | null;
  /** The pallet layout of a shift with pallets (plan ПЛ-Ц); `null` — a shift without. */
  palletTemplate: SnapshotTemplate | null;
  /** The A4 sheet (plan А4); `null` — none, or one this build does not read. */
  palletSheet: SnapshotSheet | null;
  /** The organization (plan А4); `null` — a snapshot of a host before it. */
  organization: SnapshotOrganization | null;
  /**
   * The Data Matrix duplicate a validation shift prints (plan РЕЖ part B): its
   * check and its layout, read by the domain as a duplicate's; `null` — the
   * shift prints none.
   */
  validationPrint: SnapshotValidationPrint | null;
}

/** The duplicate print a shift froze (plan РЕЖ part B): the check and the layout the domain read. */
export interface SnapshotValidationPrint {
  verification: "none" | "required";
  template: SnapshotTemplate;
}

/** A template as the snapshot froze it, with the layout the domain read. */
export interface SnapshotTemplate {
  id: string;
  name: string;
  rev: number;
  spec: LabelTemplateSpec;
}

/** The A4 sheet the shift froze, with the layout the domain read (plan А4). */
export interface SnapshotSheet {
  id: string;
  name: string;
  revision: number;
  spec: PalletSheetSpecV2;
}

/** The organization the shift froze (plan А4): its logo as a bitmap, or `null`. */
export interface SnapshotOrganization {
  name: string;
  inn: string | null;
  logo: MonoBitmap | null;
}

/**
 * Why a snapshot cannot be worked from: not a snapshot at all (`shape`), a
 * product GTIN that is no GTIN-14 (`gtin`), an issuer prefix that is not the
 * nine digits of a GLN (`prefix`), or a layout the domain does not read
 * (`layout`, a template a newer office made, or a damaged one).
 */
export type SnapshotRefusal = "shape" | "gtin" | "prefix" | "layout";

export type SnapshotCheck =
  { ok: true; snapshot: CheckedSnapshot } | { ok: false; reason: SnapshotRefusal };

const GTIN14 = /^[0-9]{14}$/;
const ISSUER_PREFIX = /^[0-9]{9}$/;

/** A frozen template whose layout the domain reads, or `null`. */
function readTemplate(template: {
  id: string;
  name: string;
  rev: number;
  spec: unknown;
}): SnapshotTemplate | null {
  const spec = labelTemplateSpecSchema.safeParse(template.spec);
  return spec.success
    ? { id: template.id, name: template.name, rev: template.rev, spec: spec.data }
    : null;
}

/**
 * Checks a shift's snapshot before the station works the shift: once when it
 * enters (the host never checks a layout, stage 2a spec §4.2) and again when
 * a stored one is read back. A snapshot that fails keeps the operator out of
 * the shift; nothing is printed from a layout the domain does not read. A
 * shift with pallets (`palletsEnabled`, plan ПЛ-Ц) needs its pallet layout as
 * well: a snapshot kept by a build before pallets has none, and the next
 * entry with the host brings it.
 */
export function checkShiftSnapshot(raw: unknown, palletsEnabled = false): SnapshotCheck {
  const parsed = shiftSnapshotSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, reason: "shape" };
  const { product, boxTemplate, issuerPrefix, counterpartyName } = parsed.data;
  if (!GTIN14.test(product.gtin14) || !isValidGtin(product.gtin14)) {
    return { ok: false, reason: "gtin" };
  }
  if (!ISSUER_PREFIX.test(issuerPrefix)) return { ok: false, reason: "prefix" };
  const box = readTemplate(boxTemplate);
  if (box === null) return { ok: false, reason: "layout" };
  const pallet =
    parsed.data.palletTemplate === undefined ? null : readTemplate(parsed.data.palletTemplate);
  if (palletsEnabled && pallet === null) return { ok: false, reason: "layout" };
  // A sheet or a logo this build cannot read keeps nobody out of the shift:
  // its thermal labels still print, and only an A4 print of it fails to render.
  const sheetRaw = parsed.data.palletSheet;
  let palletSheet: SnapshotSheet | null = null;
  if (palletsEnabled && sheetRaw !== undefined) {
    try {
      palletSheet = { ...sheetRaw, spec: parsePalletSheetSpec(sheetRaw.spec) };
    } catch {
      palletSheet = null;
    }
  }
  // The duplicate's layout keeps the operator out as the box's does (plan РЕЖ part B): a unit
  // is accepted with its label, so a layout the domain does not print as a duplicate
  // (`assertDuplicateTemplate`: one Data Matrix of the full code inside the label, no SSCC)
  // would stop the line at the first unit.
  const printRaw = parsed.data.validationPrint;
  let validationPrint: SnapshotValidationPrint | null = null;
  if (printRaw !== undefined) {
    const template = readTemplate(printRaw.template);
    if (template === null) return { ok: false, reason: "layout" };
    try {
      assertDuplicateTemplate(template.spec);
    } catch {
      return { ok: false, reason: "layout" };
    }
    validationPrint = { verification: printRaw.verification, template };
  }
  const org = parsed.data.organization;
  const organization: SnapshotOrganization | null =
    org === undefined
      ? null
      : { name: org.name, inn: org.inn, logo: org.logo === null ? null : logoFromWire(org.logo) };
  return {
    ok: true,
    snapshot: {
      product,
      boxTemplate: box,
      issuerPrefix,
      counterpartyName,
      palletTemplate: palletsEnabled ? pallet : null,
      palletSheet,
      organization,
      validationPrint,
    },
  };
}
