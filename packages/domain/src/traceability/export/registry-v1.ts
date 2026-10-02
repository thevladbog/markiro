import { canonicalExportDigest } from "./canonical.js";

export type TraceExportSheetKey = "receiving" | "transformation" | "shipping";
export type TraceExportRequired = "yes" | "if_applicable" | "no";
export type TraceExportFieldType = "text" | "integer" | "decimal" | "date";
export interface TraceExportField {
  readonly key: string;
  readonly header: string;
  readonly sheet: TraceExportSheetKey;
  readonly kdeGroup: string;
  readonly sourceSection: string;
  readonly sourceUrl: string;
  readonly required: TraceExportRequired;
  readonly type: TraceExportFieldType;
  /** Path in the frozen, version-adapted row context; never a live catalog lookup. */
  readonly snapshotPath: string;
  readonly version: 1;
}
export interface TraceExportSheet {
  readonly key: TraceExportSheetKey;
  readonly name: string;
  readonly fields: readonly TraceExportField[];
}

function fieldFactory(sheet: TraceExportSheetKey, name: string, section: string) {
  return (
    key: string,
    header: string,
    snapshotPath: string,
    kdeGroup: string,
    cell: string,
    required: TraceExportRequired = "yes",
    type: TraceExportFieldType = "text",
  ): TraceExportField =>
    Object.freeze({
      key,
      header,
      sheet,
      kdeGroup,
      required,
      type,
      snapshotPath,
      version: 1,
      sourceSection: `21 CFR ${section}; ${cell === "extension" ? "Markiro extension (no FDA template column)" : `FDA ${name}!${cell}`}`,
      sourceUrl: `https://www.ecfr.gov/current/title-21/part-1/section-${section}`,
    });
}
type FieldFactory = ReturnType<typeof fieldFactory>;

function productFields(field: FieldFactory, cells: readonly string[]): TraceExportField[] {
  const cell = (index: number): string => cells[index] ?? "extension";
  return [
    field("product_name", "Product name", "product.productName", "Product description", cell(0)),
    field(
      "product_brand_name",
      "Product brand name",
      "product.brandName",
      "Product description",
      cell(1),
      "if_applicable",
    ),
    field(
      "product_commodity",
      "Product commodity",
      "product.commodity",
      "Product description",
      cell(2),
      "if_applicable",
    ),
    field(
      "product_variety",
      "Product variety",
      "product.variety",
      "Product description",
      cell(3),
      "if_applicable",
    ),
    field(
      "product_packaging_size_value",
      "Product packaging size",
      "product.packagingSizeValue",
      "Product description",
      cell(4),
      "yes",
      "decimal",
    ),
    field(
      "product_packaging_size_uom",
      "Product packaging size UOM",
      "product.packagingSizeUom",
      "Product description",
      cell(4),
    ),
    field(
      "product_packaging_style",
      "Product packaging style",
      "product.packagingStyle",
      "Product description",
      cell(5),
    ),
    field("product_gtin", "Product GTIN", "product.gtin", "Product identifier", "extension", "no"),
  ];
}

function locationFields(
  field: FieldFactory,
  prefix: string,
  path: string,
  label: string,
  cells: readonly string[],
  required: TraceExportRequired = "yes",
): TraceExportField[] {
  const column = (key: string, header: string, suffix: string, index: number): TraceExportField =>
    field(
      `${prefix}_${key}`,
      `${label}: ${header}`,
      `${path}.${suffix}`,
      label,
      cells[index] ?? "extension",
      required,
    );
  return [
    column("business_name", "Business name", "businessName", 0),
    column("phone_number", "Phone number", "phoneNumber", 1),
    field(
      `${prefix}_address_kind`,
      `${label}: Address type`,
      `${path}.address.kind`,
      label,
      "extension",
      required,
    ),
    column("street_address_or_coordinates", "Street address or coordinates", "address", 2),
    column("city", "City", "city", 3),
    column("state_or_region", "State or region", "stateOrRegion", 4),
    column("zip_or_postal_code", "ZIP or postal code", "zipOrPostalCode", 5),
    column("country_code", "Country code", "countryCode", 6),
    column("country_display", "Country", "countryDisplay", 6),
    field(`${prefix}_gln`, `${label}: GLN`, `${path}.gln`, label, "extension", "no"),
    field(`${prefix}_ffrn`, `${label}: FFRN`, `${path}.ffrn`, label, "extension", "no"),
    field(
      `${prefix}_source_reference_url`,
      `${label}: Source reference URL`,
      `${path}.sourceReferenceUrl`,
      label,
      "extension",
      "no",
    ),
  ];
}

function sourceFields(
  field: FieldFactory,
  cells: readonly string[],
  referenceCell: string,
): TraceExportField[] {
  return [
    ...locationFields(
      field,
      "tlc_source",
      "tlcSource.location",
      "TLC source",
      cells,
      "if_applicable",
    ),
    field(
      "tlc_source_reference_kind",
      "TLC source reference type",
      "tlcSource.referenceKind",
      "TLC source",
      "extension",
      "if_applicable",
    ),
    field(
      "tlc_source_reference_value",
      "TLC source reference",
      "tlcSource.referenceValue",
      "TLC source",
      referenceCell,
      "if_applicable",
    ),
  ];
}

function provenanceFields(field: FieldFactory, transformation = false): TraceExportField[] {
  return [
    field("event_id", "Event ID (non-additive)", "event.eventId", "Provenance", "extension"),
    field(
      "event_revision",
      "Event revision (non-additive)",
      "event.revision",
      "Provenance",
      "extension",
      "yes",
      "integer",
    ),
    field(
      "event_lifecycle",
      "Event lifecycle (non-additive)",
      "event.lifecycle",
      "Provenance",
      "extension",
    ),
    field(
      "event_timezone",
      "Event timezone (non-additive)",
      "event.timeZone",
      "Provenance",
      "extension",
    ),
    field(
      "snapshot_version",
      "Snapshot version (non-additive)",
      "event.snapshotVersion",
      "Provenance",
      "extension",
      "if_applicable",
      "integer",
    ),
    field("line_role", "Line role", "line.role", "Genealogy and provenance", "extension"),
    field(
      "line_no",
      "Line number",
      "line.lineNo",
      "Genealogy and provenance",
      "extension",
      "yes",
      "integer",
    ),
    field(
      "lot_id",
      "Lot ID",
      "line.lotId",
      "Genealogy and provenance",
      "extension",
      transformation ? "if_applicable" : "yes",
    ),
    field("product_id", "Product ID", "line.productId", "Provenance", "extension"),
    field("source_record", "Source record", "line.sourceRecord", "Provenance", "extension"),
  ];
}

function documentFields(
  field: FieldFactory,
  typeCell: string,
  numberCell: string,
): TraceExportField[] {
  return [
    field(
      "reference_document_ids",
      "Reference document IDs (non-additive)",
      "documents[].id",
      "References",
      "extension",
    ),
    field(
      "reference_document_types",
      "Reference document types (non-additive)",
      "documents[].type",
      "References",
      typeCell,
    ),
    field(
      "reference_document_numbers",
      "Reference document numbers (non-additive)",
      "documents[].number",
      "References",
      numberCell,
    ),
  ];
}

function sheet(
  key: TraceExportSheetKey,
  name: string,
  fields: TraceExportField[],
): TraceExportSheet {
  for (const property of ["key", "snapshotPath"] as const) {
    if (new Set(fields.map((field) => field[property])).size !== fields.length)
      throw new Error(`Duplicate export registry ${property} in ${key}`);
  }
  return Object.freeze({ key, name, fields: Object.freeze(fields) });
}

const receiving = fieldFactory("receiving", "Receiving", "1.1345");
const shipping = fieldFactory("shipping", "Shipping", "1.1340");
const transformation = fieldFactory("transformation", "Transformation", "1.1350");
const productCells = ["D1", "E1", "F1", "G1", "H1", "I1"];
const partnerCells = ["J1", "K1", "L1", "M1", "N1", "O1", "P1"];
const siteCells = ["Q1", "R1", "S1", "T1", "U1", "V1", "W1"];
const sourceCells = ["Y1", "Z1", "AA1", "AB1", "AC1", "AD1", "AE1"];

const receivingSheet = sheet("receiving", "Receiving", [
  receiving("tlc", "Traceability lot code", "line.tlc", "Lot", "A1"),
  receiving("quantity", "Quantity", "line.quantity", "Quantity", "B1", "yes", "decimal"),
  receiving("unit_of_measure", "Unit of measure", "line.unitOfMeasure", "Quantity", "C1"),
  ...productFields(receiving, productCells),
  ...locationFields(
    receiving,
    "previous_source",
    "previousSource",
    "Immediate previous source (excluding transporter)",
    partnerCells,
  ),
  ...locationFields(
    receiving,
    "receiving_location",
    "receivingLocation",
    "Receiving location",
    siteCells,
  ),
  receiving("date_received", "Date received", "event.eventDate", "Date", "X1", "yes", "date"),
  ...sourceFields(receiving, sourceCells, "AF1"),
  ...documentFields(receiving, "AG1, AI1", "AH1, AJ1"),
  ...provenanceFields(receiving),
]);

const transformationSheet = sheet("transformation", "Transformation", [
  transformation(
    "tlc",
    "Traceability lot code",
    "line.tlc",
    "Lot",
    "A1 (input), J1 (output)",
    "if_applicable",
  ),
  transformation(
    "quantity",
    "Quantity",
    "line.quantity",
    "Quantity",
    "H1 (input), Z1 (output)",
    "yes",
    "decimal",
  ),
  transformation(
    "unit_of_measure",
    "Unit of measure",
    "line.unitOfMeasure",
    "Quantity",
    "I1 (input), AA1 (output)",
  ),
  ...productFields(transformation, [
    "B1 (input), T1 (output)",
    "C1 (input), U1 (output)",
    "D1 (input), V1 (output)",
    "E1 (input), W1 (output)",
    "F1 (input), X1 (output)",
    "G1 (input), Y1 (output)",
  ]),
  ...locationFields(
    transformation,
    "transformation_location",
    "transformationLocation",
    "Transformation location (non-additive)",
    ["K1", "L1", "M1", "N1", "O1", "P1", "Q1"],
  ),
  ...sourceFields(transformation, [], "R1 (output)"),
  transformation(
    "transformation_completed_date",
    "Transformation completion date",
    "event.eventDate",
    "Date",
    "S1",
    "yes",
    "date",
  ),
  ...documentFields(transformation, "AB1, AD1", "AC1, AE1"),
  transformation(
    "product_description_original",
    "Original saved product description",
    "original.productDescription",
    "Original source text",
    "extension",
    "no",
  ),
  transformation(
    "transformation_location_description_original",
    "Original saved transformation location description (non-additive)",
    "original.transformationLocationDescription",
    "Original source text",
    "extension",
    "no",
  ),
  transformation(
    "tlc_source_description_original",
    "Original saved TLC source description",
    "original.tlcSourceDescription",
    "Original source text",
    "extension",
    "no",
  ),
  transformation(
    "non_ftl_reference",
    "Non-FTL input reference",
    "line.nonFtlReference",
    "Genealogy and provenance",
    "extension",
    "if_applicable",
  ),
  ...provenanceFields(transformation, true),
]);

const shippingSheet = sheet("shipping", "Shipping", [
  shipping("tlc", "Traceability lot code", "line.tlc", "Lot", "A1"),
  shipping("quantity", "Quantity", "line.quantity", "Quantity", "B1", "yes", "decimal"),
  shipping("unit_of_measure", "Unit of measure", "line.unitOfMeasure", "Quantity", "C1"),
  ...productFields(shipping, productCells),
  ...locationFields(
    shipping,
    "recipient",
    "recipient",
    "Immediate subsequent recipient (excluding transporter)",
    partnerCells,
  ),
  ...locationFields(shipping, "ship_from", "shipFrom", "Ship-from location", siteCells),
  shipping("date_shipped", "Date shipped", "event.eventDate", "Date", "X1", "yes", "date"),
  ...sourceFields(shipping, sourceCells, "AF1"),
  ...documentFields(shipping, "AG1, AI1", "AH1, AJ1"),
  ...provenanceFields(shipping),
]);

/** Immutable English adapter mapping. Any mapping change requires a new version. */
export const FDA_SORTABLE_REGISTRY_V1 = Object.freeze({
  id: "fda_sortable_xlsx",
  version: 1,
  sheets: Object.freeze([receivingSheet, transformationSheet, shippingSheet]),
});

export function traceExportRegistryHash(): string {
  return canonicalExportDigest(FDA_SORTABLE_REGISTRY_V1);
}

export function renderUsExportDictionary(): string {
  const lines = [
    "# US export data dictionary",
    "",
    "Generated by `renderUsExportDictionary()` from `FDA_SORTABLE_REGISTRY_V1`. Do not edit the column tables by hand.",
    "",
    `Adapter: ${FDA_SORTABLE_REGISTRY_V1.id}; version: ${FDA_SORTABLE_REGISTRY_V1.version}; language: English.`,
    "",
    `Registry SHA-256: \`${traceExportRegistryHash()}\`.`,
    "",
    "## Mapping and source boundary",
    "",
    "The [FDA illustrative template](https://www.fda.gov/media/179617/download?attachment=) is a mapping reference, not a required file layout or an approval of this adapter. Sections and cells below identify the reviewed FDA column groups. Markiro extensions have no FDA template column and are not additional regulatory KDE requirements.",
    "",
    "Receiving and Shipping use one row per saved item. Transformation uses separate input and output rows, joined by event ID and revision. Its common product, TLC and quantity columns map to the FDA input or output group according to line role. No input-output Cartesian product or quantity allocation is implied. Non-FTL inputs retain their own role, quantity and reference; TLC and lot ID are not applicable to them.",
    "",
    "Requiredness describes the applicable KDE: yes, if_applicable, or no. Brand, commodity and variety are conditional. TLC source requires a location description or a valid source reference; blank conditional source cells do not waive this alternative. The transformation location remains required. Optional GLN, FFRN and URL columns never replace a required description by themselves.",
    "",
    "Paths refer to the version-adapted frozen row context, not identical paths in every saved snapshot. Version adapters must use only captured values. Transformation v1 has opaque product/location descriptions: preserve that exact text only in Original saved description columns, leave unavailable split KDEs blank and emit source-linked missing-field findings. Never infer a product name, address or other split KDE from that text or current master data. Incomplete drafts likewise retain gaps.",
    "",
    "FDA packaging size is split into exact value and UOM. Country is split into code and display text. The address union is rendered as the saved street address or latitude/longitude pair, with its address type retained. GTIN, TLC, phone, document numbers, postal codes and source references remain text. Dates are civil dates; quantities and packaging values retain exact decimal strings until the writer's precision checks.",
    "",
    "Document ID/type/number columns represent ordered parallel lists from documents[], with matching positions and no two-document limit. Event/document columns and transformation location are non-additive. A renderer must preserve list alignment and all saved document values without multiplying quantity rows. Additional source IDs and line roles provide provenance; original descriptions are evidence, not substitutes for split KDEs.",
    "",
    "Registry hashing sorts JSON object keys and preserves column order. Export-input hashing also sorts the top-level events and findings selections; arrays inside saved snapshots retain their original order. No Unicode, decimal or identifier normalization occurs. Mapping/hash changes require a reviewed new adapter version, not blind golden regeneration.",
    "",
  ];
  for (const entry of FDA_SORTABLE_REGISTRY_V1.sheets) {
    const header = [
      "Key",
      "English header",
      "Required",
      "Type",
      "Frozen row path",
      "KDE group",
      "Source section and template cell",
      "Source URL",
      "Adapter version",
    ];
    const rows = entry.fields.map((field) => [
      field.key,
      field.header,
      field.required,
      field.type,
      field.snapshotPath,
      field.kdeGroup,
      field.sourceSection,
      field.sourceUrl,
      String(field.version),
    ]);
    const widths = header.map((title, index) =>
      Math.max(title.length, 3, ...rows.map((row) => row[index]?.length ?? 0)),
    );
    const tableRow = (cells: readonly string[]): string =>
      `| ${cells.map((cell, index) => cell.padEnd(widths[index] ?? 3)).join(" | ")} |`;
    lines.push(
      `## ${entry.name}`,
      "",
      tableRow(header),
      tableRow(widths.map((width) => "-".repeat(width))),
      ...rows.map(tableRow),
    );
    lines.push("");
  }
  return lines.join("\n");
}
