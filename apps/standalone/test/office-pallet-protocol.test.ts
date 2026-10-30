import { officeCodeItemSchema } from "../src/host/code-search.js";
import { officeBoxCardSchema } from "../src/host/pack-cards.js";
import { disaggregationLineSchema } from "../src/host/disaggregation.js";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { palletCreate, palletValidate } from "../src/host/requests.js";
import {
  officeWarehousePalletDetailSchema,
  palletCreatedSchema,
  palletCreateRequestSchema,
  palletValidateRequestSchema,
  palletValidationSchema,
} from "../src/host/office-pallet-create.js";
const moduleUrl = import.meta.url;
function fixture(name: string): unknown {
  return JSON.parse(readFileSync(new URL(`../proto/fixtures/${name}.json`, moduleUrl), "utf8"));
}
describe("office pallet wire parity", () => {
  it("parses the Rust detail and creation fixtures and builds every request field", () => {
    for (const [name, schema] of [
      ["office-warehouse-pallet-detail", officeWarehousePalletDetailSchema],
      ["office-pallet-validate-request", palletValidateRequestSchema],
      ["office-pallet-validate-response", palletValidationSchema],
      ["office-pallet-create-request", palletCreateRequestSchema],
      ["office-pallet-create-response", palletCreatedSchema],
    ] as const)
      expect(schema.parse(fixture(name))).toEqual(fixture(name));
    expect(disaggregationLineSchema.parse(fixture("warehouse-disaggregation-line"))).toEqual(
      fixture("warehouse-disaggregation-line"),
    );
    expect(officeBoxCardSchema.parse(fixture("office-box-card-warehouse"))).toEqual(
      fixture("office-box-card-warehouse"),
    );
    expect(officeCodeItemSchema.parse(fixture("office-code-item-warehouse"))).toEqual(
      fixture("office-code-item-warehouse"),
    );
    const input = palletCreateRequestSchema.parse(fixture("office-pallet-create-request"));
    expect(palletCreate(input.requestId, input.codes)).toEqual(input);
    expect(palletValidate(input.codes)).toEqual(fixture("office-pallet-validate-request"));
  });
});
