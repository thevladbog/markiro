import type { TFunction } from "i18next";

import type { CloudExportFile, ExportNote } from "../../host/cloud-import.js";

/** Codes `office.cloudImport.notes` has a text for (the tool's `transform.mjs`). */
export const KNOWN_NOTE_CODES: ReadonlySet<string> = new Set([
  "active_shift",
  "device_out_of_sync",
  "text_changed",
  "inn_dropped",
  "gs1_prefix_dropped",
  "time_zone_replaced",
  "line_renamed",
  "line_dropped",
  "counterparty_dropped",
  "counterparty_notes_lost",
  "template_dropped",
  "template_default_dropped",
  "product_dropped",
  "product_value_cleared",
  "product_template_dropped",
  "product_fields_lost",
  "operator_dropped",
  "badge_dropped",
  "badges_rehashed",
  "badge_salt_created",
  "badges_not_operators",
  "counterparty_sscc_used",
  "planned_shifts_not_moved",
  "sscc_window_does_not_fit",
  "pallet_sheet_defaults_lost",
]);

/**
 * The words a note's parameters have (`office.cloudImport.entities`, `.fields`,
 * `.reasons`, `.purposes`). A value outside them is shown as it stands:
 * the tool may grow a code or a reason before the office learns its words,
 * and a note must never read as a missing text.
 */
export const NOTE_ENTITIES: ReadonlySet<string> = new Set([
  "organization",
  "counterparties",
  "templates",
  "products",
  "operators",
]);
export const NOTE_FIELDS: ReadonlySet<string> = new Set([
  "name",
  "printName",
  "role",
  "boxCapacity",
  "palletBoxCapacity",
  "shelfLifeDays",
  "price",
  "egaisCode",
  "externalRef",
  "photo",
  "defaultCounterparty",
]);
export const NOTE_REASONS: ReadonlySet<string> = new Set([
  "gln",
  "name",
  "gtin",
  "spec_not_object",
  "spec_too_deep",
  "spec_too_large",
  "login",
  "pin",
  "operator",
  "code",
  "duplicate",
  "pallet_sheet",
  "format",
]);
export const NOTE_PURPOSES: ReadonlySet<string> = new Set(["box", "pallet"]);

function text(value: unknown): string {
  return typeof value === "string" || typeof value === "number" ? String(value) : "";
}

/** `value` in the words of `group` when it has some, as it stands when not. */
function worded(t: TFunction, group: string, known: ReadonlySet<string>, value: string): string {
  return known.has(value) ? t(`office.cloudImport.${group}.${value}`) : value;
}

/**
 * A record a note names: by its name in the file, or by the first eight
 * characters of its id when the tool left it out.
 */
function recordName(file: CloudExportFile, entity: string, id: unknown): string {
  const key = text(id);
  const { payload } = file;
  const named =
    entity === "products"
      ? payload.products.find((each) => each.id === key)?.name
      : entity === "counterparties"
        ? payload.counterparties.find((each) => each.id === key)?.name
        : entity === "templates"
          ? payload.templates.find((each) => each.id === key)?.name
          : entity === "operators"
            ? payload.operators.find((each) => each.id === key)?.name
            : undefined;
  if (named !== undefined) return `«${named}»`;
  return key === "" ? "" : `#${key.slice(0, 8)}`;
}

/** The entity a note's code is about, for codes that name a record without `entity`. */
const ENTITY_OF: Readonly<Record<string, string>> = {
  counterparty_dropped: "counterparties",
  template_dropped: "templates",
  product_dropped: "products",
  product_value_cleared: "products",
  product_template_dropped: "products",
  operator_dropped: "operators",
};

/** What a note says, in words. A code the office has no words for is shown as it stands. */
export function noteText(t: TFunction, note: ExportNote, file: CloudExportFile): string {
  if (!KNOWN_NOTE_CODES.has(note.code)) {
    return t("office.cloudImport.notes.unknown", { code: note.code });
  }
  const entity = text(note.entity) || ENTITY_OF[note.code] || "";
  const reason = text(note.reason);
  const field = text(note.field);
  const extension = note.extension === 1 ? "pallet" : "box";
  return t(`office.cloudImport.notes.${note.code}`, {
    number: text(note.number),
    name: text(note.name),
    entity: worded(t, "entities", NOTE_ENTITIES, entity),
    record: recordName(file, entity, note.id),
    field: worded(t, "fields", NOTE_FIELDS, field),
    value: text(note.value),
    from: text(note.from),
    to: text(note.to),
    count: text(note.count),
    reason: worded(t, "reasons", NOTE_REASONS, reason),
    slot: worded(t, "purposes", NOTE_PURPOSES, text(note.purpose) || "box"),
    issuerPrefix: text(note.issuerPrefix),
    kind: t(`office.cloudImport.kinds.${extension}`),
  });
}
