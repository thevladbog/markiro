import {
  renderInventoryTaskFormHtml,
  type InventoryTaskFormData,
} from "../../../api/src/modules/inventories/inventory-task-form.js";

/**
 * Renders the REAL printable task-form template
 * (`renderInventoryTaskFormHtml`, apps/api/src/modules/inventories/
 * inventory-task-form.ts) with synthetic, demo-styled data for the
 * MKR-INS-06 `task-form.png` screenshot.
 *
 * `GET /api/inventories/:id/task-form`
 * (apps/api/src/modules/inventories/inventories.controller.ts) calls this
 * exact function server-side after loading `InventoryTaskFormData` from the
 * database; that route needs a live DB-backed API server this browser
 * harness doesn't run, but the renderer itself is a pure function of its
 * input, so it's called here directly with a hand-built (but real-shaped)
 * `InventoryTaskFormData`. Its scan symbol comes from
 * `renderLiteralDataMatrixSvg` (`@markiro/domain`, aliased to source in
 * `vite.config.ts`) -- the same real Data Matrix encoder the served route
 * uses, not a stand-in.
 *
 * `renderInventoryTaskFormHtml` returns a full `<!doctype html>` document
 * string (it's meant to be served directly as an HTTP response, not mounted
 * into a container element), so it replaces the whole document rather than
 * being injected into `#root`.
 */
const data: InventoryTaskFormData = {
  inventoryId: "50000000-0000-4000-8000-000000000001",
  inventoryNumber: "INVENTORY-26-0042",
  status: "ready",
  organizationName: "Марка Ко",
  productName: "Сироп «Клюква», 0.5 л",
  gtin14: "04600000000006",
  lineName: "Линия 1",
  mode: "check",
  productionDateFrom: "2026-08-01",
  productionDateTo: "2026-08-31",
  expectedCount: 116,
  boxCapacity: null,
  generatedAt: new Date("2026-08-28T11:00:00.000Z"),
};

/**
 * Render *before* `document.open()`. `document.open()` puts the document back
 * into the parsing state, and only `document.close()` ends it and fires
 * `load`; a throw between the two leaves the document open forever, so
 * Playwright's `page.goto` (which waits for `load`) reports an opaque 45s
 * navigation timeout instead of the actual renderer error. Rendering first
 * keeps a broken renderer a readable console error on a document that still
 * finishes loading.
 */
const html = renderInventoryTaskFormHtml(data);

document.open();
document.write(html);
document.close();
