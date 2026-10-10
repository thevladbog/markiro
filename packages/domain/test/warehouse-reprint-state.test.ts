import { describe, expect, it } from "vitest";
import {
  applyWarehouseReprintEvent,
  warehousePreparedEvent,
  type WarehouseReprintEvent,
} from "../src/index.js";

const eventId = "00000000-0000-4000-8000-000000000090";
const attemptId = "00000000-0000-4000-8000-000000000091";
const now = "2026-10-09T12:30:00.000Z";

describe("warehouse reprint state", () => {
  it("requires durable sending before accepting a transport result", () => {
    const first = warehousePreparedEvent();
    const prepared = applyWarehouseReprintEvent(null, first);
    const base = {
      eventId,
      jobId: first.jobId,
      sessionId: first.sessionId,
      attemptId: first.attemptId,
      operatorId: first.operatorId,
      sequence: 2,
      occurredAt: now,
    };
    expect(() => applyWarehouseReprintEvent(prepared, { ...base, kind: "sent" })).toThrow();
    const sending = applyWarehouseReprintEvent(prepared, { ...base, kind: "sending" });
    const sent = applyWarehouseReprintEvent(sending, { ...base, sequence: 3, kind: "sent" });
    expect(sent).toMatchObject({ state: "sent", latestSequence: 3, attemptNo: 1 });
  });
  it("keeps bytes and source frozen on explicit recovery", () => {
    const first = warehousePreparedEvent();
    let state = applyWarehouseReprintEvent(null, first);
    const base = {
      eventId,
      jobId: first.jobId,
      sessionId: first.sessionId,
      attemptId: first.attemptId,
      operatorId: first.operatorId,
      sequence: 2,
      occurredAt: now,
    };
    state = applyWarehouseReprintEvent(state, { ...base, kind: "sending" });
    state = applyWarehouseReprintEvent(state, {
      ...base,
      sequence: 3,
      kind: "delivery_unknown",
      errorCode: "transport_failed",
    });
    const retry: WarehouseReprintEvent = {
      ...base,
      sequence: 4,
      attemptId,
      kind: "reprint_prepared",
      reason: "not_printed",
      attemptNo: 2,
    };
    expect(applyWarehouseReprintEvent(state, retry)).toMatchObject({
      state: "prepared",
      bytesDigest: first.bytesDigest,
      attemptNo: 2,
    });
    expect(() =>
      applyWarehouseReprintEvent(state, { ...retry, attemptId: first.attemptId }),
    ).toThrow();
  });
  it("rejects sequence gaps, another job and verification before transmission", () => {
    const first = warehousePreparedEvent();
    const state = applyWarehouseReprintEvent(null, first);
    const base = {
      eventId,
      jobId: first.jobId,
      sessionId: first.sessionId,
      attemptId: first.attemptId,
      operatorId: first.operatorId,
      sequence: 2,
      occurredAt: now,
    };
    expect(() =>
      applyWarehouseReprintEvent(state, { ...base, sequence: 3, kind: "sending" }),
    ).toThrow();
    expect(() =>
      applyWarehouseReprintEvent(state, { ...base, jobId: eventId, kind: "sending" }),
    ).toThrow();
    expect(() => applyWarehouseReprintEvent(state, { ...base, kind: "verified" })).toThrow();
  });
  it("allows a sending claim to be retired only when hardware was never invoked", () => {
    const first = warehousePreparedEvent();
    const prepared = applyWarehouseReprintEvent(null, first);
    const base = {
      eventId,
      jobId: first.jobId,
      sessionId: first.sessionId,
      attemptId: first.attemptId,
      operatorId: first.operatorId,
      sequence: 2,
      occurredAt: now,
    };
    const sending = applyWarehouseReprintEvent(prepared, { ...base, kind: "sending" });
    expect(
      applyWarehouseReprintEvent(sending, {
        ...base,
        sequence: 3,
        kind: "failed_before_send",
        errorCode: "owner_changed",
      }),
    ).toMatchObject({ state: "failed_before_send", latestSequence: 3 });
    for (const errorCode of ["printer_changed", "printer_unconfigured"] as const)
      expect(() =>
        applyWarehouseReprintEvent(sending, {
          ...base,
          sequence: 3,
          kind: "failed_before_send",
          errorCode,
        }),
      ).toThrow("Invalid warehouse print transition");
  });
});
