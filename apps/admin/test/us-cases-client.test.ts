import { describe, expect, it, vi } from "vitest";
import { createUsBrowserClient } from "../src/us/client.js";

const id = "a0000000-0000-4000-8000-000000000001";
const linkId = "b0000000-0000-4000-8000-000000000001";
const operationKey = "c0000000-0000-4000-8000-000000000001";

describe("US Cases client", () => {
  it("lists bounded cases through an exact lot path", async () => {
    const value = { lotId: id, originState: "gap", activeCount: 0, rows: [], nextCursor: null };
    const send = vi.fn<typeof fetch>().mockResolvedValue(Response.json(value));
    await expect(
      createUsBrowserClient(send).listLotCases(id, { limit: 50, history: "true" }),
    ).resolves.toEqual(value);
    expect(send.mock.calls[0]?.[0]).toBe(
      `/api/us/traceability/lots/${id}/cases?limit=50&history=true`,
    );
    expect(send.mock.calls[0]?.[1]).toMatchObject({
      method: "GET",
      credentials: "same-origin",
      cache: "no-store",
    });
  });

  it("uses exact unlink route and validates identity in the response", async () => {
    const send = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        linkId,
        lotId: id,
        unlinkedAt: "2026-09-27T00:00:00.000Z",
        unlinkedBy: "actor",
        reason: "Correction",
      }),
    );
    await createUsBrowserClient(send).unlinkLotCase(id, linkId, {
      operationKey,
      reason: "Correction",
    });
    expect(send.mock.calls[0]?.[0]).toBe(`/api/us/traceability/lots/${id}/cases/${linkId}/unlink`);
    expect(send.mock.calls[0]?.[1]).toMatchObject({
      method: "POST",
      body: JSON.stringify({ operationKey, reason: "Correction" }),
    });
    send.mockResolvedValue(
      Response.json({
        linkId,
        lotId: operationKey,
        unlinkedAt: "2026-09-27T00:00:00.000Z",
        unlinkedBy: "actor",
        reason: "Correction",
      }),
    );
    await expect(
      createUsBrowserClient(send).unlinkLotCase(id, linkId, { operationKey, reason: "Correction" }),
    ).rejects.toMatchObject({ code: "invalid_response" });
  });

  it("rejects malformed lot and command inputs before network and strict response violations", async () => {
    const send = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ lotId: id, created: [], unchanged: [], secret: "leak" }));
    const client = createUsBrowserClient(send);
    await expect(client.listLotCases("not-a-uuid")).rejects.toMatchObject({
      code: "invalid_input",
    });
    await expect(client.linkLotCases(id, { operationKey, ssccs: [] })).rejects.toMatchObject({
      code: "invalid_input",
    });
    expect(send).not.toHaveBeenCalled();
    await expect(
      client.linkLotCases(id, { operationKey, ssccs: ["000000000000000000"] }),
    ).rejects.toMatchObject({ code: "invalid_response" });
  });

  it("links cases once and accepts only the requested lot identity", async () => {
    const body = { operationKey, ssccs: ["000000000000000000"] };
    const send = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ lotId: id, created: [], unchanged: [] }));
    await expect(createUsBrowserClient(send).linkLotCases(id, body)).resolves.toEqual({
      lotId: id,
      created: [],
      unchanged: [],
    });
    expect(send).toHaveBeenCalledOnce();
    expect(send.mock.calls[0]?.[0]).toBe(`/api/us/traceability/lots/${id}/cases`);
    expect(send.mock.calls[0]?.[1]).toMatchObject({
      method: "POST",
      credentials: "same-origin",
      cache: "no-store",
      body: JSON.stringify(body),
    });
  });

  it("does not decode Lot conflict codes on a Case command route", async () => {
    const command = { operationKey, ssccs: ["000000000000000000"] };
    for (const response of [
      { code: "LOT_DUPLICATE", existingId: id },
      { code: "lot_source_locked" },
    ]) {
      const send = vi
        .fn<typeof fetch>()
        .mockResolvedValue(Response.json(response, { status: 409 }));
      await expect(createUsBrowserClient(send).linkLotCases(id, command)).rejects.toMatchObject({
        code: "conflict",
      });
      expect(send).toHaveBeenCalledOnce();
    }
  });

  it("decodes Case errors only on their documented status", async () => {
    const command = { operationKey, ssccs: ["000000000000000000"] };
    const conflict = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ code: "case_origin_not_current" }, { status: 409 }));
    await expect(createUsBrowserClient(conflict).linkLotCases(id, command)).rejects.toMatchObject({
      code: "case_origin_not_current",
    });
    const wrongStatus = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ code: "case_origin_not_current" }, { status: 404 }));
    await expect(
      createUsBrowserClient(wrongStatus).linkLotCases(id, command),
    ).rejects.toMatchObject({
      code: "request_rejected",
    });
    const notFound = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ code: "case_not_found" }, { status: 404 }));
    await expect(createUsBrowserClient(notFound).linkLotCases(id, command)).rejects.toMatchObject({
      code: "case_not_found",
    });
  });
});
