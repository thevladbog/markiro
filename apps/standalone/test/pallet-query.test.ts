import { describe, expect, it } from "vitest";

import {
  EMPTY_PALLET_FILTERS,
  palletFiltersOf,
  palletListQuery,
  paramsOfPalletFilters,
  type PalletFilters,
} from "../src/office/codes/pallet-query.js";

const PRODUCT = "6f1c2a7e-3b4d-4c5e-8f90-1a2b3c4d5e6f";
const LINE = "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d";
const DEVICE = "7c9e6679-7425-40de-944b-e07fc1f90ae7";

const FULL: PalletFilters = {
  product: PRODUCT,
  line: LINE,
  device: DEVICE,
  from: "2026-10-08",
  to: "2026-10-09",
  sscc: "146006820000000409",
};

describe("the pallet list's filters in the address", () => {
  it("go to the address and come back from it", () => {
    const params = paramsOfPalletFilters(FULL);
    expect(params.toString()).toBe(
      `product=${PRODUCT}&line=${LINE}&device=${DEVICE}&from=2026-10-08&to=2026-10-09&sscc=146006820000000409`,
    );
    expect(palletFiltersOf(params)).toEqual(FULL);
  });

  it("write nothing for an empty filter", () => {
    expect(paramsOfPalletFilters(EMPTY_PALLET_FILTERS).toString()).toBe("");
    expect(palletFiltersOf(new URLSearchParams())).toEqual(EMPTY_PALLET_FILTERS);
  });

  it("drop what an address names wrongly instead of sending it on", () => {
    const read = palletFiltersOf(
      new URLSearchParams({
        product: "not a uuid",
        line: "A0000000-0000-4000-8000-000000000001",
        device: "1",
        from: "yesterday",
        to: "2026-13-40",
        sscc: "12345",
      }),
    );
    expect(read).toEqual(EMPTY_PALLET_FILTERS);
  });
});

describe("the host's query of the filters", () => {
  it("is empty when nothing is narrowed", () => {
    expect(palletListQuery(EMPTY_PALLET_FILTERS, "Europe/Moscow")).toEqual({});
  });

  it("carries the ids and the SSCC as they are", () => {
    expect(
      palletListQuery({ ...EMPTY_PALLET_FILTERS, product: PRODUCT, line: LINE }, "UTC"),
    ).toEqual({ product: PRODUCT, line: LINE });
    expect(
      palletListQuery({ ...EMPTY_PALLET_FILTERS, device: DEVICE, sscc: FULL.sscc }, "UTC"),
    ).toEqual({ device: DEVICE, sscc: FULL.sscc });
  });

  it("reads the days in the organization's zone, both ends included", () => {
    const query = palletListQuery(
      { ...EMPTY_PALLET_FILTERS, from: "2026-10-08", to: "2026-10-08" },
      "Europe/Moscow",
    );
    expect(query).toEqual({
      fromMs: Date.parse("2026-10-07T21:00:00.000Z"),
      toMs: Date.parse("2026-10-08T21:00:00.000Z"),
    });
  });

  it("allows a period open at either end", () => {
    expect(palletListQuery({ ...EMPTY_PALLET_FILTERS, from: "2026-10-08" }, "UTC")).toEqual({
      fromMs: Date.parse("2026-10-08T00:00:00.000Z"),
    });
    expect(palletListQuery({ ...EMPTY_PALLET_FILTERS, to: "2026-10-08" }, "UTC")).toEqual({
      toMs: Date.parse("2026-10-09T00:00:00.000Z"),
    });
  });

  it("is nothing to ask for an SSCC that is not 18 digits or a period backwards", () => {
    expect(
      palletListQuery({ ...EMPTY_PALLET_FILTERS, sscc: "14600682000000040" }, "UTC"),
    ).toBeNull();
    expect(
      palletListQuery({ ...EMPTY_PALLET_FILTERS, from: "2026-10-09", to: "2026-10-08" }, "UTC"),
    ).toBeNull();
  });
});
