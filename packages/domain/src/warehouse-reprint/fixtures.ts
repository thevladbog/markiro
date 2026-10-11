import { buildDefaultLabelTemplates } from "../labels/defaults.js";
import { sampleLabelData } from "../labels/model.js";
import { productLabelBytesDigest, productLabelValueDigest } from "../product-labels/km.js";
import {
  warehouseSourceSchema,
  warehouseTemplateSchema,
  type WarehouseReprintSource,
  type WarehouseTemplate,
  type WarehouseReprintEvent,
} from "./contracts.js";

export function warehouseBoxSource(): WarehouseReprintSource {
  const sscc = "346006820000000014";
  const value = {
    kind: "box" as const,
    sourceId: "00000000-0000-4000-8000-000000000010",
    identity: sscc,
    productName: "Сироп «Клюква», 0,5 л",
    chzProductGroupCode: null,
    fields: {
      ...sampleLabelData(),
      sscc,
      "km.code": "",
      date: "08.10.2026",
      expiry: "07.10.2027",
      qty: "20",
    },
    unavailableFields: [],
    payloadDigest: productLabelBytesDigest(new TextEncoder().encode(sscc)),
    sourceShiftId: "00000000-0000-4000-8000-000000000011",
  };
  return warehouseSourceSchema.parse({ ...value, revision: productLabelValueDigest(value) });
}
export function warehouseBoxTemplate(): WarehouseTemplate {
  const stock = buildDefaultLabelTemplates()[0];
  if (!stock) throw new Error("Stock box template missing");
  const value = {
    id: "00000000-0000-4000-8000-000000000012",
    revision: productLabelValueDigest(stock),
    name: stock.name,
    purpose: "box" as const,
    enabled: true,
    chzProductGroupCodes: null,
    spec: stock.spec,
  };
  return warehouseTemplateSchema.parse({ ...value, digest: productLabelValueDigest(value) });
}
export function warehousePreparedEvent(): Extract<WarehouseReprintEvent, { kind: "prepared" }> {
  const source = warehouseBoxSource();
  const template = warehouseBoxTemplate();
  return {
    kind: "prepared",
    eventId: "00000000-0000-4000-8000-000000000013",
    jobId: "00000000-0000-4000-8000-000000000014",
    sessionId: "00000000-0000-4000-8000-000000000015",
    attemptId: "00000000-0000-4000-8000-000000000016",
    operatorId: "00000000-0000-4000-8000-000000000001",
    sequence: 1,
    occurredAt: "2026-10-09T12:00:00.000Z",
    attemptNo: 1,
    reason: "damaged",
    sourceKind: source.kind,
    sourceId: source.sourceId,
    identity: source.identity,
    sourceRevision: source.revision,
    sourceShiftId: source.sourceShiftId,
    templateId: template.id,
    templateRevision: template.revision,
    templateDigest: template.digest,
    payloadDigest: source.payloadDigest,
    bytesDigest: productLabelBytesDigest(new TextEncoder().encode("print")),
    scanDigest: productLabelBytesDigest(new TextEncoder().encode(`!100${source.identity}`)),
    repair: "legacy_tspl_fnc1_literal",
    language: "tspl",
    dpi: 203,
  };
}
