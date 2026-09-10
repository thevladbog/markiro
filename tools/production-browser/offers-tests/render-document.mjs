import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { deepStrictEqual } from "node:assert";

const require = createRequire(import.meta.url);
const {
  renderPrintHtml,
} = require("../../../apps/api/dist/modules/billing/print-document-html.js");
const { model, options } = JSON.parse(readFileSync(0, "utf8"));
const {
  calculateOfferBreakdown,
} = require("../../../apps/api/dist/modules/platform-offers/offer-preview-model.js");
const breakdown = calculateOfferBreakdown(
  model.lines.map((line) => ({
    quantity: line.quantity,
    agreedUnitPrice: line.unitPrice,
    vatRate: line.vatRate,
    vatIncluded: line.vatIncluded,
  })),
  model.total,
);
deepStrictEqual(breakdown, {
  subtotal: "15625.62",
  vatTotal: "3125.13",
  total: "18750.75",
  lineTotals: ["6250.25", "6250.25", "6250.25"],
});
Object.assign(model, {
  subtotal: breakdown.subtotal,
  vatTotal: breakdown.vatTotal,
  total: breakdown.total,
});
for (const key of ["issuedOrPublishedAt", "dueOrExpiresAt"]) {
  if (model[key] !== null) model[key] = new Date(model[key]);
}
process.stdout.write(renderPrintHtml(model, options));
