import { webcrypto } from "node:crypto";
import { expect, it, vi } from "vitest";
import { writeConfig } from "../src/store/config.js";
import { enqueueOrder, dequeueOrder, listQueue } from "../src/store/queue.js";
import { beginGrantRequest } from "../src/grants/transport.js";
import { persistGrantReservation, readGrantReservation } from "../src/grants/reservations.js";
const body = {
  deviceSeq: 1,
  badgeDigest: "badge",
  reason: "buy" as const,
  items: [{ rawKm: "raw" }],
};
const result = {
  status: "reserved",
  protocol: "offline-grants-v1",
  admission: { claimedAt: "2026-09-13T00:00:00.000Z", admissionProof: "opaque-proof" },
  task: {
    taskKind: "pickup",
    taskId: "00000000-0000-4000-8000-000000000003",
    snapshotDigest: "a".repeat(64),
  },
};
async function setup() {
  vi.stubGlobal("crypto", webcrypto);
  await writeConfig({
    serverUrl: "https://fixture.invalid",
    kioskId: "kiosk",
    token: "test-only",
    kioskName: "Fixture",
    place: null,
    nextDeviceSeq: 2,
  });
  await enqueueOrder(body, "employee", "pending_attestation");
  const lease = await beginGrantRequest();
  if (!lease) throw Error("lease");
  return lease;
}
it("persists the authenticated reservation only for its unchanged queued order", async () => {
  const lease = await setup();
  expect(await persistGrantReservation(lease, body, result)).toBe(true);
  expect(await readGrantReservation(lease.owner, 1)).toMatchObject({
    taskId: result.task.taskId,
    snapshotDigest: result.task.snapshotDigest,
  });
  expect((await listQueue())[0]?.body).toEqual(body);
});
it("cannot resurrect or attach a late reservation after dequeue", async () => {
  const lease = await setup();
  await dequeueOrder(1);
  expect(await persistGrantReservation(lease, body, result)).toBe(false);
  expect(await readGrantReservation(lease.owner, 1)).toBeNull();
  expect(await listQueue()).toEqual([]);
});
