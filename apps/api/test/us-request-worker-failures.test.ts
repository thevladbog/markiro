import { ServiceUnavailableException } from "@nestjs/common";
import { describe, expect, it } from "vitest";
import { classifyUsWorkerFailure } from "../src/modules/traceability/requests/us-request-worker-failures";
import {
  parseUsWorkerFailure,
  parseUsWorkerRetryBody,
  parseUsWorkerRetryReceipt,
  US_REQUEST_WORKER_FAILURE_CODES,
} from "../src/modules/traceability/requests/us-request-worker-types";

describe("finite private worker failures", () => {
  it("does not coerce an executable unknown database code", () => {
    let coerced = false;
    const code = {
      toString() {
        coerced = true;
        return "08006";
      },
    };
    expect(classifyUsWorkerFailure({ cause: { code } })).toEqual({
      code: "us_request_worker_unknown_failure",
      retryable: false,
    });
    expect(coerced).toBe(false);
  });
  it("classifies a wrapped known SQL serialization failure without exposing its cause", () => {
    expect(
      classifyUsWorkerFailure(
        new Error("private query", { cause: { code: "40001", detail: "private SQL" } }),
      ),
    ).toEqual({ code: "us_request_worker_database_retryable", retryable: true });
  });
  // Break caught: a positively classified DB failure is treated as permanent.
  it.each(["40001", "40P01"])("retries known SQL code %s without its private details", (code) => {
    expect(
      classifyUsWorkerFailure({ code, message: "private SQL", detail: "private input" }),
    ).toEqual({
      code: "us_request_worker_database_retryable",
      retryable: true,
    });
  });
  it.each(["08001", "08003", "08006", "57P01", "57P02", "57P03"])(
    "classifies DB unavailability %s",
    (code) => {
      expect(classifyUsWorkerFailure({ code })).toEqual({
        code: "us_request_worker_database_unavailable",
        retryable: true,
      });
    },
  );
  it.each(["us_request_package_storage_transport_failed", "us_request_package_storage_timeout"])(
    "retries bounded storage failure %s",
    (code) => {
      expect(
        classifyUsWorkerFailure(
          new ServiceUnavailableException({ code, cause: "private provider" }),
        ),
      ).toEqual({ code, retryable: true });
    },
  );
  // Break caught: nested Plan transport cause overrides the permanent boundary.
  it("keeps opaque Plan failures permanent without reading the hidden cause", () => {
    const error = new ServiceUnavailableException({ code: "us_request_plan_read_failed" });
    Object.defineProperty(error, "cause", {
      get() {
        throw new Error("cause read");
      },
    });
    expect(classifyUsWorkerFailure(error)).toEqual({
      code: "us_request_plan_read_failed",
      retryable: false,
    });
  });
  it.each([
    "us_request_payload_evidence_mismatch",
    "us_request_payload_render_failed",
    "us_request_package_refreeze_required",
    "us_request_package_storage_checksum_mismatch",
    "us_request_report_render_failed",
    "insufficient_permission",
  ])("preserves permanent code %s", (code) => {
    expect(
      classifyUsWorkerFailure(new ServiceUnavailableException({ code, message: "private" })),
    ).toEqual({ code, retryable: false });
  });
  it.each([
    new Error("private"),
    { code: "ECONNRESET" },
    { code: "23505" },
    { code: "future_failure" },
    null,
  ])("never defaults arbitrary errors to transient", (error) => {
    expect(classifyUsWorkerFailure(error)).toEqual({
      code: "us_request_worker_unknown_failure",
      retryable: false,
    });
  });
  it.each(US_REQUEST_WORKER_FAILURE_CODES)("keeps every finite boundary sanitized: %s", (code) => {
    const result = classifyUsWorkerFailure(
      new ServiceUnavailableException({ code, message: "private details" }),
    );
    expect(result.code).toBe(code);
    expect(Object.keys(result).sort()).toEqual(["code", "retryable"]);
    expect(parseUsWorkerFailure(result)).toEqual(result);
  });
  it.each([
    { code: "insufficient_permission", retryable: true },
    { code: "us_request_package_storage_timeout", retryable: false },
    { code: "future_failure", retryable: true },
    { code: "us_request_package_storage_timeout", retryable: true, message: "private" },
  ])("refuses invalid persisted failure authority", (value) => {
    expect(() => parseUsWorkerFailure(value)).toThrow();
  });
  it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])(
    "rejects invalid expected retry version %s",
    (expectedLifecycleVersion) => {
      expect(() =>
        parseUsWorkerRetryBody({
          expectedLifecycleVersion,
          reason: "Valid synthetic reason",
          idempotencyKey: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        }),
      ).toThrow();
    },
  );
  it.each(["", "ab", "   ", "x".repeat(2001)])(
    "rejects absent or unbounded manual reason",
    (reason) => {
      expect(() =>
        parseUsWorkerRetryBody({
          expectedLifecycleVersion: 1,
          reason,
          idempotencyKey: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        }),
      ).toThrow();
    },
  );
  it("rejects extra retry properties, bad UUIDs and malformed receipts", () => {
    const body = {
      expectedLifecycleVersion: 1,
      reason: "Synthetic retry",
      idempotencyKey: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    };
    expect(() => parseUsWorkerRetryBody({ ...body, extra: true })).toThrow();
    expect(() => parseUsWorkerRetryBody({ ...body, idempotencyKey: "not-uuid" })).toThrow();
    expect(() =>
      parseUsWorkerRetryReceipt({
        tenantId: body.idempotencyKey,
        runId: body.idempotencyKey,
        cycle: 1,
        lifecycleVersion: 2,
        requestedBy: "actor",
        idempotencyKey: body.idempotencyKey,
      }),
    ).toThrow();
  });
});
