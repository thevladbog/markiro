import { FDA_SORTABLE_REGISTRY_V1, type TraceExportSheetKey } from "./registry-v1.js";

type CellValue = string | null;
type LineRole = "item" | "input" | "output";
type SavedLocation = {
  readonly businessName: string;
  readonly phoneNumber: string;
  readonly address:
    | { readonly kind: "street"; readonly streetAddress: string }
    | { readonly kind: "coordinates"; readonly latitude: string; readonly longitude: string };
  readonly city: string;
  readonly stateOrRegion: string;
  readonly zipOrPostalCode: string;
  readonly countryCode: string;
  readonly countryDisplay: string;
};
type SavedProduct = {
  readonly productName: string;
  readonly brandName: CellValue;
  readonly commodity: CellValue;
  readonly variety: CellValue;
  readonly packagingSize: { readonly value: string; readonly uom: string } | null;
  readonly packagingStyle: CellValue;
  readonly gtin: CellValue;
};
type SavedReference = { readonly referenceKind: string; readonly referenceValue: string };
type SourceReference =
  { readonly kind: "location" } | ({ readonly kind: "reference" } & SavedReference);
type SavedDocument = {
  readonly id: string;
  readonly type?: CellValue;
  readonly number?: CellValue;
};
type LineValues = {
  readonly lotId?: CellValue;
  readonly productId?: CellValue;
  readonly tlc?: CellValue;
  readonly quantity: CellValue;
  readonly unitOfMeasure: CellValue;
  readonly reference?: CellValue;
};
type ReceivingLine = LineValues & {
  readonly lineNo: number;
  readonly source: SourceReference;
  readonly productDescription: SavedProduct;
  readonly sourceDescription: SavedLocation;
};
type TransformationLine = LineValues & {
  readonly lineNo: number;
  readonly product: { readonly id: string; readonly description: string };
  readonly source: SourceReference & { readonly description: string };
};
type ShippingLine = LineValues & {
  readonly lineNo: number;
  readonly product: { readonly id: string; readonly description: SavedProduct };
  readonly source:
    | { readonly kind: "location"; readonly location: SavedLocation }
    | ({ readonly kind: "reference"; readonly resolvedLocation: SavedLocation } & SavedReference);
};
type CapturedEvent = {
  readonly eventId: string;
  readonly revision: number;
  readonly timeZone: string;
  readonly lifecycle: "current_finalized" | "historical_finalized" | "draft" | "void";
};
type FrozenHeader = {
  readonly snapshotVersion: number;
  readonly eventDate: string;
  readonly documents: readonly SavedDocument[];
};
type DraftHeader = { readonly eventDate: CellValue; readonly documentIds: readonly string[] };

/** Structural view of strictly parsed ExportInputV1; domain never imports its consumer contracts. */
export type ExportRowsSourceRecord = CapturedEvent &
  (
    | {
        readonly type: "receiving";
        readonly payload:
          | {
              readonly kind: "frozen";
              readonly snapshot: {
                readonly snapshotVersion: 1 | 2 | 3;
                readonly dateReceived: string;
                readonly locationDescription: SavedLocation;
                readonly previousSourceDescription: SavedLocation;
                readonly items: readonly ReceivingLine[];
                readonly documents: readonly {
                  readonly document: {
                    readonly documentId: string;
                    readonly type: string;
                    readonly number: string;
                  };
                }[];
              };
            }
          | {
              readonly kind: "saved_draft";
              readonly draft: {
                readonly dateReceived: CellValue;
                readonly documentIds: readonly string[];
                readonly items: readonly (LineValues & {
                  readonly source: SourceReference | null;
                })[];
              };
            };
      }
    | {
        readonly type: "transformation";
        readonly payload:
          | {
              readonly kind: "frozen";
              readonly snapshot: FrozenHeader & {
                readonly processor: { readonly description: string };
                readonly inputs: readonly TransformationLine[];
                readonly outputs: readonly TransformationLine[];
              };
            }
          | {
              readonly kind: "saved_draft";
              readonly draft: DraftHeader & {
                readonly inputs: readonly LineValues[];
                readonly outputs: readonly LineValues[];
              };
            };
      }
    | {
        readonly type: "shipping";
        readonly payload:
          | {
              readonly kind: "frozen";
              readonly snapshot: FrozenHeader & {
                readonly shipFrom: SavedLocation;
                readonly recipient: SavedLocation;
                readonly items: readonly ShippingLine[];
              };
            }
          | {
              readonly kind: "saved_draft";
              readonly draft: DraftHeader & { readonly items: readonly LineValues[] };
            };
      }
  );
export type ExportRowsInput = { readonly events: readonly ExportRowsSourceRecord[] };
export interface CanonicalExportRow {
  readonly sheet: TraceExportSheetKey;
  readonly eventId: string;
  readonly revision: number;
  /** Empty only for an undated draft; the exported date cell remains null. */
  readonly eventDate: string;
  readonly lineRole: LineRole;
  readonly lineNo: number;
  readonly lotId: CellValue;
  readonly sourceRecord: string;
  /** First saved document ID is a tie-break only; all documents remain in the row values. */
  readonly documentId: CellValue;
  readonly values: Readonly<Record<string, CellValue>>;
}

type RowContext = Readonly<Record<string, CellValue>>;
type ProjectedLine = LineValues & { readonly lineNo: number; readonly context: RowContext };
type ProjectedEvent = CapturedEvent & {
  readonly eventDate: CellValue;
  readonly snapshotVersion: number | null;
  readonly documents: readonly SavedDocument[];
  readonly context: RowContext;
};

function productContext(product: SavedProduct): RowContext {
  return {
    "product.productName": product.productName,
    "product.brandName": product.brandName,
    "product.commodity": product.commodity,
    "product.variety": product.variety,
    "product.packagingSizeValue": product.packagingSize?.value ?? null,
    "product.packagingSizeUom": product.packagingSize?.uom ?? null,
    "product.packagingStyle": product.packagingStyle,
    "product.gtin": product.gtin,
  };
}
function locationContext(prefix: string, location: SavedLocation): RowContext {
  const { address, ...description } = location;
  // Copy only captured string fields; IDs/version keys have no registry column.
  const context: Record<string, CellValue> = {};
  for (const [key, value] of Object.entries(description))
    if (typeof value === "string") context[`${prefix}.${key}`] = value;
  context[`${prefix}.address.kind`] = address.kind;
  context[`${prefix}.address`] =
    address.kind === "street" ? address.streetAddress : `${address.latitude}, ${address.longitude}`;
  return context;
}
function sourceReferenceContext(source: SourceReference | null): RowContext {
  return source?.kind === "reference"
    ? {
        "tlcSource.referenceKind": source.referenceKind,
        "tlcSource.referenceValue": source.referenceValue,
      }
    : {};
}
function projectLine(
  event: ProjectedEvent,
  sheet: TraceExportSheetKey,
  role: LineRole,
  line: ProjectedLine,
): CanonicalExportRow {
  const sourceRecord = `${sheet}:${event.eventId}:${event.revision}:${role}:${line.lineNo}`;
  const context: RowContext = {
    ...event.context,
    ...line.context,
    "event.eventId": event.eventId,
    "event.revision": String(event.revision),
    "event.lifecycle": event.lifecycle,
    "event.timeZone": event.timeZone,
    "event.eventDate": event.eventDate,
    "event.snapshotVersion": event.snapshotVersion === null ? null : String(event.snapshotVersion),
    "line.role": role,
    "line.lineNo": String(line.lineNo),
    "line.lotId": line.lotId ?? null,
    "line.productId": line.productId ?? null,
    "line.tlc": line.tlc ?? null,
    "line.quantity": line.quantity,
    "line.unitOfMeasure": line.unitOfMeasure,
    "line.nonFtlReference": line.reference ?? null,
    "line.sourceRecord": sourceRecord,
    "documents[].id": event.documents.length
      ? JSON.stringify(event.documents.map((document) => document.id))
      : null,
    "documents[].type": event.documents.length
      ? JSON.stringify(event.documents.map((document) => document.type ?? null))
      : null,
    "documents[].number": event.documents.length
      ? JSON.stringify(event.documents.map((document) => document.number ?? null))
      : null,
  };
  const registry = FDA_SORTABLE_REGISTRY_V1.sheets.find((entry) => entry.key === sheet);
  if (!registry) throw new Error(`Missing export registry sheet: ${sheet}`);
  return {
    sheet,
    eventId: event.eventId,
    revision: event.revision,
    eventDate: event.eventDate ?? "",
    lineRole: role,
    lineNo: line.lineNo,
    lotId: line.lotId ?? null,
    sourceRecord,
    documentId: event.documents[0]?.id ?? null,
    values: Object.fromEntries(
      registry.fields.map((field) => [field.key, context[field.snapshotPath] ?? null]),
    ),
  };
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
export function compareExportRowIdentity(
  left: CanonicalExportRow,
  right: CanonicalExportRow,
): number {
  return (
    compareText(left.eventDate, right.eventDate) ||
    compareText(left.eventId, right.eventId) ||
    compareText(left.lineRole, right.lineRole) ||
    left.lineNo - right.lineNo ||
    compareText(left.documentId ?? "", right.documentId ?? "") ||
    // Multiple pinned revisions can share the five preceding keys.
    left.revision - right.revision
  );
}

/** One saved line is one quantity row. Never joins inputs to outputs or reads mutable catalogs. */
export function buildUsExportRows(input: ExportRowsInput): readonly CanonicalExportRow[] {
  const rows: CanonicalExportRow[] = [];
  for (const source of input.events) {
    if (source.type === "receiving") {
      if (source.payload.kind === "frozen") {
        const snapshot = source.payload.snapshot;
        const event: ProjectedEvent = {
          ...source,
          eventDate: snapshot.dateReceived,
          snapshotVersion: snapshot.snapshotVersion,
          documents: snapshot.documents.map(({ document }) => ({
            id: document.documentId,
            type: document.type,
            number: document.number,
          })),
          context: {
            ...locationContext("receivingLocation", snapshot.locationDescription),
            ...locationContext("previousSource", snapshot.previousSourceDescription),
          },
        };
        for (const line of snapshot.items)
          rows.push(
            projectLine(event, source.type, "item", {
              ...line,
              context: {
                ...productContext(line.productDescription),
                ...locationContext("tlcSource.location", line.sourceDescription),
                ...sourceReferenceContext(line.source),
              },
            }),
          );
      } else {
        const draft = source.payload.draft;
        const event: ProjectedEvent = {
          ...source,
          eventDate: draft.dateReceived,
          snapshotVersion: null,
          documents: draft.documentIds.map((id) => ({ id })),
          context: {},
        };
        draft.items.forEach((line, index) =>
          rows.push(
            projectLine(event, source.type, "item", {
              ...line,
              lineNo: index + 1,
              context: sourceReferenceContext(line.source),
            }),
          ),
        );
      }
    } else if (source.type === "transformation") {
      if (source.payload.kind === "frozen") {
        const snapshot = source.payload.snapshot;
        const event: ProjectedEvent = {
          ...source,
          eventDate: snapshot.eventDate,
          snapshotVersion: snapshot.snapshotVersion,
          documents: snapshot.documents,
          context: { "original.transformationLocationDescription": snapshot.processor.description },
        };
        for (const [role, lines] of [
          ["input", snapshot.inputs],
          ["output", snapshot.outputs],
        ] as const)
          for (const line of lines)
            rows.push(
              projectLine(event, source.type, role, {
                ...line,
                productId: line.product.id,
                context: {
                  "original.productDescription": line.product.description,
                  "original.tlcSourceDescription":
                    role === "output" ? snapshot.processor.description : line.source.description,
                  ...sourceReferenceContext(line.source),
                },
              }),
            );
      } else {
        const draft = source.payload.draft;
        const event: ProjectedEvent = {
          ...source,
          eventDate: draft.eventDate,
          snapshotVersion: null,
          documents: draft.documentIds.map((id) => ({ id })),
          context: {},
        };
        for (const [role, lines] of [
          ["input", draft.inputs],
          ["output", draft.outputs],
        ] as const)
          lines.forEach((line, index) =>
            rows.push(
              projectLine(event, source.type, role, { ...line, lineNo: index + 1, context: {} }),
            ),
          );
      }
    } else if (source.payload.kind === "frozen") {
      const snapshot = source.payload.snapshot;
      const event: ProjectedEvent = {
        ...source,
        eventDate: snapshot.eventDate,
        snapshotVersion: snapshot.snapshotVersion,
        documents: snapshot.documents,
        context: {
          ...locationContext("shipFrom", snapshot.shipFrom),
          ...locationContext("recipient", snapshot.recipient),
        },
      };
      for (const line of snapshot.items)
        rows.push(
          projectLine(event, source.type, "item", {
            ...line,
            productId: line.product.id,
            context: {
              ...productContext(line.product.description),
              ...locationContext(
                "tlcSource.location",
                line.source.kind === "location"
                  ? line.source.location
                  : line.source.resolvedLocation,
              ),
              ...sourceReferenceContext(line.source),
            },
          }),
        );
    } else {
      const draft = source.payload.draft;
      const event: ProjectedEvent = {
        ...source,
        eventDate: draft.eventDate,
        snapshotVersion: null,
        documents: draft.documentIds.map((id) => ({ id })),
        context: {},
      };
      draft.items.forEach((line, index) =>
        rows.push(
          projectLine(event, source.type, "item", { ...line, lineNo: index + 1, context: {} }),
        ),
      );
    }
  }
  return rows.sort(compareExportRowIdentity);
}
