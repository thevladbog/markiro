import { describe, expect, it, vi } from "vitest";
import { createUsBrowserClient, UsTransformationConflictError } from "../src/us/client.js";
import {
  revisionDraftRecord,
  revisionId,
  transformationId,
} from "./support/us-transformation-ui-fixture.js";

const id = "a0000000-0000-4000-8000-000000000001";
const operationKey = "b0000000-0000-4000-8000-000000000001";
const draft = {
  eventDate: null,
  processorLocationId: null,
  reason: null,
  reasonNote: null,
  notes: null,
  inputs: [],
  outputs: [],
  documentIds: [],
};
const record = {
  id,
  eventNumber: "TRN-26-0001",
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

describe("US Transformation client", () => {
  it("accepts a new amendment revision tied to the requested predecessor and rejects a different root", async () => {
    const command = { operationKey, expectedLifecycleVersion: 2, reason: "Correct quantity" };
    const revision = revisionDraftRecord();
    const receipt = {
      receiptVersion: 1,
      command: "transformation.amend",
      operationKey,
      inputDigest: "a".repeat(64),
      eventId: revisionId,
      record: revision,
    };
    const send = vi.fn<typeof fetch>().mockResolvedValue(Response.json(receipt));
    await expect(
      createUsBrowserClient(send).amendTransformation(transformationId, command),
    ).resolves.toEqual(receipt);
    send.mockResolvedValue(
      Response.json({
        ...receipt,
        record: {
          ...revision,
          lifecycle: { ...revision.lifecycle, rootId: revisionId },
        },
      }),
    );
    await expect(
      createUsBrowserClient(send).amendTransformation(transformationId, command),
    ).rejects.toMatchObject({ code: "invalid_response" });
  });
  it("validates create and save commands and returns only strict records", async () => {
    const send = vi.fn<typeof fetch>().mockImplementation(async () => Response.json(record));
    const client = createUsBrowserClient(send);
    await expect(client.createTransformation({ operationKey, draft })).resolves.toEqual(record);
    await expect(
      client.saveTransformation(id, { operationKey, expectedDraftVersion: 1, draft }),
    ).resolves.toEqual(record);
    expect(
      send.mock.calls.map(([url, options]) => [
        url,
        options?.method,
        JSON.parse(String(options?.body)),
      ]),
    ).toEqual([
      ["/api/us/traceability/transformation", "POST", { operationKey, draft }],
      [
        `/api/us/traceability/transformation/${id}`,
        "PUT",
        { operationKey, expectedDraftVersion: 1, draft },
      ],
    ]);
    expect(send.mock.calls[0]?.[1]).toMatchObject({
      credentials: "same-origin",
      cache: "no-store",
      redirect: "error",
      headers: { "Content-Type": "application/json" },
    });
  });

  it("does not retry an uncertain mutation or change its operation key", async () => {
    const send = vi.fn<typeof fetch>().mockRejectedValue(new Error("secret transport detail"));
    const command = { operationKey, draft };
    await expect(createUsBrowserClient(send).createTransformation(command)).rejects.toMatchObject({
      code: "unavailable",
    });
    expect(send).toHaveBeenCalledOnce();
    expect(send.mock.calls[0]?.[1]?.body).toBe(JSON.stringify(command));
  });

  it("parses typed 409 issues and strips unrecognized server text", async () => {
    const issue = {
      severity: "error",
      group: "event",
      line: null,
      field: "eventDate",
      code: "required",
      detail: null,
    };
    const body = { operationKey, expectedDraftVersion: 1, expectedInputDigest: "a".repeat(64) };
    const send = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        Response.json({ code: "event_incomplete", issues: [issue] }, { status: 409 }),
      );
    const client = createUsBrowserClient(send);
    await expect(client.finalizeTransformation(id, body)).rejects.toMatchObject({
      code: "event_incomplete",
      issues: [issue],
    });
    expect(send).toHaveBeenCalledOnce();
    expect(send.mock.calls[0]?.[1]).toMatchObject({
      method: "POST",
      credentials: "same-origin",
      cache: "no-store",
    });
    send.mockResolvedValue(
      Response.json(
        { code: "event_incomplete", issues: [issue], token: "secret" },
        { status: 409 },
      ),
    );
    await expect(client.finalizeTransformation(id, body)).rejects.toMatchObject({
      code: "conflict",
    });
  });

  it("bounds downstream blockers and preserves hasMore", async () => {
    const blocker = { lotId: id, eventId: id, rootId: id, revision: 1 };
    const send = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        Response.json(
          { code: "traceability_downstream_blocked", blockers: [blocker], hasMore: true },
          { status: 409 },
        ),
      );
    try {
      await createUsBrowserClient(send).voidTransformation(id, {
        operationKey,
        expectedLifecycleVersion: 1,
        reason: "Correction",
      });
      expect.fail("expected conflict");
    } catch (error) {
      expect(error).toBeInstanceOf(UsTransformationConflictError);
      expect(error).toMatchObject({
        code: "traceability_downstream_blocked",
        blockers: [blocker],
        hasMore: true,
      });
      expect(Object.keys(error as object)).not.toContain("body");
    }
  });

  it("does not decode Transformation conflicts under 404 or not-found codes under 409", async () => {
    const command = { operationKey, expectedDraftVersion: 1, expectedInputDigest: "a".repeat(64) };
    const issues = [
      {
        severity: "error",
        group: "event",
        line: null,
        field: "eventDate",
        code: "required",
        detail: null,
      },
    ];
    const wrongStatus = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ code: "event_incomplete", issues }, { status: 404 }));
    await expect(
      createUsBrowserClient(wrongStatus).finalizeTransformation(id, command),
    ).rejects.toMatchObject({
      code: "request_rejected",
    });
    const wrongNotFound = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ code: "transformation_not_found" }, { status: 409 }));
    await expect(
      createUsBrowserClient(wrongNotFound).finalizeTransformation(id, command),
    ).rejects.toMatchObject({
      code: "conflict",
    });
    const validNotFound = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ code: "transformation_not_found" }, { status: 404 }));
    await expect(createUsBrowserClient(validNotFound).getTransformation(id)).rejects.toMatchObject({
      code: "transformation_not_found",
    });
  });

  it("rejects an invalid detail and validates revision and genealogy inputs before sending", async () => {
    const send = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ ...record, eventNumber: "REC-26-0001" }));
    const client = createUsBrowserClient(send);
    await expect(client.getTransformation(id)).rejects.toMatchObject({ code: "invalid_response" });
    await expect(client.listTransformationRevisions(id, { limit: 101 })).rejects.toMatchObject({
      code: "invalid_input",
    });
    await expect(
      client.queryTransformationGenealogy({
        mode: "current",
        startLotId: id,
        direction: "upstream",
        maxDepth: 21,
        maxNodes: 100,
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });
    expect(send).toHaveBeenCalledOnce();
  });

  it("returns a historical void receipt and leaves current-state reload to its caller", async () => {
    const voidRecord = {
      ...record,
      status: "void",
      lifecycle: {
        rootId: id,
        lifecycleVersion: 2,
        currentEventId: null,
        pendingDraftId: null,
        previousRevisionId: null,
        amendmentReason: null,
        supersededByEventId: null,
        supersededAt: null,
        supersededBy: null,
        voidedAt: "2026-09-27T01:00:00.000Z",
        voidedBy: "qa",
        voidReason: "Correction",
      },
    };
    const receipt = {
      receiptVersion: 1,
      command: "transformation.void",
      operationKey,
      inputDigest: "a".repeat(64),
      eventId: id,
      record: voidRecord,
    };
    const send = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json(receipt))
      .mockResolvedValueOnce(Response.json(voidRecord));
    const client = createUsBrowserClient(send);
    await expect(
      client.voidTransformation(id, {
        operationKey,
        expectedLifecycleVersion: 1,
        expectedDraftVersion: 1,
        reason: "Correction",
      }),
    ).resolves.toEqual(receipt);
    expect(send).toHaveBeenCalledOnce();
    await expect(client.getTransformation(id)).resolves.toEqual(voidRecord);
    expect(send.mock.calls.map(([path]) => path)).toEqual([
      `/api/us/traceability/transformation/${id}/void`,
      `/api/us/traceability/transformation/${id}`,
    ]);
  });

  it("uses exact bounded readiness and history queries", async () => {
    const send = vi
      .fn<typeof fetch>()
      .mockImplementation(async () =>
        Response.json({ items: [], limit: 50, offset: 0, lifecycleVersion: 1 }),
      );
    const client = createUsBrowserClient(send);
    await expect(client.listTransformationRevisions(id)).resolves.toMatchObject({ items: [] });
    expect(send.mock.calls[0]?.[0]).toBe(
      `/api/us/traceability/transformation/${id}/revisions?limit=50&offset=0`,
    );
    await expect(client.checkTransformationReadiness(id, 1)).rejects.toMatchObject({
      code: "invalid_response",
    });
    expect(send.mock.calls[1]?.[0]).toBe(
      `/api/us/traceability/transformation/${id}/readiness?expectedDraftVersion=1`,
    );
    expect(send.mock.calls[1]?.[1]).toMatchObject({
      method: "GET",
      credentials: "same-origin",
      cache: "no-store",
    });
  });

  it("posts a validated current genealogy query without local retries", async () => {
    const send = vi.fn<typeof fetch>().mockResolvedValue(Response.json({}));
    const body = {
      mode: "current",
      startLotId: id,
      direction: "upstream",
      maxDepth: 3,
      maxNodes: 100,
    };
    await expect(
      createUsBrowserClient(send).queryTransformationGenealogy(body),
    ).rejects.toMatchObject({ code: "invalid_response" });
    expect(send).toHaveBeenCalledOnce();
    expect(send.mock.calls[0]?.[0]).toBe("/api/us/traceability/transformation/genealogy/query");
    expect(send.mock.calls[0]?.[1]).toMatchObject({
      method: "POST",
      credentials: "same-origin",
      cache: "no-store",
    });
    expect(JSON.parse(String(send.mock.calls[0]?.[1]?.body))).toEqual(body);
  });
});
