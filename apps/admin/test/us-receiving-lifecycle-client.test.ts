import { createHash, webcrypto } from "node:crypto";
import {
  amendReceivingSchema,
  saveReceivingAmendmentSchema,
  finalizeReceivingRevisionSchema,
  receivingOperationReceiptV2Schema,
  receivingLiveRecordSchema,
  type ReceivingLiveRecord,
  type ReceivingOperationReceiptV2,
} from "@markiro/platform-contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createUsBrowserClient } from "../src/us/client.js";
import {
  amendment,
  amendmentId,
  amendmentFinalized,
  amendInput,
  saveInput,
  finalizeInput,
  predecessor,
} from "./support/us-receiving-revision-command-fixture.js";
import { id, lotId, operationKey } from "./support/us-receiving-finalization-fixture.js";

function acknowledgement(
  command: ReceivingOperationReceiptV2["command"],
  target: string,
  input: unknown,
  record: ReceivingLiveRecord,
) {
  return receivingOperationReceiptV2Schema.parse({
    receiptVersion: 2,
    command,
    operationKey,
    eventId: record.id,
    record,
    inputDigest: createHash("sha256")
      .update(JSON.stringify({ commandVersion: 2, command, eventId: target, input }))
      .digest("hex"),
  });
}
const amendAck = () =>
  acknowledgement("receiving.amend", id, amendReceivingSchema.parse(amendInput), amendment);
const sendValue = (value: unknown, status = 200) =>
  vi.fn<typeof fetch>().mockImplementation(async () => Response.json(value, { status }));
beforeEach(() => vi.stubGlobal("crypto", webcrypto));
afterEach(() => vi.unstubAllGlobals());

describe("Receiving lifecycle transport", () => {
  it("sends canonical amend input and returns the historical receipt without an implicit GET", async () => {
    const send = sendValue(amendAck(), 201);
    const client = createUsBrowserClient(send);
    expect(
      await client.amendReceiving(
        id.toUpperCase(),
        { ...amendInput, reason: ` ${amendInput.reason} ` },
        predecessor,
      ),
    ).toEqual(amendAck());
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(
      `/api/us/traceability/receiving/${id}/amend`,
      expect.objectContaining({
        method: "POST",
        credentials: "same-origin",
        cache: "no-store",
        redirect: "error",
        body: JSON.stringify(amendReceivingSchema.parse(amendInput)),
      }),
    );
  });
  it.each(["save", "finalize"] as const)(
    "validates explicit %s against captured context",
    async (kind) => {
      const input =
        kind === "save"
          ? saveReceivingAmendmentSchema.parse(saveInput)
          : finalizeReceivingRevisionSchema.parse(finalizeInput);
      const ack = acknowledgement(
        `receiving.${kind}`,
        amendmentId,
        input,
        kind === "save" ? amendment : amendmentFinalized,
      );
      const send = sendValue(ack);
      const client = createUsBrowserClient(send);
      const result =
        kind === "save"
          ? await client.saveReceivingDraft(amendmentId, input, amendment)
          : await client.finalizeReceiving(amendmentId, input, amendment);
      expect(result).toEqual(ack);
      expect(send).toHaveBeenCalledTimes(1);
      expect(send.mock.calls[0]?.[0]).toBe(
        `/api/us/traceability/receiving/${amendmentId}${kind === "save" ? "" : "/finalize"}`,
      );
    },
  );
  it("voids a draft while preserving its content and original current receipt", async () => {
    const input = {
      commandVersion: 2,
      operationKey,
      expectedLifecycleVersion: 5,
      expectedDraftVersion: 1,
      reason: "Cancel correction",
    };
    const record = receivingLiveRecordSchema.parse({
      ...amendment,
      status: "void",
      lifecycle: {
        ...amendment.lifecycle,
        lifecycleVersion: 6,
        pendingDraftId: null,
        voidedAt: amendment.updatedAt,
        voidedBy: amendment.updatedBy,
        voidReason: input.reason,
      },
    });
    const ack = acknowledgement("receiving.void", amendmentId, input, record);
    const send = sendValue(ack);
    expect(await createUsBrowserClient(send).voidReceiving(amendmentId, input, amendment)).toEqual(
      ack,
    );
    expect(send.mock.calls[0]?.[0]).toBe(`/api/us/traceability/receiving/${amendmentId}/void`);
    expect(send).toHaveBeenCalledTimes(1);
  });
  it("captures immutable context before transport can mutate the caller's record", async () => {
    const captured = structuredClone(predecessor);
    const send = vi.fn<typeof fetch>().mockImplementation(async () => {
      captured.lifecycle.lifecycleVersion = 99;
      return Response.json(amendAck(), { status: 201 });
    });
    expect(await createUsBrowserClient(send).amendReceiving(id, amendInput, captured)).toEqual(
      amendAck(),
    );
  });
  it.each([
    undefined,
    { ...predecessor, id: operationKey },
    { ...predecessor, lifecycle: { ...predecessor.lifecycle, lifecycleVersion: 99 } },
  ])("rejects missing, foreign or stale captured context before mutation", async (captured) => {
    const send = sendValue(amendAck(), 201);
    await expect(
      createUsBrowserClient(send).amendReceiving(id, amendInput, captured),
    ).rejects.toMatchObject({ code: "invalid_input" });
    expect(send).not.toHaveBeenCalled();
  });
  it("rejects mismatched acknowledgements without hiding the unknown outcome with GET or retries", async () => {
    const ack = amendAck();
    const send = sendValue(
      {
        ...ack,
        record: {
          ...ack.record,
          lifecycle: { ...ack.record.lifecycle, amendmentReason: "Wrong reason" },
        },
      },
      201,
    );
    await expect(
      createUsBrowserClient(send).amendReceiving(id, amendInput, predecessor),
    ).rejects.toMatchObject({ code: "invalid_response" });
    expect(send).toHaveBeenCalledTimes(1);
  });
  it("leaves a failed write to an explicit exact retry, without substituting current context", async () => {
    const send = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new Error("lost response"))
      .mockResolvedValueOnce(Response.json(amendAck(), { status: 201 }));
    const client = createUsBrowserClient(send);
    await expect(client.amendReceiving(id, amendInput, predecessor)).rejects.toMatchObject({
      code: "unavailable",
    });
    expect(send).toHaveBeenCalledTimes(1);
    expect(await client.amendReceiving(id, amendInput, predecessor)).toEqual(amendAck());
    expect(send.mock.calls[0]?.[1]?.body).toBe(send.mock.calls[1]?.[1]?.body);
  });
  it("reads strict history and basis pages and rejects substituted pagination or lot IDs", async () => {
    const history = { items: [], limit: 1, offset: 2, lifecycleVersion: 6 };
    const send = sendValue(history);
    expect(
      await createUsBrowserClient(send).listReceivingRevisions(amendmentId, {
        limit: "1",
        offset: "2",
      }),
    ).toEqual(history);
    expect(send.mock.calls[0]?.[0]).toBe(
      `/api/us/traceability/receiving/${amendmentId}/revisions?limit=1&offset=2`,
    );
    await expect(
      createUsBrowserClient(sendValue({ ...history, offset: 3 })).listReceivingRevisions(
        amendmentId,
        { limit: "1", offset: "2" },
      ),
    ).rejects.toMatchObject({ code: "invalid_response" });
    const basis = {
      lotId,
      basisVersion: 4,
      state: "missing",
      supportCount: 0,
      items: [],
      limit: 50,
      offset: 0,
      hasMore: false,
    };
    expect(await createUsBrowserClient(sendValue(basis)).getLotReceivingBasis(lotId)).toEqual(
      basis,
    );
    await expect(
      createUsBrowserClient(sendValue({ ...basis, lotId: id })).getLotReceivingBasis(lotId),
    ).rejects.toMatchObject({ code: "invalid_response" });
  });
  it.each([{ limit: "01" }, { limit: ["1", "2"] }, { offset: "-1" }, { tenantId: id }])(
    "rejects unsafe page input before fetch",
    async (input) => {
      const send = sendValue({});
      await expect(
        createUsBrowserClient(send).listReceivingRevisions(id, input),
      ).rejects.toMatchObject({ code: "invalid_input" });
      await expect(
        createUsBrowserClient(send).getLotReceivingBasis(lotId, input),
      ).rejects.toMatchObject({ code: "invalid_input" });
      expect(send).not.toHaveBeenCalled();
    },
  );
  it.each([
    {
      code: "receiving_lifecycle_conflict",
      rootId: id,
      lifecycleVersion: 5,
      currentEventId: id,
      pendingDraftId: amendmentId,
    },
    { code: "receiving_pending_amendment", pendingDraftId: amendmentId },
    { code: "lot_identity_locked", lines: [{ lineNo: 1, fields: ["lotId"] }] },
    {
      code: "receiving_downstream_dependencies",
      blockingEvents: [
        { eventId: amendmentId, eventNumber: "SHP-1", revision: 1, kind: "shipping" },
      ],
      correctionOrder: [amendmentId],
      hasMore: false,
    },
  ])("retains only validated structured conflict $code", async (detail) => {
    const client = createUsBrowserClient(sendValue(detail, 409));
    await expect(client.amendReceiving(id, amendInput, predecessor)).rejects.toMatchObject({
      code: detail.code,
      detail,
    });
    await expect(
      createUsBrowserClient(sendValue({ ...detail, sql: "private" }, 409)).amendReceiving(
        id,
        amendInput,
        predecessor,
      ),
    ).rejects.toMatchObject({ code: "conflict" });
  });
});
