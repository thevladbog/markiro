import assert from "node:assert/strict";
import test from "node:test";
import { verifyWorkingDeviceImplementation } from "../working-device-compatibility.mjs";

function implementation() {
  return {
    countWorkingDeviceUsage() {},
    transitionWorkingAssignment() {},
    assignmentConsistent(device, assignment) {
      return Boolean(assignment) && !(device.apiKeyId && assignment.state === "reserved");
    },
    assignmentOccupied(device, assignment) {
      if (!assignment) return device.revokedAt === null;
      if (assignment.state !== "released") return true;
      if (assignment.releaseReason === "reservation_cancelled") return device.apiKeyId !== null;
      return device.revokedAt === null;
    },
    assertReservationOpen(assignment) {
      if (assignment?.releaseReason === "reservation_cancelled") throw new Error("terminal");
    },
  };
}

test("requires executable assignment reader/writer and terminal cancellation behavior", () => {
  assert.equal(
    verifyWorkingDeviceImplementation(implementation()),
    "working-device-assignments-v1",
  );
});
test("rejects missing reader/writer and a legacy revoked-at reader", () => {
  assert.throws(() => verifyWorkingDeviceImplementation({}), /incompatible/);
  assert.throws(
    () =>
      verifyWorkingDeviceImplementation({
        ...implementation(),
        transitionWorkingAssignment: undefined,
      }),
    /incompatible/,
  );
  assert.throws(
    () =>
      verifyWorkingDeviceImplementation({
        ...implementation(),
        assignmentOccupied: (device) => device.revokedAt === null,
      }),
    /incompatible/,
  );
});
test("rejects fail-open missing assignments and resurrectable cancelled reservations", () => {
  assert.throws(
    () =>
      verifyWorkingDeviceImplementation({ ...implementation(), assignmentOccupied: () => false }),
    /incompatible/,
  );
  assert.throws(
    () => verifyWorkingDeviceImplementation({ ...implementation(), assertReservationOpen() {} }),
    /incompatible/,
  );
});
