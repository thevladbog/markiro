import { describe, expect, it } from "vitest";
import * as contracts from "../src/index.js";

const key = "11111111-1111-4111-8111-111111111111";
const digest = "a".repeat(64);
const start = "2026-10-05T10:00:00.000Z";
const finish = "2026-10-05T10:01:00.000Z";
const summary = {
  id: key,
  requestNumber: "REQ-001",
  revision: 1,
  status: "open",
  receivedAt: start,
  dueAt: "2026-10-06T10:00:00.000Z",
  createdBy: "user-1",
  createdAt: start,
  updatedAt: start,
  closedAt: null,
  lastValidatedAt: null,
};
const run = {
  runId: key,
  requestId: key,
  requestRevision: 1,
  runRevision: 1,
  mode: "available_records_incomplete",
  status: "queued",
  exportReady: false,
  createdBy: "user-1",
  commandDigest: digest,
  scopedContentDigest: digest,
  inputDigest: null,
  lifecycleVersion: 0,
  retryCycle: 1,
  attemptCount: 0,
  cycleAttemptCount: 0,
  failureCode: null,
  startedAt: start,
  generationStartedAt: null,
  reportRenderedAt: null,
  completedAt: null,
  nextAttemptAt: null,
  provenance: "not_verified",
};
const attempt = {
  id: key,
  attemptNumber: 1,
  cycle: 1,
  status: "active",
  startedAt: start,
  finishedAt: null,
  reportRenderedAt: null,
  failureCode: null,
  retryable: false,
};
const detail = {
  ...summary,
  requesterName: "Synthetic requester",
  requesterOrganization: null,
  requesterContact: null,
  alternateDeadlineReason: null,
  scope: null,
  savedValidation: null,
  warningAcknowledgement: null,
  latestRun: null,
  availability: { build: "unknown", packageStorage: "unconfigured" },
};
const frozenRequest = {
  id: key,
  revision: 1,
  requestNumber: "REQ-001",
  requesterName: "Synthetic requester",
  requesterOrganization: null,
  requesterContact: null,
  receivedAt: start,
  dueAt: "2026-10-06T10:00:00.000Z",
  alternateDeadlineReason: null,
};
const runDetail = {
  ...run,
  request: frozenRequest,
  scope: { tlc: "LOT-001" },
  findings: [],
  latestAttempt: null,
  artifacts: [],
  missingFiles: null,
};

// Full valid selector lists with JSON-escaped Unicode support the later HTTP body-cap tests.
export const worstValidRequestBody = {
  requestNumber: "R".repeat(80),
  requesterName: "名".repeat(200),
  requesterOrganization: "組".repeat(200),
  requesterContact: "聯".repeat(500),
  receivedAt: start,
  scope: {
    productText: "果".repeat(200),
    documentNumber: "文".repeat(128),
    tlcs: Array.from(
      { length: 50 },
      (_, index) => `${index.toString().padStart(2, "0")}${"𐀀".repeat(118)}`,
    ),
    locationIds: Array.from(
      { length: 50 },
      (_, index) => `11111111-1111-4111-8111-${index.toString().padStart(12, "0")}`,
    ),
  },
};

describe("US Requests public HTTP contracts", () => {
  it("exports the public Prepare envelope independently of the legacy command", () => {
    expect(contracts).toHaveProperty("usRequestPrepareHttpBodySchema");
    const body = {
      mode: "available_records_incomplete",
      idempotencyKey: key,
      expectedRevision: 1,
      validationDigest: digest,
    };
    expect(contracts.usRequestPrepareHttpBodySchema.safeParse(body).success).toBe(true);
    expect(contracts.usTraceRequestPrepareBodySchema.safeParse(body).success).toBe(false);
    expect(
      contracts.usTraceRequestPrepareBodySchema.safeParse({ mode: body.mode, idempotencyKey: key })
        .success,
    ).toBe(true);
    expect(
      contracts.usRequestPrepareHttpBodySchema.safeParse({ ...body, tenantId: "foreign" }).success,
    ).toBe(false);
    for (const patch of [
      { expectedRevision: 0 },
      { validationDigest: "A".repeat(64) },
      { mode: "complete" },
      { idempotencyKey: "bad" },
    ])
      expect(
        contracts.usRequestPrepareHttpBodySchema.safeParse({ ...body, ...patch }).success,
      ).toBe(false);
  });
  it("accepts canonical bounded pagination and emits numeric defaults", () => {
    expect(contracts.usRequestListQuerySchema.parse({})).toEqual({ limit: 25, offset: 0 });
    expect(
      contracts.usRequestListQuerySchema.parse({
        requestNumber: "REQ-001",
        status: "closed",
        limit: "50",
        offset: "10000",
      }),
    ).toEqual({ requestNumber: "REQ-001", status: "closed", limit: 50, offset: 10000 });
    expect(contracts.usRequestHistoryQuerySchema.parse({ limit: "1", offset: "0" })).toEqual({
      limit: 1,
      offset: 0,
    });
  });
  it.each(["01", "1e1", "1.0", " 1", "1 ", "51", "0", "-1", "", "999999999999999999999999"])(
    "rejects noncanonical or out-of-bound limit %j",
    (limit) => {
      expect(contracts.usRequestListQuerySchema.safeParse({ limit }).success).toBe(false);
      expect(contracts.usRequestHistoryQuerySchema.safeParse({ limit }).success).toBe(false);
    },
  );
  it("rejects duplicate, numeric, unknown and history-only filter inputs", () => {
    for (const value of [
      { limit: ["1", "2"] },
      { limit: 1 },
      { offset: "01" },
      { offset: "10001" },
      { offset: "-1" },
      { status: "ready" },
      { requestNumber: " REQ" },
      { tenantId: key },
    ])
      expect(contracts.usRequestListQuerySchema.safeParse(value).success).toBe(false);
    expect(contracts.usRequestHistoryQuerySchema.safeParse({ status: "open" }).success).toBe(false);
  });
  it("requires explicit revision and canonical warning acknowledgement reason", () => {
    expect(contracts.usRequestValidateHttpBodySchema.parse({ expectedRevision: 1 })).toEqual({
      expectedRevision: 1,
    });
    for (const value of [{}, { expectedRevision: 0 }, { expectedRevision: 1, actorId: "foreign" }])
      expect(contracts.usRequestValidateHttpBodySchema.safeParse(value).success).toBe(false);
    const body = { expectedRevision: 1, digest, reason: "Reviewed warning" };
    expect(contracts.usRequestWarningAckHttpBodySchema.parse(body)).toEqual(body);
    for (const reason of [
      "ab",
      " abc",
      "abc ",
      "abc\n",
      "ab\u0000c",
      "\ud800abc",
      "x".repeat(2001),
    ])
      expect(
        contracts.usRequestWarningAckHttpBodySchema.safeParse({ ...body, reason }).success,
      ).toBe(false);
    expect(
      contracts.usRequestWarningAckHttpBodySchema.safeParse({ ...body, actorId: "foreign" })
        .success,
    ).toBe(false);
  });
  it("retains the existing worker retry parser's reason and UUID semantics", () => {
    const body = { expectedLifecycleVersion: 1, reason: "  retry\n", idempotencyKey: key };
    expect(contracts.usRequestRetryHttpBodySchema.parse(body)).toEqual(body);
    for (const patch of [
      { reason: "  a  " },
      { reason: "x".repeat(2001) },
      { expectedLifecycleVersion: 0 },
      { idempotencyKey: "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA" },
      { tenantId: key },
    ])
      expect(contracts.usRequestRetryHttpBodySchema.safeParse({ ...body, ...patch }).success).toBe(
        false,
      );
  });
  it("preserves maximum valid Unicode scope lists through escaped JSON", () => {
    const json = JSON.stringify(worstValidRequestBody).replace(
      /[\u0080-\uffff]/g,
      (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`,
    );
    expect(Buffer.byteLength(json)).toBeGreaterThan(16 * 1024);
    expect(Buffer.byteLength(json)).toBeLessThanOrEqual(256 * 1024);
    expect(contracts.usTraceRequestCreateBodySchema.parse(JSON.parse(json))).toEqual(
      worstValidRequestBody,
    );
  });
  it("excludes saved contacts, scope and private evidence from request summaries", () => {
    expect(contracts.usRequestSummarySchema.parse(summary)).toEqual(summary);
    for (const name of ["requesterContact", "scope", "inputSnapshot", "tenantId"])
      expect(
        contracts.usRequestSummarySchema.safeParse({ ...summary, [name]: "private" }).success,
      ).toBe(false);
    for (const patch of [
      { status: "ready" },
      { status: "closed" },
      { revision: 0 },
      { dueAt: start },
      { updatedAt: "not-an-instant" },
    ])
      expect(contracts.usRequestSummarySchema.safeParse({ ...summary, ...patch }).success).toBe(
        false,
      );
  });
  it("labels saved validation as not rechecked and enforces nullable evidence bindings", () => {
    expect(contracts.usRequestDetailResponseSchema.parse(detail)).toEqual(detail);
    const savedValidation = {
      digest,
      validatedAt: finish,
      matchedRevisionCount: 0,
      findings: [],
      freshness: "not_rechecked",
    };
    const validated = { ...detail, lastValidatedAt: finish, savedValidation };
    expect(contracts.usRequestDetailResponseSchema.safeParse(validated).success).toBe(true);
    for (const value of [
      { ...detail, savedValidation },
      { ...validated, savedValidation: { ...savedValidation, freshness: "current" } },
      { ...validated, savedValidation: { ...savedValidation, matchedRevisionCount: 501 } },
      { ...detail, availability: { build: "available", packageStorage: "healthy" } },
      { ...detail, checkpoint: {} },
    ])
      expect(contracts.usRequestDetailResponseSchema.safeParse(value).success).toBe(false);
  });
  it.each([
    { status: "open", closedAt: null },
    { status: "closed", closedAt: "2026-10-05T17:09:48.444Z" },
  ])(
    "preserves exact recorded request instants with measured -115ms clock skew in $status state",
    (state) => {
      const recorded = {
        ...summary,
        ...state,
        createdAt: "2026-10-05T17:09:48.559Z",
        updatedAt: "2026-10-05T17:09:48.444Z",
      };
      expect(contracts.usRequestSummarySchema.parse(recorded)).toEqual(recorded);
      expect(contracts.usRequestDetailResponseSchema.parse({ ...detail, ...recorded })).toEqual({
        ...detail,
        ...recorded,
      });
      expect(
        contracts.usRequestListResponseSchema.parse({
          items: [recorded],
          limit: 25,
          offset: 0,
          hasMore: false,
        }).items,
      ).toEqual([recorded]);
    },
  );
  it("binds warning metadata to the saved digest while preserving saved source findings", () => {
    const savedValidation = {
      digest,
      validatedAt: start,
      matchedRevisionCount: 1,
      findings: [
        {
          code: "review_required",
          severity: "warning",
          sourceRecord: "receiving",
          eventId: key,
          revision: 1,
          lineNo: 1,
          fieldKey: "tlc",
          message: "Review this saved record",
        },
      ],
      freshness: "not_rechecked",
    };
    const warningAcknowledgement = {
      digest,
      reason: "Reviewed warning",
      actorId: "user-1",
      acknowledgedAt: finish,
    };
    const saved = { ...detail, lastValidatedAt: start, savedValidation, warningAcknowledgement };
    expect(contracts.usRequestDetailResponseSchema.parse(saved)).toEqual(saved);
    for (const patch of [
      { digest: "b".repeat(64) },
      { actorId: "" },
      { acknowledgedAt: "2026-10-04T10:00:00.000Z" },
      { token: key },
    ])
      expect(
        contracts.usRequestDetailResponseSchema.safeParse({
          ...saved,
          warningAcknowledgement: { ...warningAcknowledgement, ...patch },
        }).success,
      ).toBe(false);
    expect(
      contracts.usRequestDetailResponseSchema.safeParse({
        ...saved,
        savedValidation: {
          ...savedValidation,
          findings: [{ ...savedValidation.findings[0], providerError: "private" }],
        },
      }).success,
    ).toBe(false);
  });
  it("bounds saved findings by the existing 16 MiB snapshot ceiling", () => {
    const validation = {
      httpRequestId: key,
      requestId: key,
      revision: 1,
      digest,
      byteSize: 100,
      matchedRevisionCount: 0,
      findings: [
        {
          code: "review",
          severity: "warning",
          sourceRecord: "request",
          message: "x".repeat(16 * 1024 * 1024),
        },
      ],
      validatedAt: finish,
    };
    expect(contracts.usRequestValidationHttpResponseSchema.safeParse(validation).success).toBe(
      false,
    );
  });
  it("keeps run lifecycle, mode, counts, failure and known timing consistent", () => {
    expect(contracts.usRequestRunSummarySchema.parse(run)).toEqual(run);
    const ready = { ...run, status: "ready", completedAt: finish };
    expect(contracts.usRequestRunSummarySchema.safeParse(ready).success).toBe(true);
    for (const patch of [
      { exportReady: true },
      { status: "failed", completedAt: finish },
      { failureCode: "provider stack" },
      { cycleAttemptCount: 1 },
      { cycleAttemptCount: 4, attemptCount: 4 },
      { completedAt: finish },
      { generationStartedAt: "2026-10-04T10:00:00.000Z" },
      { provenance: "production" },
      { leaseToken: key },
      { inputSnapshot: {} },
    ])
      expect(contracts.usRequestRunSummarySchema.safeParse({ ...run, ...patch }).success).toBe(
        false,
      );
    expect(
      contracts.usRequestRunSummarySchema.safeParse({
        ...ready,
        mode: "export_ready",
        exportReady: true,
      }).success,
    ).toBe(true);
  });
  it("rejects terminal retry scheduling and completion before known worker start", () => {
    const ready = { ...run, status: "ready", completedAt: finish };
    expect(
      contracts.usRequestRunSummarySchema.safeParse({ ...ready, nextAttemptAt: finish }).success,
    ).toBe(false);
    expect(
      contracts.usRequestRunSummarySchema.safeParse({
        ...ready,
        generationStartedAt: "2026-10-05T10:02:00.000Z",
      }).success,
    ).toBe(false);
  });
  it("bounds public run artifacts to fixed names, MIME types and per-kind byte caps", () => {
    expect(contracts.usRequestRunDetailSchema.parse(runDetail)).toEqual(runDetail);
    const artifactCases = [
      [
        "xlsx",
        "records.xlsx",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        16 * 1024 * 1024,
      ],
      ["plan_pdf", "plan.pdf", "application/pdf", 8_000_000],
      ["validation_report", "validation.json", "application/json", 16 * 1024 * 1024],
      ["request_report", "request-report.pdf", "application/pdf", 4 * 1024 * 1024],
      ["manifest", "manifest.json", "application/json", 1024 * 1024],
      ["package_zip", "package.zip", "application/zip", 64 * 1024 * 1024],
    ] as const;
    const ready = { ...runDetail, status: "ready", completedAt: finish, missingFiles: [] };
    for (const [kind, name, mediaType, byteSize] of artifactCases) {
      const descriptor = { kind, name, mediaType, byteSize, sha256: digest };
      expect(contracts.usRequestArtifactKindSchema.safeParse(kind).success).toBe(true);
      expect(
        contracts.usRequestRunDetailSchema.safeParse({ ...ready, artifacts: [descriptor] }).success,
      ).toBe(true);
      for (const patch of [
        { byteSize: byteSize + 1 },
        { byteSize: 0 },
        { name: "../private" },
        { mediaType: "text/plain" },
        { objectKey: "private" },
      ])
        expect(
          contracts.usRequestRunDetailSchema.safeParse({
            ...ready,
            artifacts: [{ ...descriptor, ...patch }],
          }).success,
        ).toBe(false);
      expect(
        contracts.usRequestRunDetailSchema.safeParse({
          ...ready,
          artifacts: [descriptor, descriptor],
        }).success,
      ).toBe(false);
    }
    expect(contracts.usRequestArtifactKindSchema.safeParse("SHA256SUMS").success).toBe(false);
    expect(
      contracts.usRequestRunDetailSchema.safeParse({
        ...ready,
        missingFiles: [{ name: "plan.pdf", code: "plan_absent" }],
      }).success,
    ).toBe(true);
    for (const patch of [
      { missingFiles: [{ name: "private", code: "provider stack" }] },
      { request: { ...frozenRequest, revision: 2 } },
      { checkpoint: {} },
      {
        findings: [
          {
            code: "warning",
            severity: "warning",
            sourceRecord: "request",
            message: "Review",
            tenantId: key,
          },
        ],
      },
    ])
      expect(contracts.usRequestRunDetailSchema.safeParse({ ...ready, ...patch }).success).toBe(
        false,
      );
  });
  it("publishes bounded token-free attempt summaries with recognized retry behavior", () => {
    const page = { items: [attempt], limit: 25, offset: 0, hasMore: false };
    expect(contracts.usRequestAttemptListResponseSchema.parse(page)).toEqual(page);
    const failed = {
      ...attempt,
      status: "failed",
      finishedAt: finish,
      failureCode: "us_request_package_storage_timeout",
      retryable: true,
    };
    expect(
      contracts.usRequestAttemptListResponseSchema.safeParse({ ...page, items: [failed] }).success,
    ).toBe(true);
    for (const patch of [
      { token: key },
      { status: "succeeded" },
      { finishedAt: finish },
      { retryable: true },
      { reportRenderedAt: "2026-10-04T10:00:00.000Z" },
      { failureCode: "provider stack" },
    ])
      expect(
        contracts.usRequestAttemptListResponseSchema.safeParse({
          ...page,
          items: [{ ...attempt, ...patch }],
        }).success,
      ).toBe(false);
    expect(
      contracts.usRequestAttemptListResponseSchema.safeParse({
        ...page,
        items: [{ ...failed, retryable: false }],
      }).success,
    ).toBe(false);
    for (const code of ["us_request_worker_lease_lost", "us_request_worker_deadline_exceeded"])
      expect(
        contracts.usRequestAttemptListResponseSchema.safeParse({
          ...page,
          items: [{ ...failed, status: "abandoned", failureCode: code }],
        }).success,
      ).toBe(true);
    expect(
      contracts.usRequestAttemptListResponseSchema.safeParse({
        ...page,
        items: [{ ...failed, status: "abandoned" }],
      }).success,
    ).toBe(false);
  });
  it("rejects over-limit lists, numeric-query representations and private response extras", () => {
    for (const [schema, item] of [
      [contracts.usRequestListResponseSchema, summary],
      [contracts.usRequestRunListResponseSchema, run],
      [contracts.usRequestAttemptListResponseSchema, attempt],
    ] as const) {
      expect(
        schema.safeParse({ items: [item], limit: 1, offset: 10000, hasMore: false }).success,
      ).toBe(true);
      for (const patch of [
        { items: Array(51).fill(item) },
        { items: [item, item], limit: 1 },
        { limit: "25" },
        { offset: 10001 },
        { tenantId: key },
      ])
        expect(
          schema.safeParse({ items: [], limit: 25, offset: 0, hasMore: false, ...patch }).success,
        ).toBe(false);
      const items = Array.from({ length: 50 }, () => item);
      expect(schema.safeParse({ items, limit: 50, offset: 0, hasMore: true }).success).toBe(true);
    }
  });
  it("acknowledges commands and receipts without inventing replay or live-state authority", () => {
    const command = { httpRequestId: key, requestId: key, revision: 1, status: "open" };
    const validation = {
      httpRequestId: key,
      requestId: key,
      revision: 1,
      digest,
      byteSize: 16 * 1024 * 1024,
      matchedRevisionCount: 500,
      findings: [],
      validatedAt: finish,
    };
    const prepare = {
      httpRequestId: key,
      requestId: key,
      requestRevision: 1,
      runId: key,
      runRevision: 1,
      mode: "available_records_incomplete",
      idempotencyKey: key,
      scopedContentDigest: digest,
    };
    const retry = {
      httpRequestId: key,
      runId: key,
      cycle: 2,
      lifecycleVersion: 1,
      requestedBy: "user-1",
      idempotencyKey: key,
    };
    for (const [schema, value] of [
      [contracts.usRequestCommandResponseSchema, command],
      [contracts.usRequestValidationHttpResponseSchema, validation],
      [contracts.usRequestPrepareResponseSchema, prepare],
      [contracts.usRequestRetryResponseSchema, retry],
    ] as const) {
      expect(schema.safeParse(value).success).toBe(true);
      for (const name of ["tenantId", "replay", "leaseToken", "objectKey", "requesterContact"])
        expect(schema.safeParse({ ...value, [name]: "private" }).success).toBe(false);
    }
    expect(
      contracts.usRequestPrepareResponseSchema.safeParse({ ...prepare, status: "queued" }).success,
    ).toBe(false);
    expect(
      contracts.usRequestValidationHttpResponseSchema.safeParse({
        ...validation,
        byteSize: 16 * 1024 * 1024 + 1,
      }).success,
    ).toBe(false);
    expect(contracts.usRequestRetryResponseSchema.safeParse({ ...retry, cycle: 1 }).success).toBe(
      false,
    );
  });
});
