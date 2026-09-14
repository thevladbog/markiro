import { describe, expect, it } from "vitest";
import fixtures from "../../platform-contracts/fixtures/offline-grants-v1.json" with { type: "json" };
import {
  deviceGrantSchema,
  grantCapabilitySchema,
  grantEventTypeSchema,
  grantOwnerSchema,
  taskGrantSchema,
} from "../src/offline-grants/contracts.js";
import {
  assessCompletion,
  assessNewWork,
  type GrantIntent,
} from "../src/offline-grants/decision.js";
import { verifyGrant } from "../src/offline-grants/jws.js";
const deviceProducer = fixtures.producers.find((producer) => producer.id === "device");
const taskProducer = fixtures.producers.find((producer) => producer.id === "task");
if (!deviceProducer || !taskProducer) throw new Error("Missing grant fixtures");
const device = deviceGrantSchema.parse(JSON.parse(deviceProducer.payloadJson));
const task = taskGrantSchema.parse(JSON.parse(taskProducer.payloadJson));
const intent: GrantIntent = {
  owner: grantOwnerSchema.parse({
    tenantId: task.tenantId,
    deviceId: task.deviceId,
    kind: task.kind,
    credentialEpoch: task.credentialEpoch,
  }),
  capability: "shift.start.v1",
  taskId: task.taskId,
  snapshotDigest: task.snapshotDigest,
  eventId: "event-1",
  eventType: "shift.scan.v1",
  cost: { units: 1 },
};
const reasons: Record<string, string> = {
  owner_mismatch: "wrong_owner",
  snapshot_mismatch: "wrong_task",
  task_mismatch: "wrong_task",
  budget_unknown: "budget_exhausted",
  event_not_allowed: "event_forbidden",
  capability_not_allowed: "event_forbidden",
};
describe("offline grant pure decisions", () => {
  it.each(
    fixtures.vectors.filter(
      (v) =>
        v.expected.cryptographic === "valid" &&
        !["unsupported_algorithm", "unknown_key", "invalid_header", "issuer_mismatch"].includes(
          v.expected.admission,
        ),
    ),
  )("admission: $id", async (vector) => {
    const context = vector.input.context;
    const verified = await verifyGrant(
      vector.input.compact,
      [{ ...fixtures.publicKey, origin: device.issuer }],
      context.issuer,
    );
    if (!verified.ok) throw new Error("Fixture must pass verification before admission");
    const request = {
      ...intent,
      owner: grantOwnerSchema.parse(context.owner),
      capability: grantCapabilitySchema.parse(
        "capability" in context ? context.capability : `${context.taskKind}.start.v1`,
      ),
    };
    const decision =
      verified.grant.kindOfGrant === "device"
        ? assessNewWork(verified.grant, request, context.now)
        : assessCompletion(
            verified.grant,
            {
              ...request,
              taskId: "taskId" in context ? context.taskId : "",
              snapshotDigest: "snapshotDigest" in context ? context.snapshotDigest : "",
              eventType: grantEventTypeSchema.parse(
                "eventType" in context ? context.eventType : "shift.scan.v1",
              ),
              cost: Object.fromEntries(
                ("consumption" in context ? context.consumption : []).map((c) => [
                  c.id,
                  c.requested,
                ]),
              ),
            },
            context.now,
            Object.fromEntries(
              ("consumption" in context ? context.consumption : []).map((c) => [c.id, c.used]),
            ),
          );
    expect(decision).toEqual(
      vector.expected.admission === "allow"
        ? { allow: true }
        : { allow: false, reason: reasons[vector.expected.admission] ?? vector.expected.admission },
    );
  });
  it("denies exactly at completeNotAfter", () =>
    expect(assessCompletion(task, intent, task.completeNotAfter, {})).toEqual({
      allow: false,
      reason: "expired",
    }));
  it.each([null, NaN, Infinity, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])(
    "denies unsafe time %s",
    (now) => {
      expect(assessNewWork(device, intent, now)).toEqual({
        allow: false,
        reason: "clock_untrusted",
      });
      expect(assessCompletion(task, intent, now, {})).toEqual({
        allow: false,
        reason: "clock_untrusted",
      });
    },
  );
  it("denies missing grants", () => {
    expect(assessNewWork(null, intent, task.notBefore)).toEqual({
      allow: false,
      reason: "missing_grant",
    });
    expect(assessCompletion(null, intent, task.notBefore, {})).toEqual({
      allow: false,
      reason: "missing_grant",
    });
  });
  it.each([-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])(
    "denies invalid costs and counters %s",
    (value) => {
      expect(
        assessCompletion(task, { ...intent, cost: { units: value } }, task.notBefore, {}),
      ).toEqual({ allow: false, reason: "budget_exhausted" });
      expect(assessCompletion(task, intent, task.notBefore, { boxes: value })).toEqual({
        allow: false,
        reason: "budget_exhausted",
      });
    },
  );
  it("checks all requested dimensions and unknown counters", () => {
    const cases: [Record<string, number>, Record<string, number>][] = [
      [{ units: 1, boxes: 1 }, { boxes: 1 }],
      [{ units: 1 }, { unknown: 0 }],
    ];
    for (const [cost, consumed] of cases) {
      expect(assessCompletion(task, { ...intent, cost }, task.notBefore, consumed)).toEqual({
        allow: false,
        reason: "budget_exhausted",
      });
    }
  });
  it("cannot reset persisted allowance by renewing grant ID", () =>
    expect(
      assessCompletion({ ...task, grantId: "renewal" }, intent, task.notBefore, { units: 2 }),
    ).toEqual({ allow: false, reason: "budget_exhausted" }));
  it("uses subtraction without overflow at safe-integer limit", () => {
    const large = {
      ...task,
      budget: [{ id: "units", unit: "unit" as const, maximum: Number.MAX_SAFE_INTEGER }],
    };
    expect(
      assessCompletion(large, intent, task.notBefore, { units: Number.MAX_SAFE_INTEGER - 1 }),
    ).toEqual({ allow: true });
    expect(
      assessCompletion(large, { ...intent, cost: { units: 2 } }, task.notBefore, {
        units: Number.MAX_SAFE_INTEGER - 1,
      }),
    ).toEqual({ allow: false, reason: "budget_exhausted" });
  });
});
