import { isValidGtin, labelTemplateSpecSchema, type LabelTemplateSpec } from "@markiro/domain";

import { shiftSnapshotSchema, type ShiftSnapshot } from "../../host/protocol.js";

/**
 * A snapshot this build can work a shift from: the host's frozen product,
 * issuer prefix and counterparty, and the box layout read by the domain's
 * `labelTemplateSpecSchema`, the model the label is printed from (stage 2a
 * spec, decisions 3 and 22).
 */
export interface CheckedSnapshot {
  product: ShiftSnapshot["product"];
  boxTemplate: { id: string; name: string; rev: number; spec: LabelTemplateSpec };
  issuerPrefix: string;
  counterpartyName: string | null;
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

/**
 * Checks a shift's snapshot before the station works the shift: once when it
 * enters (the host never checks a layout, stage 2a spec §4.2) and again when
 * a stored one is read back. A snapshot that fails keeps the operator out of
 * the shift; nothing is printed from a layout the domain does not read.
 */
export function checkShiftSnapshot(raw: unknown): SnapshotCheck {
  const parsed = shiftSnapshotSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, reason: "shape" };
  const { product, boxTemplate, issuerPrefix, counterpartyName } = parsed.data;
  if (!GTIN14.test(product.gtin14) || !isValidGtin(product.gtin14)) {
    return { ok: false, reason: "gtin" };
  }
  if (!ISSUER_PREFIX.test(issuerPrefix)) return { ok: false, reason: "prefix" };
  const spec = labelTemplateSpecSchema.safeParse(boxTemplate.spec);
  if (!spec.success) return { ok: false, reason: "layout" };
  return {
    ok: true,
    snapshot: {
      product,
      boxTemplate: {
        id: boxTemplate.id,
        name: boxTemplate.name,
        rev: boxTemplate.rev,
        spec: spec.data,
      },
      issuerPrefix,
      counterpartyName,
    },
  };
}
