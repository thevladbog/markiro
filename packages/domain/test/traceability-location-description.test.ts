import { describe, expect, it } from "vitest";
import {
  TRACEABILITY_LOCATION_ROLES,
  buildLocationDescriptionSnapshot,
  validateLocationDescription,
  type LocationDescriptionInput,
} from "../src/traceability/location-description.js";

const draftLocation: LocationDescriptionInput = {
  businessName: "Synthetic Foods",
  phoneNumber: null,
  addressKind: "street",
  streetAddress: null,
  latitude: null,
  longitude: null,
  city: null,
  stateOrRegion: null,
  zipOrPostalCode: null,
  countryCode: null,
};

const exportReadyStreet: LocationDescriptionInput = {
  ...draftLocation,
  phoneNumber: "+1 (212) 555-0100 ext. 07",
  streetAddress: " 12 Market Street ",
  city: "New York",
  stateOrRegion: "NY",
  zipOrPostalCode: "00123",
  countryCode: "US",
};

describe("location description validation", () => {
  it("keeps incomplete but structurally valid descriptions in draft state", () => {
    expect(validateLocationDescription(draftLocation, "draft")).toEqual([]);
    expect(validateLocationDescription(draftLocation, "export_ready")).toEqual([
      { field: "phoneNumber", code: "required" },
      { field: "streetAddress", code: "required" },
      { field: "city", code: "required" },
      { field: "stateOrRegion", code: "required" },
      { field: "zipOrPostalCode", code: "required" },
      { field: "countryCode", code: "required" },
    ]);
  });

  it("rejects blank optional text and malformed supplied phone or country values", () => {
    expect(
      validateLocationDescription(
        {
          ...draftLocation,
          businessName: " ",
          phoneNumber: "ext.",
          city: "\t",
          countryCode: "us",
        },
        "draft",
      ),
    ).toEqual([
      { field: "businessName", code: "required" },
      { field: "phoneNumber", code: "format" },
      { field: "city", code: "format" },
      { field: "countryCode", code: "format" },
    ]);

    for (const phoneNumber of ["12", "123#456", "1".repeat(41)]) {
      expect(
        validateLocationDescription({ ...draftLocation, phoneNumber }, "draft"),
      ).toContainEqual({ field: "phoneNumber", code: "format" });
    }
  });

  it("accepts allowed phone whitespace without normalizing the supplied text", () => {
    expect(
      validateLocationDescription({ ...draftLocation, phoneNumber: "123\n456" }, "draft"),
    ).toEqual([]);
  });

  it("accepts only bounded plain decimal coordinates with at most six fraction digits", () => {
    expect(
      validateLocationDescription(
        {
          ...draftLocation,
          addressKind: "coordinates",
          latitude: "-90.000000",
          longitude: "180",
        },
        "draft",
      ),
    ).toEqual([]);

    const invalidCoordinates = [
      ["90.000001", "0", "latitude"],
      ["0", "-180.000001", "longitude"],
      ["1e2", "0", "latitude"],
      [".5", "0", "latitude"],
      ["1.1234567", "0", "latitude"],
      ["+1", "0", "latitude"],
    ] as const;
    for (const [latitude, longitude, field] of invalidCoordinates) {
      expect(
        validateLocationDescription(
          { ...draftLocation, addressKind: "coordinates", latitude, longitude },
          "draft",
        ),
      ).toContainEqual({ field, code: "format" });
    }
  });

  it("enforces the address discriminant while allowing partial draft coordinates", () => {
    expect(
      validateLocationDescription(
        { ...draftLocation, addressKind: "coordinates", latitude: "40.7" },
        "draft",
      ),
    ).toEqual([]);
    expect(
      validateLocationDescription(
        { ...draftLocation, addressKind: "coordinates", latitude: "40.7" },
        "export_ready",
      ),
    ).toContainEqual({ field: "longitude", code: "required" });
    expect(
      validateLocationDescription({ ...draftLocation, latitude: "40.7" }, "draft"),
    ).toContainEqual({ field: "latitude", code: "format" });
    expect(
      validateLocationDescription(
        { ...draftLocation, addressKind: "coordinates", streetAddress: "12 Market Street" },
        "draft",
      ),
    ).toContainEqual({ field: "streetAddress", code: "format" });
  });
});

describe("location description snapshots", () => {
  it("returns export-readiness issues instead of an incomplete snapshot", () => {
    expect(
      buildLocationDescriptionSnapshot({ ...draftLocation, id: "location-1", partyId: "party-1" }),
    ).toEqual({
      ok: false,
      issues: [
        { field: "phoneNumber", code: "required" },
        { field: "streetAddress", code: "required" },
        { field: "city", code: "required" },
        { field: "stateOrRegion", code: "required" },
        { field: "zipOrPostalCode", code: "required" },
        { field: "countryCode", code: "required" },
      ],
    });
  });

  it("copies exact street, phone extension and numeric postal text into fixed snapshot keys", () => {
    expect(
      buildLocationDescriptionSnapshot({
        ...exportReadyStreet,
        id: "location-1",
        partyId: "party-1",
      }),
    ).toEqual({
      ok: true,
      snapshot: {
        schemaVersion: 1,
        locationId: "location-1",
        partyId: "party-1",
        businessName: "Synthetic Foods",
        phoneNumber: "+1 (212) 555-0100 ext. 07",
        address: { kind: "street", streetAddress: " 12 Market Street " },
        city: "New York",
        stateOrRegion: "NY",
        zipOrPostalCode: "00123",
        countryCode: "US",
        countryDisplay: "United States",
      },
    });
  });

  it.each([
    ["CA", "Canada"],
    ["MX", "Mexico"],
    ["ZZ", "ZZ"],
  ])("uses deterministic country display text for %s", (countryCode, countryDisplay) => {
    const result = buildLocationDescriptionSnapshot({
      ...exportReadyStreet,
      id: "location-1",
      partyId: "party-1",
      countryCode,
    });
    expect(result).toMatchObject({ ok: true, snapshot: { countryDisplay } });
  });

  it("builds the coordinate address variant without converting supplied decimals", () => {
    expect(
      buildLocationDescriptionSnapshot({
        ...exportReadyStreet,
        id: "location-2",
        partyId: "party-1",
        addressKind: "coordinates",
        streetAddress: null,
        latitude: "040.700000",
        longitude: "-074.000000",
      }),
    ).toMatchObject({
      ok: true,
      snapshot: {
        address: { kind: "coordinates", latitude: "040.700000", longitude: "-074.000000" },
      },
    });
  });

  it("publishes one closed location-role inventory", () => {
    expect(TRACEABILITY_LOCATION_ROLES).toEqual([
      "supplier",
      "processor",
      "ship_from",
      "receive_at",
      "recipient",
      "tlc_source",
    ]);
  });
});
