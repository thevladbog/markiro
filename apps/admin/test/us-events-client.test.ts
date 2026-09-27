import { describe, expect, it, vi } from "vitest";
import { createUsBrowserClient } from "../src/us/client.js";

const id = "a0000000-0000-4000-8000-000000000001";
const item = {
  id,
  rootId: id,
  type: "transformation",
  eventNumber: "TRN-26-0001",
  revision: 1,
  status: "draft",
  lifecycleVersion: 1,
  currentEventId: null,
  pendingDraftId: id,
  eventDate: null,
  timeZone: "America/Chicago",
  locationId: null,
  locationDisplay: null,
  documentCount: 0,
  updatedAt: "2026-09-27T00:00:00.000Z",
  inputCount: 0,
  outputCount: 0,
};

describe("US Events client", () => {
  it("sends a bounded parsed mixed-list query on the same origin", async () => {
    const send = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ items: [item], limit: 50, offset: 0 }));
    const result = await createUsBrowserClient(send).listEvents({
      type: "transformation",
      limit: 50,
      offset: 0,
    });
    expect(result.items[0]).toEqual(item);
    expect(send).toHaveBeenCalledOnce();
    expect(send.mock.calls[0]?.[0]).toBe(
      "/api/us/traceability/events?type=transformation&history=current&limit=50&offset=0",
    );
    expect(send.mock.calls[0]?.[1]).toMatchObject({
      method: "GET",
      credentials: "same-origin",
      cache: "no-store",
      redirect: "error",
    });
  });

  it("accepts Shipping filter and rejects invalid registry responses", async () => {
    const send = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        Response.json({ items: [{ ...item, type: "shipping" }], limit: 50, offset: 0 }),
      );
    const client = createUsBrowserClient(send);
    await expect(client.listEvents({ type: "shipping" })).rejects.toMatchObject({
      code: "invalid_response",
    });
    expect(send.mock.calls[0]?.[0]).toBe(
      "/api/us/traceability/events?type=shipping&history=current&limit=50&offset=0",
    );
    await expect(client.listEvents()).rejects.toMatchObject({ code: "invalid_response" });
  });
});
