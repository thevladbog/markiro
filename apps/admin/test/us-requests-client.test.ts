import { afterEach, describe, expect, it, vi } from "vitest";
import { createUsBrowserClient } from "../src/us/client.js";

const id = "a0000000-0000-4000-8000-000000000001";
const runId = "b0000000-0000-4000-8000-000000000002";
const key = "c0000000-0000-4000-8000-000000000003";
const digest = "a".repeat(64);
const time = "2026-10-05T00:00:00Z";
const root = "/api/us/traceability";
const create = {
  requestNumber: "REQ-1",
  requesterName: "Requester",
  requesterOrganization: null,
  requesterContact: null,
  receivedAt: time,
  scope: null,
};
const summary = {
  id,
  requestNumber: "REQ-1",
  revision: 2,
  status: "open",
  receivedAt: time,
  dueAt: "2026-10-06T00:00:00Z",
  createdBy: "actor",
  createdAt: time,
  updatedAt: time,
  closedAt: null,
  lastValidatedAt: null,
};
const detail = {
  ...summary,
  requesterName: "Requester",
  requesterOrganization: null,
  requesterContact: null,
  alternateDeadlineReason: null,
  scope: null,
  savedValidation: null,
  warningAcknowledgement: null,
  latestRun: null,
  availability: { build: "available", packageStorage: "configured" },
};
const receipt = { httpRequestId: key, requestId: id, revision: 2, status: "open" };
const page = { items: [], limit: 25, offset: 0, hasMore: false };
const prepareBody = {
  mode: "export_ready" as const,
  idempotencyKey: key,
  expectedRevision: 2,
  validationDigest: digest,
};
const prepareReceipt = {
  httpRequestId: key,
  requestId: id,
  requestRevision: 2,
  runId,
  runRevision: 1,
  mode: "export_ready",
  idempotencyKey: key,
  scopedContentDigest: digest,
};
const retryBody = { expectedLifecycleVersion: 2, reason: "Retry explicitly", idempotencyKey: key };
const retryReceipt = {
  httpRequestId: key,
  runId,
  cycle: 2,
  lifecycleVersion: 3,
  requestedBy: "actor",
  idempotencyKey: key,
};
const validationReceipt = {
  httpRequestId: key,
  requestId: id,
  revision: 2,
  digest,
  byteSize: 10,
  matchedRevisionCount: 0,
  findings: [],
  validatedAt: time,
};
const runSummary = {
  runId,
  requestId: id,
  requestRevision: 2,
  runRevision: 1,
  mode: "export_ready",
  status: "queued",
  exportReady: false,
  createdBy: "actor",
  commandDigest: digest,
  scopedContentDigest: digest,
  inputDigest: null,
  lifecycleVersion: 0,
  retryCycle: 1,
  attemptCount: 0,
  cycleAttemptCount: 0,
  failureCode: null,
  startedAt: time,
  generationStartedAt: null,
  reportRenderedAt: null,
  completedAt: null,
  nextAttemptAt: null,
  provenance: "not_verified",
};
const runDetail = {
  ...runSummary,
  request: {
    requestNumber: "REQ-1",
    requesterName: "Requester",
    requesterOrganization: null,
    requesterContact: null,
    receivedAt: time,
    id,
    revision: 2,
    dueAt: summary.dueAt,
    alternateDeadlineReason: null,
  },
  scope: { tlc: "LOT-1" },
  findings: [],
  latestAttempt: null,
  artifacts: [],
  missingFiles: null,
};
type Client = ReturnType<typeof createUsBrowserClient>["requests"];
const operations: {
  name: string;
  method: string;
  path: string;
  status?: number;
  body?: unknown;
  response: unknown;
  call: (client: Client, signal?: AbortSignal) => Promise<unknown>;
}[] = [
  {
    name: "list",
    method: "GET",
    path: "/requests?limit=25&offset=0",
    response: page,
    call: (c, s) => c.list(undefined, s),
  },
  {
    name: "get",
    method: "GET",
    path: `/requests/${id}`,
    response: detail,
    call: (c, s) => c.get(id, s),
  },
  {
    name: "create",
    method: "POST",
    path: "/requests",
    status: 201,
    body: create,
    response: receipt,
    call: (c, s) => c.create(create, s),
  },
  {
    name: "update",
    method: "PATCH",
    path: `/requests/${id}`,
    body: { expectedRevision: 1, requesterName: "Changed" },
    response: receipt,
    call: (c, s) => c.update(id, { expectedRevision: 1, requesterName: "Changed" }, s),
  },
  {
    name: "close",
    method: "POST",
    path: `/requests/${id}/close`,
    body: { expectedRevision: 1 },
    response: { ...receipt, status: "closed" },
    call: (c, s) => c.close(id, { expectedRevision: 1 }, s),
  },
  {
    name: "validate",
    method: "POST",
    path: `/requests/${id}/validate`,
    body: { expectedRevision: 2 },
    response: validationReceipt,
    call: (c, s) => c.validate(id, { expectedRevision: 2 }, s),
  },
  {
    name: "acknowledgeWarnings",
    method: "POST",
    path: `/requests/${id}/acknowledge-warnings`,
    body: { expectedRevision: 2, digest, reason: "Reviewed warnings" },
    response: receipt,
    call: (c, s) =>
      c.acknowledgeWarnings(id, { expectedRevision: 2, digest, reason: "Reviewed warnings" }, s),
  },
  {
    name: "prepare",
    method: "POST",
    path: `/requests/${id}/prepare`,
    body: prepareBody,
    response: prepareReceipt,
    call: (c, s) => c.prepare(id, prepareBody, s),
  },
  {
    name: "listRuns",
    method: "GET",
    path: `/requests/${id}/runs?limit=25&offset=0`,
    response: page,
    call: (c, s) => c.listRuns(id, undefined, s),
  },
  {
    name: "getRun",
    method: "GET",
    path: `/export-runs/${runId}`,
    response: runDetail,
    call: (c, s) => c.getRun(runId, s),
  },
  {
    name: "listAttempts",
    method: "GET",
    path: `/export-runs/${runId}/attempts?limit=25&offset=0`,
    response: page,
    call: (c, s) => c.listAttempts(runId, undefined, s),
  },
  {
    name: "retry",
    method: "POST",
    path: `/export-runs/${runId}/retry`,
    body: retryBody,
    response: retryReceipt,
    call: (c, s) => c.retry(runId, retryBody, s),
  },
];
const transport = (body: unknown, status = 200) =>
  vi.fn<typeof fetch>().mockResolvedValue(Response.json(body, { status }));
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("strict Requests JSON boundary", () => {
  it("rejects explicit null queries instead of replacing invalid input with defaults", async () => {
    const send = transport(page);
    // @ts-expect-error Explicit null is not an omitted query.
    await expect(createUsBrowserClient(send).requests.list(null)).rejects.toMatchObject({
      code: "invalid_input",
    });
    expect(send).not.toHaveBeenCalled();
  });
  for (const [status, code, expected] of [
    ...[
      "us_request_invalid_instant",
      "us_request_deadline_out_of_range",
      "us_request_deadline_order",
      "us_request_alternate_reason_required",
    ].map((code) => [400, code, code]),
    ...["us_request_not_found", "us_request_run_not_found", "us_request_artifact_not_found"].map(
      (code) => [404, code, code],
    ),
    ...[
      "us_request_revision_conflict",
      "us_request_number_conflict",
      "us_request_closed",
      "us_request_scope_required",
      "us_request_validation_stale",
      "us_request_warnings_required",
      "us_request_validation_required",
      "us_request_idempotency_conflict",
      "us_request_selection_limit",
      "us_request_snapshot_limit",
      "us_request_not_export_ready",
      "us_request_workbook_unrepresentable",
      "us_request_warning_ack_required",
      "us_request_worker_retry_conflict",
      "us_request_worker_lease_lost",
      "us_request_worker_deadline_exceeded",
      "us_request_worker_checkpoint_mismatch",
      "us_request_package_refreeze_required",
      "us_request_run_not_ready",
    ].map((code) => [409, code, code]),
    [400, "us_request_worker_retry_conflict", "us_request_worker_retry_conflict"],
    [400, "us_invalid_query", "invalid_input"],
    [413, "us_body_too_large", "invalid_input"],
    [401, "us_request_closed", "session_required"],
    [403, "us_request_closed", "forbidden"],
    [429, "anything", "rate_limited"],
    [503, "us_request_build_unavailable", "unavailable"],
    [503, "us_request_stored_invalid", "unavailable"],
    [503, "us_request_package_storage_read_failed", "unavailable"],
    [400, "us_request_closed", "request_rejected"],
    [404, "us_request_closed", "request_rejected"],
    [409, "unknown", "conflict"],
    [500, "us_request_closed", "unavailable"],
    [400, "unknown", "request_rejected"],
  ] as const)
    it(`maps only verified status/code pair ${status}/${code}`, async () => {
      await expect(
        createUsBrowserClient(transport({ code }, Number(status))).requests.get(id),
      ).rejects.toMatchObject({ code: expected });
    });
  it("uses string query inputs and never enriches list rows", async () => {
    const send = transport(page);
    await createUsBrowserClient(send).requests.list({ limit: "25", offset: "0", status: "open" });
    expect(String(send.mock.calls[0]?.[0])).toBe(`${root}/requests?status=open&limit=25&offset=0`);
    expect(send).toHaveBeenCalledTimes(1);
  });
  it("serializes supported list and history fields in deterministic order", async () => {
    const send = vi.fn<typeof fetch>().mockImplementation(async () => Response.json(page));
    const c = createUsBrowserClient(send).requests;
    await c.list({ offset: "0", limit: "25", status: "closed", requestNumber: "REQ + 1" });
    await c.listRuns(id, { offset: "3", limit: "2" });
    await c.listAttempts(runId, { offset: "3", limit: "2" });
    expect(send.mock.calls.map(([url]) => String(url))).toEqual([
      `${root}/requests?requestNumber=REQ+%2B+1&status=closed&limit=25&offset=0`,
      `${root}/requests/${id}/runs?limit=2&offset=3`,
      `${root}/export-runs/${runId}/attempts?limit=2&offset=3`,
    ]);
  });
  for (const op of operations) {
    it(`${op.name} uses its exact route, body, success status and session policy`, async () => {
      vi.useFakeTimers();
      const send = transport(op.response, op.status);
      await expect(op.call(createUsBrowserClient(send).requests)).resolves.toEqual(op.response);
      expect(send).toHaveBeenCalledExactlyOnceWith(root + op.path, {
        method: op.method,
        credentials: "same-origin",
        cache: "no-store",
        redirect: "error",
        signal: expect.any(AbortSignal),
        ...(op.body === undefined
          ? {}
          : { headers: { "content-type": "application/json" }, body: expect.any(String) }),
      });
      if (op.body !== undefined)
        expect(JSON.parse(String(send.mock.calls[0]?.[1]?.body))).toEqual(op.body);
      expect(vi.getTimerCount()).toBe(0);
    });
    it(`${op.name} rejects unknown successful properties`, async () => {
      await expect(
        op.call(
          createUsBrowserClient(
            transport({ ...Object(op.response), secret: "must-not-escape" }, op.status),
          ).requests,
        ),
      ).rejects.toMatchObject({ code: "invalid_response" });
    });
  }
  for (const [name, response] of [
    ["get", { ...detail, id: runId }],
    ["update", { ...receipt, requestId: runId }],
    ["close", { ...receipt, requestId: runId, status: "closed" }],
    ["validate", { ...validationReceipt, requestId: runId }],
    ["acknowledgeWarnings", { ...receipt, requestId: runId }],
    ["prepare", { ...prepareReceipt, requestId: runId }],
    ["getRun", { ...runDetail, runId: id }],
    ["retry", { ...retryReceipt, runId: id }],
    ["prepare", { ...prepareReceipt, idempotencyKey: id }],
    ["prepare", { ...prepareReceipt, mode: "available_records_incomplete" }],
    ["prepare", { ...prepareReceipt, requestRevision: 3 }],
    ["prepare", { ...prepareReceipt, scopedContentDigest: "b".repeat(64) }],
    ["retry", { ...retryReceipt, idempotencyKey: id }],
    ["listRuns", { ...page, items: [{ ...runSummary, requestId: runId }] }],
  ] as const)
    it(`${name} rejects mismatched identity or command echo ${JSON.stringify(response).slice(0, 70)}`, async () => {
      const op = operations.find((candidate) => candidate.name === name);
      if (!op) throw new Error("Missing test operation");
      await expect(
        op.call(createUsBrowserClient(transport(response)).requests),
      ).rejects.toMatchObject({ code: "invalid_response" });
    });
  it("rejects ID aliases, numeric query inputs, unknown inputs and schema-oversized TLC values before sending", async () => {
    const send = transport(page);
    const c = createUsBrowserClient(send).requests;
    for (const invalidId of [id.toUpperCase(), id.replace("a", "%61"), "not-a-uuid", `${id}/close`])
      await expect(c.get(invalidId)).rejects.toMatchObject({ code: "invalid_input" });
    // @ts-expect-error Runtime boundary must also reject numeric schema output passed as input.
    await expect(c.list({ limit: 25, offset: 0 })).rejects.toMatchObject({ code: "invalid_input" });
    // @ts-expect-error Runtime boundary must reject client-supplied authority.
    await expect(c.create({ ...create, tenantId: id })).rejects.toMatchObject({
      code: "invalid_input",
    });
    const tlcs = Array.from({ length: 50 }, (_, i) => `${i}${"界".repeat(2000)}`);
    await expect(c.create({ ...create, scope: { tlcs } })).rejects.toMatchObject({
      code: "invalid_input",
    });
    expect(send).not.toHaveBeenCalled();
  });
  it.each(["actual overflow", "truncation"])(
    "JSON %s safely rejects and disposes its real public-client reader",
    async (failure) => {
      vi.useFakeTimers();
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(
            failure === "actual overflow"
              ? new Uint8Array(17 * 1024 * 1024 + 1)
              : new TextEncoder().encode("{}"),
          );
          if (failure === "truncation") controller.close();
        },
      });
      const cancel = vi.spyOn(ReadableStreamDefaultReader.prototype, "cancel");
      const release = vi.spyOn(ReadableStreamDefaultReader.prototype, "releaseLock");
      cancel.mockClear();
      release.mockClear();
      const response = new Response(stream, {
        headers: {
          "content-type": "application/json",
          ...(failure === "truncation" ? { "content-length": "3" } : {}),
        },
      });
      const outer = new AbortController();
      const add = vi.spyOn(outer.signal, "addEventListener");
      const remove = vi.spyOn(outer.signal, "removeEventListener");
      await expect(
        createUsBrowserClient(vi.fn<typeof fetch>().mockResolvedValue(response)).requests.list(
          undefined,
          outer.signal,
        ),
      ).rejects.toMatchObject({ code: "invalid_response", message: "invalid_response" });
      expect(cancel).toHaveBeenCalledOnce();
      expect(release).toHaveBeenCalledOnce();
      expect(stream.locked).toBe(false);
      expect(remove).toHaveBeenCalledWith("abort", add.mock.calls[0]?.[1]);
      expect(vi.getTimerCount()).toBe(0);
    },
  );
  for (const [label, response] of [
    ["malformed JSON", new Response("{", { headers: { "content-type": "application/json" } })],
    ["204", new Response(null, { status: 204 })],
    [
      "wrong MIME",
      new Response(JSON.stringify(page), { headers: { "content-type": "text/plain" } }),
    ],
    [
      "MIME parameters",
      new Response(JSON.stringify(page), {
        headers: { "content-type": "application/json; charset=latin1" },
      }),
    ],
    [
      "redirect",
      new Response(null, { status: 302, headers: { location: "https://example.test" } }),
    ],
    ["wrong success status", Response.json(page, { status: 201 })],
  ] as const)
    it(`rejects ${label}`, async () => {
      await expect(
        createUsBrowserClient(vi.fn<typeof fetch>().mockResolvedValue(response)).requests.list(),
      ).rejects.toMatchObject({ code: "invalid_response" });
    });
  it("does not accept create with 200", async () => {
    await expect(
      createUsBrowserClient(transport(receipt)).requests.create(create),
    ).rejects.toMatchObject({ code: "invalid_response" });
  });
  it("bounds error bodies and never exposes provider or arbitrary message text", async () => {
    for (const body of [
      { code: "unknown", message: ["private provider data"] },
      { code: "us_request_closed", message: "private" },
      "界".repeat(9000),
    ]) {
      const error = await createUsBrowserClient(transport(body, 409))
        .requests.get(id)
        .catch((e: unknown) => e);
      expect(error).toMatchObject({ code: "conflict" });
      expect(String(error)).not.toMatch(/private|provider|界/);
    }
  });
  it("keeps the 15-second deadline through body decoding and cleans cancellation listeners", async () => {
    vi.useFakeTimers();
    const outer = new AbortController();
    const add = vi.spyOn(outer.signal, "addEventListener");
    const remove = vi.spyOn(outer.signal, "removeEventListener");
    const send = vi.fn<typeof fetch>().mockImplementation(
      async (_url, init) =>
        new Response(
          new ReadableStream({
            start(controller) {
              init?.signal?.addEventListener("abort", () =>
                controller.error(new DOMException("aborted", "AbortError")),
              );
            },
          }),
          { headers: { "content-type": "application/json" } },
        ),
    );
    const pending = createUsBrowserClient(send).requests.list(undefined, outer.signal);
    const assertion = expect(pending).rejects.toMatchObject({ code: "unavailable" });
    await vi.advanceTimersByTimeAsync(14_999);
    expect(send.mock.calls[0]?.[1]?.signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await assertion;
    expect(remove.mock.calls[0]?.[1]).toBe(add.mock.calls[0]?.[1]);
    expect(vi.getTimerCount()).toBe(0);
  });
  for (const operation of ["list", "get"] as const) {
    it.each(["external abort", "deadline"])(
      `${operation}: never-settling cancellation cannot retain a rejected JSON reader after %s`,
      async (stop) => {
        vi.useFakeTimers();
        let cancelled = 0;
        const stream = new ReadableStream<Uint8Array>({
          cancel() {
            cancelled++;
            return new Promise<never>(() => {});
          },
        });
        const response = new Response(stream, {
          headers: {
            "content-type": "application/json",
            "content-length": operation === "list" ? "-1" : String(17 * 1024 * 1024 + 1),
          },
        });
        const outer = new AbortController();
        const remove = vi.spyOn(outer.signal, "removeEventListener");
        const client = createUsBrowserClient(vi.fn<typeof fetch>().mockResolvedValue(response));
        const outcomes: unknown[] = [];
        const pending =
          operation === "list"
            ? client.requests.list(undefined, outer.signal)
            : client.requests.get(id, outer.signal);
        void pending.then(
          (value) => outcomes.push({ state: "resolved", value }),
          (error: unknown) => outcomes.push({ state: "rejected", error }),
        );
        await vi.advanceTimersByTimeAsync(0);
        expect(cancelled).toBe(1);
        if (stop === "external abort") outer.abort(new Error("private abort reason"));
        else await vi.advanceTimersByTimeAsync(15_000);
        await vi.advanceTimersByTimeAsync(0);
        expect(outcomes).toEqual([
          {
            state: "rejected",
            error: expect.objectContaining({
              code: "invalid_response",
              message: "invalid_response",
            }),
          },
        ]);
        expect(outcomes[0]).not.toHaveProperty("error.cause");
        expect(stream.locked).toBe(false);
        expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
        expect(vi.getTimerCount()).toBe(0);
      },
    );
  }
  it("forwards cancellation including already-aborted signals and cleans after success/error", async () => {
    for (const preaborted of [false, true]) {
      const outer = new AbortController();
      if (preaborted) outer.abort();
      const remove = vi.spyOn(outer.signal, "removeEventListener");
      const send = vi.fn<typeof fetch>().mockImplementation(
        (_url, init) =>
          new Promise((_resolve, reject) => {
            if (init?.signal?.aborted) reject(new DOMException("aborted", "AbortError"));
            init?.signal?.addEventListener("abort", () =>
              reject(new DOMException("aborted", "AbortError")),
            );
          }),
      );
      const pending = createUsBrowserClient(send).requests.list(undefined, outer.signal);
      outer.abort();
      await expect(pending).rejects.toMatchObject({ code: "unavailable" });
      expect(send.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
      expect(remove).toHaveBeenCalledOnce();
    }
    for (const response of [page, { invalid: true }]) {
      const outer = new AbortController();
      const remove = vi.spyOn(outer.signal, "removeEventListener");
      await createUsBrowserClient(transport(response))
        .requests.list(undefined, outer.signal)
        .catch(() => undefined);
      expect(remove).toHaveBeenCalledOnce();
    }
  });
});
