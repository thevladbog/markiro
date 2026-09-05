import { describe, expect, it } from "vitest";
import {
  emptyLocationForm,
  emptyPartyForm,
  locationDescriptionGaps,
  parseLocationForm,
  parsePartyForm,
} from "../src/us/master-data/forms.js";

const partyId = "a0000000-0000-4000-8000-000000000001";

describe("US master-data form mapping", () => {
  it("normalizes party optional blanks to null through the shared create contract", () => {
    expect(parsePartyForm({ ...emptyPartyForm(), name: "  Synthetic supplier  " })).toEqual({
      ok: true,
      value: {
        name: "Synthetic supplier",
        legalName: null,
        contactName: null,
        contactPhone: null,
        contactEmail: null,
        notes: null,
      },
    });
    expect(parsePartyForm(emptyPartyForm())).toEqual({
      ok: false,
      errors: { name: "required" },
    });
    expect(
      parsePartyForm({ ...emptyPartyForm(), name: "Synthetic", notes: "x".repeat(2001) }),
    ).toEqual({ ok: false, errors: { notes: "format" } });
  });

  it("allows an incomplete description draft while naming readiness gaps", () => {
    const form = { ...emptyLocationForm(), partyId, name: "Dock", businessName: "Food Co" };
    expect(parseLocationForm(form, "create")).toMatchObject({
      ok: true,
      value: {
        partyId,
        name: "Dock",
        businessName: "Food Co",
        countryCode: "US",
      },
    });
    expect(locationDescriptionGaps(form)).toEqual([
      "phoneNumber",
      "streetAddress",
      "city",
      "stateOrRegion",
      "zipOrPostalCode",
    ]);
  });

  it("distinguishes blank required fields from supplied short invalid values", () => {
    expect(
      parsePartyForm({
        ...emptyPartyForm(),
        name: "Synthetic",
        contactPhone: "1",
      }),
    ).toEqual({ ok: false, errors: { contactPhone: "format" } });
    expect(
      parseLocationForm(
        { ...emptyLocationForm(), partyId: "", name: "Dock", businessName: "Food Co" },
        "create",
      ),
    ).toEqual({ ok: false, errors: { partyId: "required" } });
  });

  it("blocks supplied invalid formats but keeps phone and ZIP as text", () => {
    const result = parseLocationForm(
      {
        ...emptyLocationForm(),
        partyId,
        name: "Dock",
        businessName: "Food Co",
        phoneNumber: "ext.",
        countryCode: "usa",
        zipOrPostalCode: "00123",
      },
      "create",
    );
    expect(result).toEqual({
      ok: false,
      errors: { phoneNumber: "format", countryCode: "format" },
    });
  });

  it("clears incompatible hidden address fields and never includes partyId in an edit", () => {
    const coordinate = parseLocationForm(
      {
        ...emptyLocationForm(),
        partyId,
        name: "Dock",
        businessName: "Food Co",
        addressKind: "coordinates",
        streetAddress: "hidden street",
        latitude: "47.100000",
        longitude: "-122.000001",
      },
      "edit",
    );
    expect(coordinate).toEqual({
      ok: true,
      value: expect.objectContaining({
        addressKind: "coordinates",
        streetAddress: null,
        latitude: "47.100000",
        longitude: "-122.000001",
      }),
    });
    if (coordinate.ok) expect(coordinate.value).not.toHaveProperty("partyId");

    const street = parseLocationForm(
      {
        ...emptyLocationForm(),
        partyId,
        name: "Dock",
        businessName: "Food Co",
        addressKind: "street",
        streetAddress: "12 Market Street",
        latitude: "47.1",
        longitude: "-122.1",
      },
      "create",
    );
    expect(street).toMatchObject({
      ok: true,
      value: { streetAddress: "12 Market Street", latitude: null, longitude: null },
    });
  });
});
