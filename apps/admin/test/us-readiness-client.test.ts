import { usReadinessResultSchema } from "@markiro/platform-contracts";
import { describe, expect, it, vi } from "vitest";
import { createUsBrowserClient } from "../src/us/client.js";

const readinessPath = "/api/us/traceability/readiness";
const productId = "a0000000-0000-4000-8000-000000000001";
const lotId = "a0000000-0000-4000-8000-000000000002";
const valid = usReadinessResultSchema.parse({
  scope: {
    eventDateFrom: "2024-10-01",
    eventDateTo: "2026-09-28",
    productId: null,
    lotId: null,
    profileCode: "US_FSMA204_PROCESSOR",
    defaulted: true,
  },
  assessedAt: "2026-09-28T12:00:00.000Z",
  state: "empty",
  recordsChecked: { events: 0, lots: 0 },
  dependenciesChecked: 0,
  counts: { error: 0, warning: 0, info: 0 },
  groups: { byCte: [], byProduct: [], bySeverity: [] },
  findings: [],
  draftWork: { total: 0, items: [], hasMore: false, eventsHref: "/traceability/events" },
});

describe("US readiness browser client", () => {
  it("reads the fixed route with same-origin, no-store GET options", async () => {
    const send = vi.fn<typeof fetch>().mockResolvedValue(Response.json(valid));

    expect(await createUsBrowserClient(send).readReadiness()).toEqual(valid);
    expect(send).toHaveBeenCalledOnce();
    expect(send.mock.calls[0]?.[0]).toBe(readinessPath);
    expect(send.mock.calls[0]?.[1]).toMatchObject({
      method: "GET",
      credentials: "same-origin",
      cache: "no-store",
      redirect: "error",
    });
  });

  it("serializes only validated explicit scope fields in fixed order", async () => {
    const send = vi.fn<typeof fetch>().mockResolvedValue(Response.json(valid));

    await createUsBrowserClient(send).readReadiness({
      lotId,
      eventDateTo: "2026-09-28",
      productId,
      eventDateFrom: "2026-09-01",
    });

    expect(send).toHaveBeenCalledOnce();
    expect(send.mock.calls[0]?.[0]).toBe(
      `${readinessPath}?eventDateFrom=2026-09-01&eventDateTo=2026-09-28&productId=${productId}&lotId=${lotId}`,
    );
  });

  it.each([
    [{ eventDateFrom: "2026-09-01" }, "half-date"],
    [{ eventDateFrom: "2026-09-28", eventDateTo: "2026-09-01" }, "reversed date"],
    [{ eventDateFrom: "2024-09-01", eventDateTo: "2026-09-28" }, "over-24-month"],
    [{ productId: "not-a-uuid" }, "malformed UUID"],
  ])("rejects %s (%s) before fetch", async (input, _description) => {
    const send = vi.fn<typeof fetch>().mockResolvedValue(Response.json(valid));

    await expect(createUsBrowserClient(send).readReadiness(input)).rejects.toMatchObject({
      code: "invalid_input",
    });
    expect(send).not.toHaveBeenCalled();
  });

  it("rejects a malformed success response", async () => {
    const send = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ ...valid, findings: null }));

    await expect(createUsBrowserClient(send).readReadiness()).rejects.toMatchObject({
      code: "invalid_response",
    });
  });

  it("maps only the exact documented 503 body to scope too large", async () => {
    const send = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json({ code: "us_readiness_scope_too_large" }, { status: 503 }),
      )
      .mockResolvedValueOnce(Response.json({ code: "other" }, { status: 503 }))
      .mockResolvedValueOnce(
        Response.json({ code: "us_readiness_scope_too_large", detail: "extra" }, { status: 503 }),
      );
    const client = createUsBrowserClient(send);

    await expect(client.readReadiness()).rejects.toMatchObject({
      code: "readiness_scope_too_large",
    });
    await expect(client.readReadiness()).rejects.toMatchObject({ code: "unavailable" });
    await expect(client.readReadiness()).rejects.toMatchObject({ code: "unavailable" });
  });

  it("maps fixed-route 400 and 404 regardless of sanitized response body", async () => {
    const send = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ message: "bad" }, { status: 400 }))
      .mockResolvedValueOnce(Response.json({ message: "missing" }, { status: 404 }));
    const client = createUsBrowserClient(send);

    await expect(client.readReadiness()).rejects.toMatchObject({ code: "readiness_invalid_scope" });
    await expect(client.readReadiness()).rejects.toMatchObject({
      code: "readiness_scope_not_found",
    });
  });

  it("does not apply readiness error mappings to other US routes", async () => {
    const send = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json({ code: "us_readiness_scope_too_large" }, { status: 503 }),
      )
      .mockResolvedValueOnce(Response.json({ message: "bad" }, { status: 400 }))
      .mockResolvedValueOnce(Response.json({ message: "missing" }, { status: 404 }));
    const client = createUsBrowserClient(send);

    await expect(client.listEvents()).rejects.toMatchObject({ code: "unavailable" });
    await expect(client.listEvents()).rejects.toMatchObject({ code: "request_rejected" });
    await expect(client.listEvents()).rejects.toMatchObject({ code: "request_rejected" });
  });
});
