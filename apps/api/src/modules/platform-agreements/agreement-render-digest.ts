import { createHash } from "node:crypto";

import type { AgreementDocumentForm } from "@markiro/platform-contracts";

/**
 * Everything the renderer reads. Kept as an explicit shape rather than the
 * whole row so that adding an unrelated column — a tenant link, a termination
 * reason — does not mark every stored draft out of date.
 */
export interface AgreementRenderInputs {
  readonly number: string;
  readonly conclusionDate: string | null;
  readonly city: string | null;
  readonly documentForm: AgreementDocumentForm;
  readonly counterparty: unknown;
  readonly contractor: unknown;
  readonly terms: unknown;
}

/**
 * Fingerprint of the values a stored document was rendered from.
 *
 * A draft is an explicitly rendered snapshot: editing the agreement leaves the
 * stored file untouched, so without this the record can claim one thing while
 * the downloadable file says another. Comparing the stored fingerprint with
 * the current one answers "does this file still match the record" for every
 * field at once, instead of a rule that covers whichever field was added last.
 */
export function agreementRenderDigest(inputs: AgreementRenderInputs): string {
  return createHash("sha256")
    .update(stableStringify(canonical(inputs)))
    .digest("hex");
}

function canonical(inputs: AgreementRenderInputs): Record<string, unknown> {
  return {
    number: inputs.number,
    conclusionDate: inputs.conclusionDate,
    city: inputs.city,
    documentForm: inputs.documentForm,
    counterparty: inputs.counterparty,
    contractor: inputs.contractor,
    // `terms` carries both the commercial terms and the signatory.
    terms: inputs.terms,
  };
}

/**
 * JSON with object keys in a fixed order. The requisites and terms arrive from
 * a jsonb column, whose key order is not guaranteed to survive a round trip,
 * and an order-sensitive hash would report a document as stale after a write
 * that changed nothing.
 */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`);
  return `{${entries.join(",")}}`;
}
