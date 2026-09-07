import { describe, expect, it, vi } from "vitest";
import { createUsBrowserClient } from "../src/us/client.js";

const id = "a0000000-0000-4000-8000-000000000001";
const operationKey = "b0000000-0000-4000-8000-000000000001";
const draft = {
  dateReceived: null,
  locationId: null,
  previousSourceLocationId: null,
  receivedAtNote: null,
  notes: null,
  items: [],
  documentIds: [],
};
const record = {
  id,
  eventNumber: "REC-26-0001",
  status: "draft",
  revision: 1,
  draftVersion: 1,
  timeZone: "America/Chicago",
  createdBy: "actor",
  updatedBy: "actor",
  createdAt: "2026-09-07T00:00:00.000Z",
  updatedAt: "2026-09-07T00:00:00.000Z",
  draft,
};
const document = {
  id,
  type: "bol",
  typeOtherLabel: null,
  number: "BOL-01",
  partyId: null,
  issuedOn: null,
  notes: null,
  archivedAt: null,
  createdBy: "actor",
  createdAt: record.createdAt,
  updatedAt: record.updatedAt,
};
const transport = (value: unknown, status = 200) =>
  vi.fn<typeof fetch>().mockImplementation(async () => Response.json(value, { status }));

describe("US receiving browser boundary", () => {
  it.each([false, true])(
    "accepts only omitted/null extension compatibility in acknowledgements (%s)",
    async (withNull) => {
      const item = {
        productId: null,
        lotId: null,
        lotLinkMode: "create_on_finalize",
        tlc: null,
        source: null,
        exemptSupplier: false,
        exemptReason: null,
        supplierLotReference: null,
        quantity: null,
        unitOfMeasure: null,
        notes: null,
      };
      const oldDraft = { ...draft, items: [item] };
      const newDraft = { ...draft, items: [{ ...item, exemptReceipt: null }] };
      const requestDraft = withNull ? newDraft : oldDraft;
      const responseDraft = withNull ? oldDraft : newDraft;
      const response = { ...record, draft: responseDraft };
      const client = createUsBrowserClient(transport(response));
      await expect(
        client.createReceivingDraft({ operationKey, draft: requestDraft }),
      ).resolves.toEqual(response);
      await expect(
        client.saveReceivingDraft(id, {
          operationKey,
          expectedDraftVersion: 1,
          draft: requestDraft,
        }),
      ).resolves.toEqual(response);
    },
  );
  it("rejects schema-valid acknowledgements for a different draft without losing retry identity", async () => {
    const send = transport(record);
    const client = createUsBrowserClient(send);
    const input = { operationKey, draft: { ...draft, notes: "My delivery" } };
    await expect(client.createReceivingDraft(input)).rejects.toMatchObject({
      code: "invalid_response",
    });
    await expect(
      client.saveReceivingDraft(id, { ...input, expectedDraftVersion: 1 }),
    ).rejects.toMatchObject({ code: "invalid_response" });
    expect(send).toHaveBeenCalledTimes(2);
  });
  it("does not treat populated or changed exemption, quantity or source data as an acknowledgement", async () => {
    const extension = {
      evidenceUrl: "https://supplier.example.test/Declaration",
      tlcHandling: "assign_if_missing",
      proposedTlc: "=Own/Ä",
    };
    const item = {
      productId: null,
      lotId: null,
      lotLinkMode: "create_on_finalize",
      tlc: null,
      source: { kind: "location", locationId: id },
      exemptSupplier: true,
      exemptReason: "Receipt declaration",
      supplierLotReference: null,
      quantity: "1.000",
      unitOfMeasure: "lb",
      notes: null,
      exemptReceipt: extension,
    };
    const input = { operationKey, draft: { ...draft, items: [item] } };
    const changes = [
      { exemptReceipt: null },
      { exemptReason: "Different reason" },
      { exemptReceipt: { ...extension, proposedTlc: "=own/Ä" } },
      { exemptReceipt: { ...extension, evidenceUrl: "https://supplier.example.test/declaration" } },
      { exemptReceipt: { ...extension, tlcHandling: "preserve_existing" } },
      { quantity: "1.001" },
      { source: { kind: "location", locationId: operationKey } },
    ];
    for (const change of changes) {
      const client = createUsBrowserClient(
        transport({ ...record, draft: { ...draft, items: [{ ...item, ...change }] } }),
      );
      await expect(client.createReceivingDraft(input)).rejects.toMatchObject({
        code: "invalid_response",
      });
      await expect(
        client.saveReceivingDraft(id, { ...input, expectedDraftVersion: 1 }),
      ).rejects.toMatchObject({ code: "invalid_response" });
    }
  });
  it("serializes bounded list filters and validates the returned page", async () => {
    const header = Object.fromEntries(Object.entries(record).filter(([key]) => key !== "draft"));
    const summary = {
      ...header,
      dateReceived: null,
      locationId: null,
      previousSourceLocationId: null,
      lineCount: 0,
      documentCount: 0,
    };
    const send = transport({ items: [summary], limit: 50, offset: 0 });
    await createUsBrowserClient(send).listReceivingDrafts({ search: "REC&A" });
    const url = new URL(String(send.mock.lastCall?.[0]), "http://localhost");
    expect(url.pathname).toBe("/api/us/traceability/receiving");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      search: "REC&A",
      status: "draft",
      limit: "50",
      offset: "0",
    });
    await expect(
      createUsBrowserClient(send).listReceivingDrafts({ tenantId: "foreign" }),
    ).rejects.toMatchObject({ code: "invalid_input" });
    await expect(
      createUsBrowserClient(
        transport({ items: [record], limit: 50, offset: 0 }),
      ).listReceivingDrafts(),
    ).rejects.toMatchObject({ code: "invalid_response" });
  });
  it("preserves explicit retry keys and versions on exact isolated draft routes", async () => {
    const send = transport(record);
    const client = createUsBrowserClient(send);
    await client.getReceivingDraft(id.toUpperCase());
    await client.createReceivingDraft({ operationKey, draft });
    await client.saveReceivingDraft(id, { operationKey, expectedDraftVersion: 1, draft });
    expect(send.mock.calls.map(([url, init]) => [url, init?.method])).toEqual([
      [`/api/us/traceability/receiving/${id}`, "GET"],
      ["/api/us/traceability/receiving", "POST"],
      [`/api/us/traceability/receiving/${id}`, "PUT"],
    ]);
    expect(JSON.parse(String(send.mock.lastCall?.[1]?.body))).toEqual({
      operationKey,
      expectedDraftVersion: 1,
      draft,
    });
    expect(send.mock.lastCall?.[1]).toMatchObject({
      credentials: "same-origin",
      redirect: "error",
      cache: "no-store",
    });
  });
  it("rejects forged identity and input before sending", async () => {
    const send = transport(record);
    const client = createUsBrowserClient(send);
    await expect(client.getReceivingDraft("../profile")).rejects.toMatchObject({
      code: "invalid_input",
    });
    await expect(client.createReceivingDraft({ draft })).rejects.toMatchObject({
      code: "invalid_input",
    });
    await expect(
      client.saveReceivingDraft(id, {
        operationKey,
        draft,
        expectedDraftVersion: 1,
        tenantId: "other",
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });
    expect(send).not.toHaveBeenCalled();
    await expect(
      createUsBrowserClient(transport({ ...record, id: operationKey })).getReceivingDraft(id),
    ).rejects.toMatchObject({ code: "invalid_response" });
    await expect(
      createUsBrowserClient(transport({ ...record, id: operationKey })).saveReceivingDraft(id, {
        operationKey,
        draft,
        expectedDraftVersion: 1,
      }),
    ).rejects.toMatchObject({ code: "invalid_response" });
  });
  it.each([
    [409, "receiving_draft_conflict"],
    [409, "receiving_operation_conflict"],
    [409, "receiving_reference_inactive"],
    [404, "receiving_reference_not_found"],
    [404, "receiving_draft_not_found"],
    [401, "session_required"],
    [403, "forbidden"],
  ] as const)("maps %s to safe %s without automatic retries", async (status, code) => {
    const send = transport({ code }, status);
    await expect(
      createUsBrowserClient(send).saveReceivingDraft(id, {
        operationKey,
        expectedDraftVersion: 1,
        draft,
      }),
    ).rejects.toMatchObject({ code, message: code });
    expect(send).toHaveBeenCalledTimes(1);
  });
  it("never exposes raw server errors or accepts malformed draft state", async () => {
    const client = createUsBrowserClient(
      transport({ code: "receiving_draft_conflict", secret: "private" }, 409),
    );
    await expect(client.getReceivingDraft(id)).rejects.toMatchObject({
      code: "conflict",
      message: "conflict",
    });
    await expect(
      createUsBrowserClient(transport({ ...record, status: "finalized" })).getReceivingDraft(id),
    ).rejects.toMatchObject({ code: "invalid_response" });
  });
  it("provides reference-document search, detail and metadata creation without attachments", async () => {
    const send = transport(document);
    const client = createUsBrowserClient(send);
    await client.getReferenceDocument(id);
    await client.createReferenceDocument({
      type: "bol",
      typeOtherLabel: null,
      number: " BOL-01 ",
      partyId: null,
      issuedOn: null,
      notes: null,
    });
    expect(send.mock.calls.map(([url, init]) => [url, init?.method])).toEqual([
      [`/api/us/traceability/reference-documents/${id}`, "GET"],
      ["/api/us/traceability/reference-documents", "POST"],
    ]);
    expect(JSON.parse(String(send.mock.lastCall?.[1]?.body)).number).toBe("BOL-01");
    const list = transport({ items: [document], limit: 50, offset: 0 });
    await createUsBrowserClient(list).listReferenceDocuments({ search: "BOL&A" });
    expect(
      new URL(String(list.mock.lastCall?.[0]), "http://localhost").searchParams.get("search"),
    ).toBe("BOL&A");
    await expect(
      createUsBrowserClient(transport({ code: "document_duplicate" }, 409)).createReferenceDocument(
        {
          type: "bol",
          typeOtherLabel: null,
          number: "BOL-01",
          partyId: null,
          issuedOn: null,
          notes: null,
        },
      ),
    ).rejects.toMatchObject({ code: "document_duplicate" });
  });
});
