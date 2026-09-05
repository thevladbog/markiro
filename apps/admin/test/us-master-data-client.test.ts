import { describe, expect, it, vi } from "vitest";
import { createUsBrowserClient } from "../src/us/client.js";

const party = {
  id: "a0000000-0000-4000-8000-000000000001",
  name: "Synthetic supplier",
  legalName: null,
  contactName: null,
  contactPhone: null,
  contactEmail: null,
  notes: null,
  archived: false,
  createdAt: "2026-09-05T00:00:00.000Z",
  updatedAt: "2026-09-05T00:00:00.000Z",
};
const location = {
  id: "b0000000-0000-4000-8000-000000000002",
  partyId: party.id,
  name: "Receiving dock",
  businessName: "Synthetic supplier",
  phoneNumber: null,
  addressKind: "street",
  streetAddress: null,
  latitude: null,
  longitude: null,
  city: null,
  stateOrRegion: null,
  zipOrPostalCode: null,
  countryCode: null,
  roles: ["receive_at"],
  archived: false,
  createdAt: party.createdAt,
  updatedAt: party.updatedAt,
  descriptionStatus: {
    exportReady: false,
    issues: [
      { field: "phoneNumber", code: "required" },
      { field: "streetAddress", code: "required" },
      { field: "city", code: "required" },
      { field: "stateOrRegion", code: "required" },
      { field: "zipOrPostalCode", code: "required" },
      { field: "countryCode", code: "required" },
    ],
  },
};

function transport(body: unknown, status = 200) {
  return vi.fn<typeof fetch>().mockImplementation(async () => Response.json(body, { status }));
}

describe("US master-data browser client", () => {
  it("reads strict presentation capabilities from the fixed access route", async () => {
    const result = {
      capabilities: ["traceability.read", "traceability.master_data.write"],
    };
    const send = transport(result);
    const api = createUsBrowserClient(send);

    await expect(api.access()).resolves.toEqual(result);
    expect(send).toHaveBeenCalledWith(
      "/api/us/traceability/access",
      expect.objectContaining({
        method: "GET",
        credentials: "same-origin",
        cache: "no-store",
      }),
    );
  });

  it("rejects widened or unknown presentation access without retaining server prose", async () => {
    await expect(
      createUsBrowserClient(
        transport({ capabilities: ["traceability.read"], roles: ["owner"] }),
      ).access(),
    ).rejects.toMatchObject({ code: "invalid_response", message: "invalid_response" });
    await expect(
      createUsBrowserClient(
        transport({ code: "private", message: "membership details" }, 403),
      ).access(),
    ).rejects.toMatchObject({ code: "forbidden", message: "forbidden" });
  });

  it("lists parties with bounded defaults and treats search as data, not URL parameters", async () => {
    const result = { items: [party], limit: 50, offset: 0 };
    const send = transport(result);
    const api = createUsBrowserClient(send);
    expect(await api.listParties()).toEqual(result);
    await api.listParties({ archived: "all", search: " A&B?roles=supplier " });
    expect(send.mock.calls.map(([path]) => path)).toEqual([
      "/api/us/traceability/parties?archived=false&limit=50&offset=0",
      "/api/us/traceability/parties?archived=all&limit=50&offset=0&search=A%26B%3Froles%3Dsupplier",
    ]);
  });

  it("serializes location pagination, parent and repeated role filters without losing any", async () => {
    const result = { items: [location], limit: 20, offset: 40 };
    const send = transport(result);
    expect(
      await createUsBrowserClient(send).listLocations({
        partyId: party.id,
        roles: ["receive_at", "supplier"],
        limit: "20",
        offset: 40,
      }),
    ).toEqual(result);
    expect(send.mock.calls[0]?.[0]).toBe(
      `/api/us/traceability/locations?archived=false&limit=20&offset=40&partyId=${party.id}&roles=receive_at&roles=supplier`,
    );
  });

  it("reads canonical UUID item routes using only same-origin US session transport", async () => {
    const send = transport(party);
    const api = createUsBrowserClient(send);
    expect(await api.getParty(party.id.toUpperCase())).toEqual(party);
    send.mockResolvedValueOnce(Response.json(location));
    expect(await api.getLocation(location.id.toUpperCase())).toEqual(location);
    expect(send.mock.calls.map(([path]) => path)).toEqual([
      `/api/us/traceability/parties/${party.id}`,
      `/api/us/traceability/locations/${location.id}`,
    ]);
    for (const [, init] of send.mock.calls) {
      expect(init).toMatchObject({
        method: "GET",
        credentials: "same-origin",
        cache: "no-store",
        redirect: "error",
        signal: expect.any(AbortSignal),
      });
      expect(init?.body).toBeUndefined();
    }
  });

  it("creates parties with shared defaults but PATCH never clears omitted fields", async () => {
    const send = transport(party);
    const api = createUsBrowserClient(send);
    expect(await api.createParty({ name: " Synthetic supplier " })).toEqual(party);
    await api.updateParty(party.id, { archived: true });
    await api.updateParty(party.id, { archived: false });
    await api.updateParty(party.id, { contactEmail: null });
    expect(send.mock.calls.map(([path, init]) => [path, init?.method, init?.body])).toEqual([
      [
        "/api/us/traceability/parties",
        "POST",
        JSON.stringify({
          name: "Synthetic supplier",
          legalName: null,
          contactName: null,
          contactPhone: null,
          contactEmail: null,
          notes: null,
        }),
      ],
      [`/api/us/traceability/parties/${party.id}`, "PATCH", '{"archived":true}'],
      [`/api/us/traceability/parties/${party.id}`, "PATCH", '{"archived":false}'],
      [`/api/us/traceability/parties/${party.id}`, "PATCH", '{"contactEmail":null}'],
    ]);
  });

  it("creates incomplete locations and preserves phone extensions, postal and coordinate strings on PATCH", async () => {
    const send = transport(location);
    const api = createUsBrowserClient(send);
    expect(
      await api.createLocation({
        partyId: party.id,
        name: "Receiving dock",
        businessName: "Synthetic supplier",
        roles: ["receive_at"],
      }),
    ).toEqual(location);
    expect(JSON.parse(String(send.mock.calls[0]?.[1]?.body))).toMatchObject({
      partyId: party.id,
      addressKind: "street",
      phoneNumber: null,
      streetAddress: null,
      roles: ["receive_at"],
    });
    const patch = {
      phoneNumber: "+1 (212) 555-0100 ext. 42",
      zipOrPostalCode: "00123",
      addressKind: "coordinates",
      streetAddress: null,
      latitude: "47.100000",
      longitude: "-122.000001",
    };
    await api.updateLocation(location.id, patch);
    expect(send.mock.calls[1]?.[0]).toBe(`/api/us/traceability/locations/${location.id}`);
    expect(send.mock.calls[1]?.[1]).toMatchObject({
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
    });
    expect(JSON.parse(String(send.mock.calls[1]?.[1]?.body))).toEqual(patch);
    await api.updateLocation(location.id, { archived: true });
    await api.updateLocation(location.id, { archived: false });
    expect(send.mock.calls.slice(2).map(([, init]) => [init?.method, init?.body])).toEqual([
      ["PATCH", '{"archived":true}'],
      ["PATCH", '{"archived":false}'],
    ]);
  });

  it("rejects forged fields, empty patches, invalid coordinates and reparenting before sending", async () => {
    const send = transport({});
    const api = createUsBrowserClient(send);
    for (const operation of [
      () => api.createParty({ name: "Synthetic", tenantId: "foreign" }),
      () => api.createParty({ name: "Synthetic", archived: true }),
      () => api.updateParty(party.id, {}),
      () => api.createLocation({ ...location, tenantId: "foreign" }),
      () => api.createLocation({ partyId: party.id, name: "Dock", businessName: "" }),
      () => api.updateLocation(location.id, {}),
      () => api.updateLocation(location.id, { partyId: party.id }),
      () => api.updateLocation(location.id, { latitude: "91" }),
      () => api.updateLocation(location.id, { latitude: "47.1234567" }),
      () => api.listParties({ limit: 101 }),
      () => api.listParties({ limit: "1e2" }),
      () => api.listParties({ tenantId: "foreign" }),
      () => api.listLocations({ roles: ["supplier", "supplier"] }),
      () => api.listLocations({ roles: "unknown" }),
    ])
      await expect(operation()).rejects.toMatchObject({ code: "invalid_input" });
    expect(send).not.toHaveBeenCalled();
  });

  it.each(["../profile", "https://remote.example", `${party.id}?tenantId=foreign`, "", null])(
    "rejects invalid item identity %s without constructing a fetch URL",
    async (id) => {
      const send = transport({});
      const api = createUsBrowserClient(send);
      for (const operation of [
        () => api.getParty(id),
        () => api.getLocation(id),
        () => api.updateParty(id, { archived: true }),
        () => api.updateLocation(id, { archived: true }),
      ])
        await expect(operation()).rejects.toMatchObject({ code: "invalid_input" });
      expect(send).not.toHaveBeenCalled();
    },
  );

  it("rejects incomplete, widened and oversized server responses", async () => {
    await expect(
      createUsBrowserClient(transport({ id: party.id })).getParty(party.id),
    ).rejects.toMatchObject({ code: "invalid_response" });
    await expect(
      createUsBrowserClient(transport({ ...party, tenantId: "foreign" })).createParty({
        name: "Synthetic",
      }),
    ).rejects.toMatchObject({ code: "invalid_response" });
    await expect(
      createUsBrowserClient(transport({ ...location, descriptionStatus: null })).getLocation(
        location.id,
      ),
    ).rejects.toMatchObject({ code: "invalid_response" });
    await expect(
      createUsBrowserClient(
        transport({ items: [party, party], limit: 1, offset: 0 }),
      ).listParties(),
    ).rejects.toMatchObject({ code: "invalid_response" });
    await expect(
      createUsBrowserClient(
        transport({ items: [location, location], limit: 1, offset: 0 }),
      ).listLocations(),
    ).rejects.toMatchObject({ code: "invalid_response" });
  });

  it.each([
    [400, "invalid_master_data", "request_rejected"],
    [401, "session_required", "session_required"],
    [403, "traceability_profile_required", "forbidden"],
    [409, "party_name_taken", "conflict"],
    [503, "traceability_profile_not_provisioned", "unavailable"],
  ] as const)(
    "sanitizes HTTP %s without retries or opening profile setup",
    async (status, code, expected) => {
      const send = transport(
        { code, issues: [{ path: "name", message: "private detail" }] },
        status,
      );
      await expect(
        createUsBrowserClient(send).createParty({ name: "Synthetic" }),
      ).rejects.toMatchObject({
        code: expected,
        message: expected,
      });
      expect(send).toHaveBeenCalledTimes(1);
    },
  );

  it("preserves the safe party-archived conflict code for location-form recovery", async () => {
    const send = transport({ code: "party_archived", message: "private server detail" }, 403);

    await expect(
      createUsBrowserClient(send).createLocation({
        partyId: party.id,
        name: "Receiving dock",
        businessName: "Synthetic supplier",
      }),
    ).rejects.toMatchObject({ code: "party_archived", message: "party_archived" });
  });
});
