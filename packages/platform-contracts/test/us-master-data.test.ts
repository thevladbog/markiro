import { describe, expect, it } from "vitest";
import {
  createUsLocationSchema,
  createUsPartySchema,
  listUsLocationsQuerySchema,
  listUsPartiesQuerySchema,
  updateUsLocationSchema,
  updateUsPartySchema,
  usLocationListSchema,
  usLocationSchema,
  usPartyListSchema,
  usPartySchema,
} from "../src/traceability/master-data.js";

const partyId = "123e4567-e89b-12d3-a456-426614174000";
const locationId = "123e4567-e89b-12d3-a456-426614174001";
const timestamps = {
  createdAt: "2026-09-05T00:00:00.000Z",
  updatedAt: "2026-09-05T00:00:01.000Z",
};

describe("US party contracts", () => {
  it("trims required names and applies nullable create defaults", () => {
    expect(createUsPartySchema.parse({ name: "  Synthetic  " })).toEqual({
      name: "Synthetic",
      legalName: null,
      contactName: null,
      contactPhone: null,
      contactEmail: null,
      notes: null,
    });
  });

  it.each([
    { name: "Synthetic", tenantId: "forged" },
    { name: "Synthetic", archived: true },
    { name: "Synthetic", id: partyId },
    { name: "Synthetic", createdAt: timestamps.createdAt },
    { name: "Synthetic", contactPhone: "ext." },
    { name: "Synthetic", contactEmail: "not-an-email" },
    { name: " " },
  ])("rejects invalid, extra or server-owned party create data %j", (input) => {
    expect(createUsPartySchema.safeParse(input).success).toBe(false);
  });

  it("accepts nonempty partial updates without create defaults", () => {
    expect(updateUsPartySchema.parse({ archived: true })).toEqual({ archived: true });
    expect(updateUsPartySchema.parse({ legalName: null })).toEqual({ legalName: null });
    expect(updateUsPartySchema.safeParse({}).success).toBe(false);
    expect(updateUsPartySchema.safeParse({ name: undefined }).success).toBe(false);
    expect(updateUsPartySchema.safeParse({ partyId }).success).toBe(false);
  });

  it("requires every persisted party response field and rejects tenant context", () => {
    const party = {
      id: partyId,
      name: "Synthetic",
      legalName: null,
      contactName: null,
      contactPhone: null,
      contactEmail: null,
      notes: null,
      archived: false,
      ...timestamps,
    };
    expect(usPartySchema.parse(party)).toEqual(party);
    for (const key of Object.keys(party)) {
      expect(usPartySchema.safeParse({ ...party, [key]: undefined }).success).toBe(false);
    }
    expect(usPartySchema.safeParse({ ...party, tenantId: "forged" }).success).toBe(false);
  });
});

describe("US location contracts", () => {
  it("applies create-only description defaults and keeps party identity explicit", () => {
    expect(
      createUsLocationSchema.parse({
        partyId,
        name: "  Main plant  ",
        businessName: "  Synthetic Foods  ",
      }),
    ).toEqual({
      partyId,
      name: "Main plant",
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
      roles: [],
    });
  });

  it("preserves valid textual description values and rejects duplicate or unknown roles", () => {
    const input = {
      partyId,
      name: "Main plant",
      businessName: "Synthetic Foods",
      phoneNumber: "+1 (212) 555-0100 ext. 07",
      streetAddress: " 12 Market Street ",
      zipOrPostalCode: "00123",
      countryCode: "US",
      roles: ["supplier", "ship_from"],
    };
    expect(createUsLocationSchema.parse(input)).toMatchObject(input);
    expect(
      createUsLocationSchema.safeParse({ ...input, roles: ["supplier", "supplier"] }).success,
    ).toBe(false);
    expect(createUsLocationSchema.safeParse({ ...input, roles: ["warehouse"] }).success).toBe(
      false,
    );
  });

  it("does not invent a coordinate string length limit", () => {
    const latitude = "0".repeat(33);
    expect(
      createUsLocationSchema.parse({
        partyId,
        name: "Main plant",
        businessName: "Synthetic Foods",
        addressKind: "coordinates",
        latitude,
      }).latitude,
    ).toBe(latitude);
  });

  it.each([
    { partyId: "not-a-uuid", name: "Main", businessName: "Synthetic" },
    { partyId, name: "Main", businessName: "Synthetic", countryCode: "us" },
    { partyId, name: "Main", businessName: "Synthetic", latitude: "1e2" },
    { partyId, name: "Main", businessName: "Synthetic", longitude: "180.000001" },
    { partyId, name: "Main", businessName: "Synthetic", actorId: partyId },
    { partyId, name: "Main", businessName: "Synthetic", archived: true },
  ])("rejects malformed or server-owned location create data %j", (input) => {
    expect(createUsLocationSchema.safeParse(input).success).toBe(false);
  });

  it("keeps partyId immutable and partial location updates free of defaults", () => {
    expect(updateUsLocationSchema.parse({ archived: true })).toEqual({ archived: true });
    expect(updateUsLocationSchema.parse({ streetAddress: null })).toEqual({ streetAddress: null });
    expect(updateUsLocationSchema.safeParse({}).success).toBe(false);
    expect(updateUsLocationSchema.safeParse({ roles: undefined }).success).toBe(false);
    expect(updateUsLocationSchema.safeParse({ partyId }).success).toBe(false);
  });

  it("requires a complete persisted location and strict description status", () => {
    const location = {
      id: locationId,
      partyId,
      name: "Main plant",
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
      roles: ["supplier"],
      archived: false,
      ...timestamps,
      descriptionStatus: {
        exportReady: false,
        issues: [{ field: "phoneNumber", code: "required" }],
      },
    };
    expect(usLocationSchema.parse(location)).toEqual(location);
    for (const key of Object.keys(location)) {
      expect(usLocationSchema.safeParse({ ...location, [key]: undefined }).success).toBe(false);
    }
    expect(
      usLocationSchema.safeParse({
        ...location,
        descriptionStatus: { ...location.descriptionStatus, approved: true },
      }).success,
    ).toBe(false);
  });
});

describe("US master-data list contracts", () => {
  const partyItem = {
    id: partyId,
    name: "Synthetic",
    legalName: null,
    contactName: null,
    contactPhone: null,
    contactEmail: null,
    notes: null,
    archived: false,
    ...timestamps,
  };
  const locationItem = {
    id: locationId,
    partyId,
    name: "Main plant",
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
    roles: ["supplier"],
    archived: false,
    ...timestamps,
    descriptionStatus: {
      exportReady: false,
      issues: [{ field: "phoneNumber", code: "required" }],
    },
  };

  it("parses canonical bounded party query integers and active-only defaults", () => {
    expect(listUsPartiesQuerySchema.parse({ limit: "100", offset: "0" })).toEqual({
      archived: "false",
      limit: 100,
      offset: 0,
    });
    expect(listUsPartiesQuerySchema.parse({ search: "  Synthetic  ", archived: "all" })).toEqual({
      search: "Synthetic",
      archived: "all",
      limit: 50,
      offset: 0,
    });
    for (const limit of ["", "01", "1e2", "1.5", [], ["50"]]) {
      expect(listUsPartiesQuerySchema.safeParse({ limit }).success).toBe(false);
    }
  });

  it("normalizes one or repeated location role filters and rejects open or duplicate values", () => {
    expect(listUsLocationsQuerySchema.parse({ roles: "supplier", partyId })).toEqual({
      archived: "false",
      limit: 50,
      offset: 0,
      partyId,
      roles: ["supplier"],
    });
    expect(listUsLocationsQuerySchema.parse({ roles: ["supplier", "processor"] })).toEqual({
      archived: "false",
      limit: 50,
      offset: 0,
      roles: ["supplier", "processor"],
    });
    expect(listUsLocationsQuerySchema.safeParse({ roles: "warehouse" }).success).toBe(false);
    expect(listUsLocationsQuerySchema.safeParse({ roles: ["supplier", "supplier"] }).success).toBe(
      false,
    );
  });

  it("bounds strict list envelopes without inventing totals", () => {
    const partyList = { items: [], limit: 50, offset: 0 };
    const locationList = { items: [], limit: 100, offset: 100000 };
    expect(usPartyListSchema.parse(partyList)).toEqual(partyList);
    expect(usLocationListSchema.parse(locationList)).toEqual(locationList);
    expect(usPartyListSchema.safeParse({ ...partyList, total: 0 }).success).toBe(false);
    expect(usLocationListSchema.safeParse({ ...locationList, limit: 101 }).success).toBe(false);
  });

  it.each([
    ["party", usPartyListSchema, partyItem],
    ["location", usLocationListSchema, locationItem],
  ])("rejects %s responses with more than 100 items", (_resource, schema, item) => {
    expect(schema.safeParse({ items: Array(101).fill(item), limit: 100, offset: 0 }).success).toBe(
      false,
    );
  });

  it.each([
    ["party", usPartyListSchema, partyItem],
    ["location", usLocationListSchema, locationItem],
  ])("rejects %s responses containing more items than their limit", (_resource, schema, item) => {
    expect(schema.safeParse({ items: [item, item], limit: 1, offset: 0 }).success).toBe(false);
  });
});
