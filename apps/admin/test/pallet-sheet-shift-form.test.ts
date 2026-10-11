import { describe, expect, it } from "vitest";
import { toPayload, type ShiftFormValues } from "../src/pages/shifts/ShiftForm.js";
const values: ShiftFormValues = {
  productId: "product",
  mode: "aggregation",
  palletsEnabled: true,
  palletBoxCapacity: "48",
  boxCapacity: "12",
  boxLabelTemplateSelection: "box",
  palletLabelTemplateId: "legacy",
  palletSheetTemplateSelection: "sheet",
};
describe("shift sheet selection", () => {
  it("explicitly reselects the resolved default on a dirty edit while leaving untouched edits omitted", () => {
    const changed = {
      lineId: false,
      plannedQty: false,
      plannedDate: false,
      productionDate: false,
      boxLabelTemplate: false,
      palletLabelTemplate: false,
      palletSheetTemplate: true,
    };
    expect(
      toPayload(
        { ...values, palletSheetTemplateSelection: "" },
        "edit",
        { counterparty: false, ssccIssuer: false },
        "box",
        "planned",
        changed,
        false,
        "category-sheet",
      ),
    ).toHaveProperty("palletSheetTemplateId", "category-sheet");
    expect(
      toPayload(
        { ...values, palletSheetTemplateSelection: "" },
        "edit",
        { counterparty: false, ssccIssuer: false },
        "box",
        "planned",
        changed,
        false,
        null,
      ),
    ).toHaveProperty("palletSheetTemplateId", null);
  });
  it("selects the explicit sheet on create", () => {
    expect(
      toPayload(values, "create", { counterparty: false, ssccIssuer: false }, "box"),
    ).toMatchObject({ palletSheetTemplateId: "sheet" });
  });
  it("does not reselect a saved revision on unrelated planned edits", () => {
    expect(
      toPayload(values, "edit", { counterparty: false, ssccIssuer: false }, "box", "planned", {
        lineId: false,
        plannedQty: true,
        plannedDate: false,
        productionDate: false,
        boxLabelTemplate: false,
        palletLabelTemplate: false,
        palletSheetTemplate: false,
      }),
    ).not.toHaveProperty("palletSheetTemplateId");
  });
  it("sends explicit removal and allows a default to remain omitted", () => {
    expect(
      toPayload(
        { ...values, palletSheetTemplateSelection: "none" },
        "create",
        { counterparty: false, ssccIssuer: false },
        "box",
      ),
    ).toHaveProperty("palletSheetTemplateId", null);
    expect(
      toPayload(
        { ...values, palletSheetTemplateSelection: "" },
        "create",
        { counterparty: false, ssccIssuer: false },
        "box",
      ),
    ).not.toHaveProperty("palletSheetTemplateId");
  });
});
