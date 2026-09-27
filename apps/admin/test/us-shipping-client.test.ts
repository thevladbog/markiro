import { describe, expect, it, vi } from "vitest";
import { createUsBrowserClient } from "../src/us/client.js";

const id = "a0000000-0000-4000-8000-000000000001";
const nextId = "a0000000-0000-4000-8000-000000000002";
const operationKey = "b0000000-0000-4000-8000-000000000001";
const draft = {
  eventDate: null,
  shipFromLocationId: null,
  recipientLocationId: null,
  carrierReference: null,
  notes: null,
  items: [],
  documentIds: [],
};
const record = {
  id,
  eventNumber: "SHP-26-0001",
  revision: 1,
  draftVersion: 1,
  timeZone: "America/Chicago",
  createdBy: "actor",
  updatedBy: "actor",
  createdAt: "2026-09-27T00:00:00.000Z",
  updatedAt: "2026-09-27T00:00:00.000Z",
  status: "draft",
  draft,
};
const lifecycle = {
  rootId: id,
  lifecycleVersion: 2,
  currentEventId: id,
  pendingDraftId: nextId,
  previousRevisionId: id,
  amendmentReason: "Correct quantity",
  supersededByEventId: null,
  supersededAt: null,
  supersededBy: null,
  voidedAt: null,
  voidedBy: null,
  voidReason: null,
};

describe("US Shipping client", () => {
  it("correlates exact lot balance reads and replacement context", async () => {
    const balance = {
      lotId: id,
      originUom: "case",
      balance: {
        state: "known",
        unitOfMeasure: "case",
        supply: "100",
        used: "20",
        remaining: "80",
      },
    };
    const send = vi.fn<typeof fetch>().mockImplementation(async () => Response.json(balance));
    const client = createUsBrowserClient(send);
    await expect(client.getShippingBalance(id)).resolves.toEqual(balance);
    expect(send.mock.lastCall?.[0]).toBe(`/api/us/traceability/lots/${id}/shipping-balance`);
    await expect(
      client.getShippingBalance(id, { contextDraftId: nextId, expectedDraftVersion: 2 }),
    ).resolves.toEqual(balance);
    expect(send.mock.lastCall?.[0]).toBe(
      `/api/us/traceability/lots/${id}/shipping-balance?contextDraftId=${nextId}&expectedDraftVersion=2`,
    );
    send.mockResolvedValue(Response.json({ ...balance, lotId: nextId }));
    await expect(client.getShippingBalance(id)).rejects.toMatchObject({ code: "invalid_response" });
    await expect(client.getShippingBalance(id, { contextDraftId: nextId })).rejects.toMatchObject({
      code: "invalid_input",
    });
  });
  it("lists only strict Shipping summaries through unified Events", async () => {
    const summary = {
      id,
      rootId: id,
      type: "shipping",
      eventNumber: record.eventNumber,
      revision: 1,
      status: "draft",
      lifecycleVersion: 1,
      currentEventId: null,
      pendingDraftId: id,
      eventDate: null,
      timeZone: record.timeZone,
      locationId: null,
      locationDisplay: null,
      lineCount: 0,
      documentCount: 0,
      updatedAt: record.updatedAt,
    };
    const send = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ items: [summary], limit: 1, offset: 0 }));
    const client = createUsBrowserClient(send);
    await expect(client.listShipping({ limit: 1 })).resolves.toMatchObject({ items: [summary] });
    expect(send.mock.calls[0]?.[0]).toBe(
      "/api/us/traceability/events?type=shipping&history=current&limit=1&offset=0",
    );
    send.mockResolvedValue(
      Response.json({
        items: [{ ...summary, type: "receiving", previousSourceLocationId: null }],
        limit: 1,
        offset: 0,
      }),
    );
    await expect(client.listShipping({ limit: 1 })).rejects.toMatchObject({
      code: "invalid_response",
    });
    await expect(client.listShipping({ tenantId: id })).rejects.toMatchObject({
      code: "invalid_input",
    });
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("validates create, get, save and readiness against exact request and response identity", async () => {
    const send = vi.fn<typeof fetch>().mockImplementation(async () => Response.json(record));
    const client = createUsBrowserClient(send);
    await expect(client.createShipping({ operationKey, draft })).resolves.toEqual(record);
    await expect(client.getShipping(id)).resolves.toEqual(record);
    await expect(
      client.saveShipping(id, { operationKey, expectedDraftVersion: 1, draft }),
    ).resolves.toEqual(record);
    expect(send.mock.calls.map(([path, options]) => [path, options?.method])).toEqual([
      ["/api/us/traceability/shipments", "POST"],
      [`/api/us/traceability/shipments/${id}`, "GET"],
      [`/api/us/traceability/shipments/${id}`, "PUT"],
    ]);
    expect(JSON.parse(String(send.mock.calls[0]?.[1]?.body))).toEqual({ operationKey, draft });
    expect(send.mock.calls[0]?.[1]).toMatchObject({
      credentials: "same-origin",
      cache: "no-store",
      redirect: "error",
    });
    send.mockResolvedValue(Response.json({ ...record, id: nextId }));
    await expect(client.getShipping(id)).rejects.toMatchObject({ code: "invalid_response" });
    await expect(
      client.saveShipping(id, { operationKey, expectedDraftVersion: 1, draft }),
    ).rejects.toMatchObject({ code: "invalid_response" });
    await expect(
      client.createShipping({ operationKey, draft: { ...draft, tenantId: id } }),
    ).rejects.toMatchObject({ code: "invalid_input" });
    await expect(client.getShipping("not-a-uuid")).rejects.toMatchObject({ code: "invalid_input" });
    const readiness = {
      eventId: id,
      expectedDraftVersion: 1,
      ruleVersion: "shipping-readiness-v1",
      inputDigest: "a".repeat(64),
      state: "complete",
      profileCode: "US_FSMA204_PROCESSOR",
      issues: [],
    };
    send.mockResolvedValue(Response.json(readiness));
    await expect(client.checkShippingReadiness(id, 1)).resolves.toEqual(readiness);
    expect(send.mock.lastCall?.[0]).toBe(
      `/api/us/traceability/shipments/${id}/readiness?expectedDraftVersion=1`,
    );
    await expect(client.checkShippingReadiness(id, 0)).rejects.toMatchObject({
      code: "invalid_input",
    });
  });

  it("uses strict lifecycle commands, bounded revisions and typed errors", async () => {
    const send = vi.fn<typeof fetch>().mockResolvedValue(Response.json(record));
    const client = createUsBrowserClient(send);
    const finalize = { operationKey, expectedDraftVersion: 1, expectedInputDigest: "a".repeat(64) };
    await expect(client.finalizeShipping(id, finalize)).rejects.toMatchObject({
      code: "invalid_response",
    });
    expect(send.mock.lastCall?.[0]).toBe(`/api/us/traceability/shipments/${id}/finalize`);
    const amended = { ...record, id: nextId, revision: 2, lifecycle };
    const amendReceipt = {
      receiptVersion: 1,
      command: "shipping.amend",
      operationKey,
      inputDigest: "b".repeat(64),
      eventId: nextId,
      record: amended,
    };
    send.mockResolvedValue(Response.json(amendReceipt));
    await expect(
      client.amendShipping(id, {
        operationKey,
        expectedLifecycleVersion: 2,
        reason: "Correct quantity",
      }),
    ).resolves.toEqual(amendReceipt);
    expect(send.mock.lastCall?.[0]).toBe(`/api/us/traceability/shipments/${id}/amend`);
    send.mockResolvedValue(Response.json({ ...amendReceipt, command: "shipping.void" }));
    await expect(
      client.voidShipping(id, { operationKey, expectedLifecycleVersion: 2, reason: "Cancel" }),
    ).rejects.toMatchObject({ code: "invalid_response" });
    expect(send.mock.lastCall?.[0]).toBe(`/api/us/traceability/shipments/${id}/void`);
    send.mockResolvedValue(Response.json({ items: [], limit: 1, offset: 0, lifecycleVersion: 2 }));
    await expect(client.listShippingRevisions(id, { limit: 1, offset: 0 })).resolves.toMatchObject({
      items: [],
    });
    expect(send.mock.lastCall?.[0]).toBe(
      `/api/us/traceability/shipments/${id}/revisions?limit=1&offset=0`,
    );
    await expect(client.listShippingRevisions(id, { limit: 101, offset: 0 })).rejects.toMatchObject(
      { code: "invalid_input" },
    );
    send.mockResolvedValue(Response.json({ code: "shipping_draft_conflict" }, { status: 409 }));
    await expect(
      client.saveShipping(id, { operationKey, expectedDraftVersion: 1, draft }),
    ).rejects.toMatchObject({ code: "shipping_draft_conflict" });
    send.mockResolvedValue(
      Response.json({ code: "shipping_draft_conflict", secret: "raw" }, { status: 409 }),
    );
    await expect(
      client.saveShipping(id, { operationKey, expectedDraftVersion: 1, draft }),
    ).rejects.toMatchObject({ code: "conflict" });
  });
});
