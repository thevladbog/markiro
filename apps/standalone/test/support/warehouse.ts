import {
  buildDefaultLabelTemplates,
  buildDuplicateLabelTemplate,
  buildPalletLabelTemplates,
} from "@markiro/domain";
import type { DatabaseSync } from "node:sqlite";

import { latin1ToBytes } from "../../src/floor/print/label-render.js";
import type { RenderWarehouseLabel } from "../../src/floor/warehouse/warehouse-work.js";
import type { WarehouseSource } from "../../src/host/protocol.js";
import { ENTITY_SET } from "../../src/local/reference-sync.js";
import { DEVICE_ID, HOST_ID } from "./fixtures.js";
import { OPERATOR_ID } from "./floor-work.js";

/** The three templates of the copies: a duplicate, a box and a pallet, all for every category. */
export const UNIT_TEMPLATE = "d1d1d1d1-0000-4000-8000-000000000001";
export const BOX_TEMPLATE = "d1d1d1d1-0000-4000-8000-000000000002";
export const PALLET_TEMPLATE = "d1d1d1d1-0000-4000-8000-000000000003";

/** A unit's full code with its separator and crypto tail, and its `kmHash`. */
export const KM = "010460068200001321S000001\u001d93Tail";
export const CODE_HASH = "7a6ad5f358a3f6d800e0550c5bc16079d73004e9766bfc13c572778c62a6657d";
/** The SSCC of box serial 1500 and of pallet serial 40 under 460068200, with their check digits. */
export const BOX_SSCC = "046006820000015000";
export const PALLET_SSCC = "146006820000000409";

const PRODUCT = {
  id: "8b1c2d3e-4f5a-4b6c-9d7e-8f9a0b1c2d3e",
  gtin14: "04600682000013",
  name: "Молоко 3,2% 0,9 л",
  printName: "Молоко 3,2%",
  chzProductGroupCode: 8,
  shelfLifeDays: 10,
};

export const UNIT_SOURCE: WarehouseSource = {
  kind: "unit",
  subjectId: "5c6d7e8f-9a0b-4c1d-8e2f-3a4b5c6d7e8f",
  identity: CODE_HASH,
  canonical: KM,
  product: PRODUCT,
  counterpartyName: null,
  shiftId: "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d",
  shiftNumber: "OCT26-003",
  productionDate: "2026-10-08",
  at: "2026-10-08T05:58:41.090Z",
  itemCount: 1,
  operatorName: "Анна Кузнецова",
  deviceId: "2b3c4d5e-6f7a-4b8c-9d0e-1f2a3b4c5d6e",
};

export const BOX_SOURCE: WarehouseSource = {
  kind: "box",
  subjectId: "b0000000-0000-4000-8000-000000000001",
  identity: BOX_SSCC,
  sscc: BOX_SSCC,
  product: PRODUCT,
  counterpartyName: "ООО «Север»",
  shiftId: "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d",
  shiftNumber: "OCT26-003",
  productionDate: "2026-10-08",
  at: "2026-10-08T06:10:00.000Z",
  itemCount: 12,
  operatorName: "Анна Кузнецова",
  deviceId: "2b3c4d5e-6f7a-4b8c-9d0e-1f2a3b4c5d6e",
};

export const PALLET_SOURCE: WarehouseSource = {
  kind: "pallet",
  subjectId: "a0000000-0000-4000-8000-000000000001",
  identity: PALLET_SSCC,
  sscc: PALLET_SSCC,
  product: PRODUCT,
  counterpartyName: null,
  shiftId: "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d",
  shiftNumber: "OCT26-003",
  productionDate: "2026-10-08",
  at: "2026-10-08T06:20:00.000Z",
  itemCount: 480,
  boxCount: 40,
  operatorName: null,
  deviceId: "2b3c4d5e-6f7a-4b8c-9d0e-1f2a3b4c5d6e",
};

/**
 * This pairing's copies, ready: Anna (unless `operator: false`), the organization with
 * the three templates as its defaults, and the templates themselves (stock layouts).
 */
export function seedWarehouseCopies(db: DatabaseSync, options: { operator?: boolean } = {}): void {
  db.prepare(
    "INSERT INTO sync_state (key, value) " +
      "VALUES ('last_rev', '10'), ('host_id', ?), ('device_id', ?), ('entity_set', ?)",
  ).run(HOST_ID, DEVICE_ID, ENTITY_SET);
  if (options.operator !== false) {
    db.prepare(
      "INSERT INTO ref_operators (id, login, name, role, pin_phc, rev) " +
        "VALUES (?, '0042', 'Анна Кузнецова', NULL, 'x', 1)",
    ).run(OPERATOR_ID);
  }
  db.prepare(
    "INSERT INTO ref_org (id, name, inn, gln, gs1_prefixes, time_zone, rev, " +
      "default_box_template_id, default_pallet_template_id, default_duplicate_template_id) " +
      "VALUES ('org', 'Завод', NULL, '4600682000006', '[]', 'Europe/Moscow', 1, ?, ?, ?)",
  ).run(BOX_TEMPLATE, PALLET_TEMPLATE, UNIT_TEMPLATE);
  const [box] = buildDefaultLabelTemplates();
  const [pallet] = buildPalletLabelTemplates();
  if (box === undefined || pallet === undefined) throw new Error("stock templates missing");
  const insert = db.prepare(
    "INSERT INTO ref_templates (id, name, purpose, enabled, category_codes, stock, spec, rev) " +
      "VALUES (?, ?, ?, 1, NULL, 1, ?, 4)",
  );
  insert.run(
    UNIT_TEMPLATE,
    "Дубль 58×40",
    "product_duplicate",
    JSON.stringify(buildDuplicateLabelTemplate()),
  );
  insert.run(BOX_TEMPLATE, "Коробка 58×40", "box", JSON.stringify(box.spec));
  insert.run(PALLET_TEMPLATE, "Палета 100×150", "pallet", JSON.stringify(pallet.spec));
}

/**
 * A render that writes what it was asked in plain ASCII: the language, the resolution,
 * the layout's size, the SSCC (or `km` for a unit) and how the code is drawn.
 */
export const warehouseRender: RenderWarehouseLabel = async (spec, fields, printer, options) =>
  latin1ToBytes(
    `^XA ${printer.language} ${printer.dpi} ${spec.widthMm}x${spec.heightMm} ` +
      `${fields.sscc === "" ? "km" : fields.sscc} ${options.kmDataMatrix ?? "native"} ^XZ`,
  );
