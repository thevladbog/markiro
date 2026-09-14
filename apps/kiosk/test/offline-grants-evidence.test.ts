import { webcrypto } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import { writeConfig } from "../src/store/config.js";
import { withStore, STORE_GRANTS, STORE_QUEUE } from "../src/store/db.js";
import { enqueueOrder, listQueue, listQuarantine } from "../src/store/queue.js";
import { createKioskClient } from "../src/api/client.js";
import { emptyState, stateKey } from "../src/grants/store.js";
import { flushQueue, cancelFlushRetry } from "../src/sync/worker.js";
import { readJournal } from "../src/store/journal.js";
import { productLabelValueDigest } from "@markiro/domain";
const taskGrantId = "33333333-3333-4333-8333-333333333333",
  receiptId = "44444444-4444-4444-8444-444444444444";
afterEach(() => {
  cancelFlushRetry();
  vi.unstubAllGlobals();
});
async function fixture() {
  vi.stubGlobal("crypto", webcrypto);
  const cfg = await writeConfig({
    serverUrl: "https://fixture.invalid",
    token: "test-only",
    kioskId: "11111111-1111-4111-8111-111111111111",
    kioskName: "Kiosk",
    place: null,
    nextDeviceSeq: 2,
  });
  const client = createKioskClient({ ...cfg, token: "test-only" }),
    owner = client.registryOwner;
  if (!owner) throw Error("owner");
  const body = {
    deviceSeq: 1,
    badgeDigest: "digest",
    reason: "buy" as const,
    items: [{ rawKm: "010460068200001321KYC9X7MQ\u001d93Abcd" }],
    createdAt: "2026-09-13T00:00:00.000Z",
    admissionProof: "saved-opaque-proof",
  };
  await enqueueOrder(body, "22222222-2222-4222-8222-222222222222");
  const [queued] = await listQueue();
  if (!queued) throw Error("queue");
  await withStore(STORE_QUEUE, "readwrite", (s) =>
    s.put({
      ...queued,
      grantEvidence: {
        taskGrantId,
        eventId: "pickup:1",
        credentialEpoch: 7,
        mode: "strict",
        cost: {
          "pickup.complete.v1:events": 1,
          "pickup.complete.v1:units": 1,
          "pickup.complete.v1:containers": 0,
        },
      },
    }),
  );
  await withStore(STORE_GRANTS, "readwrite", (s) => {
    s.put({ ...emptyState(owner), tenantId: "tenant", epoch: 8 }, stateKey(owner));
    return s.put(
      {
        compact: "original.signed.bytes",
        grant: {
          grantId: taskGrantId,
          tenantId: "tenant",
          deviceId: cfg.kioskId,
          credentialEpoch: 7,
        },
      },
      JSON.stringify(["grant", cfg.serverUrl, "tenant", cfg.kioskId, taskGrantId]),
    );
  });
  client.submitOrder = vi.fn(async () => ({
    orderNo: "LEGACY",
    status: "pending" as const,
    itemCount: 1,
    conflicts: [],
  }));
  return { client, owner, body };
}
const native = { orderNo: "ORDER-1", status: "pending", itemCount: 1, conflicts: [] };
const receipt = (batchId: string, status = "applied", outcome = "accepted") => ({
  protocol: "offline-grants-v1",
  batchId,
  outcome,
  reason: status === "applied" ? null : "budget_exhausted",
  receiptId,
  reconciliation: {
    status,
    statusCode: status === "applied" ? 201 : null,
    result: status === "applied" ? native : null,
  },
});
it("persists the exact original envelope before upload and retries unknown outcome unchanged", async () => {
  const f = await fixture(),
    seen: unknown[] = [];
  f.client.submitGrantEvidence = vi.fn(async (envelope) => {
    seen.push(structuredClone(envelope));
    const queued = await listQueue();
    expect(queued[0]?.evidenceEnvelope).toEqual(envelope);
    if (seen.length === 1) throw new TypeError("offline");
    return receipt(envelope.batchId, "applied", "duplicate");
  });
  await flushQueue(f.client, () => new Date("2026-09-13T01:00:00Z"));
  expect(await listQueue()).toHaveLength(1);
  await flushQueue(f.client, () => new Date("2026-09-13T01:00:01Z"));
  expect(seen[1]).toEqual(seen[0]);
  expect(seen[0]).toMatchObject({
    payload: f.body,
    payloadDigest: productLabelValueDigest(f.body),
    grants: ["original.signed.bytes"],
    eventGrants: { "/#pickup.complete.v1": taskGrantId },
  });
  expect(f.client.submitOrder).not.toHaveBeenCalled();
  expect(await listQueue()).toEqual([]);
  expect(await readJournal(100)).toMatchObject([{ orderNo: "ORDER-1", acceptedCount: 1 }]);
});
it.each(["accepted", "duplicate", "quarantined"])(
  "never ACKs %s evidence with not_applied production",
  async (outcome) => {
    const f = await fixture();
    f.client.submitGrantEvidence = vi.fn(async (envelope) =>
      receipt(envelope.batchId, "not_applied", outcome),
    );
    await flushQueue(f.client, () => new Date("2026-09-13T01:00:00Z"));
    expect(f.client.submitOrder).not.toHaveBeenCalled();
    expect(await listQueue()).toEqual([]);
    expect(await listQuarantine()).toMatchObject([
      { body: f.body, grantReceipt: { outcome, reconciliation: { status: "not_applied" } } },
    ]);
    expect(await readJournal(100)).toMatchObject([{ acceptedCount: 0, orderNo: "" }]);
  },
);
it("retains the queue on malformed evidence response without legacy fallback", async () => {
  const f = await fixture();
  f.client.submitGrantEvidence = vi.fn(async () => native);
  await flushQueue(f.client, () => new Date());
  expect(await listQueue()).toHaveLength(1);
  expect(f.client.submitOrder).not.toHaveBeenCalled();
  expect(await readJournal(100)).toEqual([]);
});
it("uses the frozen evidence HTTP route and current device credential", async () => {
  const f = await fixture();
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    expect(String(input)).toBe("https://fixture.invalid/kiosk/grants/v1/evidence/orders");
    expect(init?.method).toBe("POST");
    expect(init?.headers).toMatchObject({ "x-kiosk-token": "test-only" });
    const envelope = JSON.parse(String(init?.body));
    expect(envelope.payload).toEqual(f.body);
    return new Response(JSON.stringify(receipt(envelope.batchId)), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  });
  vi.stubGlobal("fetch", fetch);
  await flushQueue(f.client, () => new Date("2026-09-13T01:00:00Z"));
  expect(fetch).toHaveBeenCalledOnce();
  expect(await listQueue()).toEqual([]);
});
it.each(["rejected", "not_applied"])(
  "keeps %s native reconciliation in durable quarantine without positive callback",
  async (status) => {
    const f = await fixture(),
      ack = vi.fn();
    f.client.orderReconciled = ack;
    f.client.submitGrantEvidence = vi.fn(async (envelope) => receipt(envelope.batchId, status));
    await flushQueue(f.client, () => new Date("2026-09-13T01:00:00Z"));
    expect(ack).not.toHaveBeenCalled();
    expect(await listQuarantine()).toHaveLength(1);
  },
);
it("retains the exact queue on endpoint error and never calls the legacy route", async () => {
  const { KioskApiError } = await import("../src/api/client.js");
  const f = await fixture();
  f.client.submitGrantEvidence = vi.fn(async () => {
    throw new KioskApiError(404, "missing endpoint");
  });
  await flushQueue(f.client, () => new Date());
  expect(await listQueue()).toHaveLength(1);
  expect(await listQuarantine()).toEqual([]);
  expect(f.client.submitOrder).not.toHaveBeenCalled();
});
it.each(["wrong-batch", "invalid-native"])("does not acknowledge %s response", async (variant) => {
  const f = await fixture();
  f.client.submitGrantEvidence = vi.fn(async (envelope) =>
    variant === "wrong-batch"
      ? receipt("another-batch")
      : {
          ...receipt(envelope.batchId),
          reconciliation: {
            status: "applied",
            statusCode: 200,
            result: { ...native, itemCount: -1 },
          },
        },
  );
  await flushQueue(f.client, () => new Date());
  expect(await listQueue()).toHaveLength(1);
  expect(await readJournal(100)).toEqual([]);
});
it("rolls receipt and journal back together on acknowledgement failure then retries identical bytes", async () => {
  const f = await fixture(),
    seen: unknown[] = [];
  f.client.submitGrantEvidence = vi.fn(async (envelope) => {
    seen.push(structuredClone(envelope));
    return receipt(envelope.batchId);
  });
  const original = IDBObjectStore.prototype.add;
  const spy = vi.spyOn(IDBObjectStore.prototype, "add").mockImplementation(function (
    this: IDBObjectStore,
    value: unknown,
    key?: IDBValidKey,
  ) {
    if (this.name === "journal") throw Error("fixture acknowledgement failure");
    return original.call(this, value, key);
  });
  try {
    await flushQueue(f.client, () => new Date("2026-09-13T01:00:00Z"));
  } finally {
    spy.mockRestore();
  }
  expect(await listQueue()).toHaveLength(1);
  expect(await readJournal(100)).toEqual([]);
  await flushQueue(f.client, () => new Date("2026-09-13T01:00:01Z"));
  expect(seen[0]).toEqual(seen[1]);
  expect(await listQueue()).toEqual([]);
  expect(await readJournal(100)).toHaveLength(1);
});
it("does not resurrect a dequeued order or overwrite a re-paired same-sequence order after a late response", async () => {
  const f = await fixture();
  const { dequeueOrder } = await import("../src/store/queue.js");
  f.client.submitGrantEvidence = vi.fn(async (envelope) => {
    await dequeueOrder(1);
    await writeConfig({
      serverUrl: "https://fixture.invalid",
      token: "replacement-test",
      kioskId: f.owner.binding.kioskId,
      kioskName: "Replacement",
      place: null,
      nextDeviceSeq: 2,
    });
    await enqueueOrder(
      { ...f.body, items: [{ rawKm: "new owner's untouched bytes" }] },
      "22222222-2222-4222-8222-222222222222",
    );
    return receipt(envelope.batchId);
  });
  await flushQueue(f.client, () => new Date("2026-09-13T01:00:00Z"));
  expect(await listQueue()).toMatchObject([
    { body: { items: [{ rawKm: "new owner's untouched bytes" }] } },
  ]);
  expect(await readJournal(100)).toEqual([]);
  expect(await listQuarantine()).toEqual([]);
});
it("leaves legacy accepted orders on the existing native ingestion path", async () => {
  const f = await fixture();
  const [queued] = await listQueue();
  if (!queued) throw Error("queue");
  delete queued.grantEvidence;
  await withStore(STORE_QUEUE, "readwrite", (s) => s.put(queued));
  f.client.submitGrantEvidence = vi.fn();
  await flushQueue(f.client, () => new Date("2026-09-13T01:00:00Z"));
  expect(f.client.submitOrder).toHaveBeenCalledOnce();
  expect(f.client.submitGrantEvidence).not.toHaveBeenCalled();
  expect(await listQueue()).toEqual([]);
});
it("serializes two independent evidence drains to one durable acknowledgement", async () => {
  const f = await fixture(),
    [order] = await listQueue();
  if (!order) throw Error("order");
  const { reconcileEvidenceOrder } = await import("../src/grants/evidence.js");
  const seen: unknown[] = [];
  f.client.submitGrantEvidence = vi.fn(async (envelope) => {
    seen.push(structuredClone(envelope));
    return receipt(envelope.batchId);
  });
  await Promise.all([
    reconcileEvidenceOrder(f.client, order, () => new Date("2026-09-13T01:00:00Z")),
    reconcileEvidenceOrder(f.client, order, () => new Date("2026-09-13T01:00:00Z")),
  ]);
  expect(seen).toHaveLength(2);
  expect(seen[0]).toEqual(seen[1]);
  expect(await readJournal(100)).toHaveLength(1);
  expect(await listQueue()).toEqual([]);
  const archive = await withStore<unknown[]>(STORE_GRANTS, "readonly", (s) => s.getAll());
  expect(archive).toContainEqual(
    expect.objectContaining({
      envelope: seen[0],
      receipt: expect.objectContaining({
        receiptId,
        reconciliation: { status: "applied", statusCode: 201, result: native },
      }),
    }),
  );
});
it("a late evidence response cannot reinsert a dequeued record in the same generation", async () => {
  const f = await fixture(),
    { dequeueOrder } = await import("../src/store/queue.js");
  f.client.submitGrantEvidence = vi.fn(async (envelope) => {
    await dequeueOrder(1);
    return receipt(envelope.batchId);
  });
  await flushQueue(f.client, () => new Date("2026-09-13T01:00:00Z"));
  expect(await listQueue()).toEqual([]);
  expect(await listQuarantine()).toEqual([]);
  expect(await readJournal(100)).toEqual([]);
});
it("wraps new authenticated observe/no-policy work after legacy attestation and retains would-deny diagnostics", async () => {
  const f = await fixture(),
    { dequeueOrder } = await import("../src/store/queue.js");
  await dequeueOrder(1);
  const { beginGrantRequest, installGrantConfiguration } =
    await import("../src/grants/transport.js");
  const lease = await beginGrantRequest();
  if (!lease) throw Error("lease");
  await installGrantConfiguration(lease, {
    protocol: "offline-grants-v1",
    owner: {
      tenantId: "tenant",
      deviceId: f.owner.binding.kioskId,
      kind: "kiosk",
      credentialEpoch: 8,
    },
    serverTime: 1000,
    mode: "observe",
    policyRevision: null,
    keyset: null,
  });
  await enqueueOrder(
    { ...f.body, deviceSeq: 2 },
    "22222222-2222-4222-8222-222222222222",
    "pending_attestation",
  );
  delete f.client.reserveGrantOrder;
  f.client.attestOrder = vi.fn(async () => ({
    claimedAt: "2026-09-13T00:00:01Z",
    admissionProof: "observe-attestation",
  }));
  f.client.submitGrantEvidence = vi.fn(async (envelope) => {
    expect(envelope.grants).toEqual([]);
    expect(envelope.eventGrants).toEqual({});
    expect(envelope.payload).toMatchObject({ admissionProof: "observe-attestation", deviceSeq: 2 });
    return { ...receipt(envelope.batchId), reason: "missing_grant" };
  });
  await flushQueue(f.client, () => new Date("2026-09-13T01:00:00Z"));
  expect(f.client.attestOrder).toHaveBeenCalledOnce();
  expect(f.client.submitGrantEvidence).toHaveBeenCalledOnce();
  expect(f.client.submitOrder).not.toHaveBeenCalled();
  expect(await listQueue()).toEqual([]);
  expect(await readJournal(100)).toMatchObject([{ orderNo: "ORDER-1", acceptedCount: 1 }]);
  expect(await withStore<unknown[]>(STORE_GRANTS, "readonly", (s) => s.getAll())).toContainEqual(
    expect.objectContaining({
      receipt: expect.objectContaining({
        reason: "missing_grant",
        reconciliation: { status: "applied", statusCode: 201, result: native },
      }),
    }),
  );
});
it("does not retroactively upgrade an accepted legacy order after authenticated configuration", async () => {
  const f = await fixture(),
    [queued] = await listQueue();
  if (!queued) throw Error("queue");
  delete queued.grantEvidence;
  await withStore(STORE_QUEUE, "readwrite", (s) => s.put(queued));
  const { beginGrantRequest, installGrantConfiguration } =
    await import("../src/grants/transport.js");
  const lease = await beginGrantRequest();
  if (!lease) throw Error("lease");
  await installGrantConfiguration(lease, {
    protocol: "offline-grants-v1",
    owner: {
      tenantId: "tenant",
      deviceId: f.owner.binding.kioskId,
      kind: "kiosk",
      credentialEpoch: 8,
    },
    serverTime: 1000,
    mode: "observe",
    policyRevision: null,
    keyset: null,
  });
  f.client.submitGrantEvidence = vi.fn();
  await flushQueue(f.client, () => new Date("2026-09-13T01:00:00Z"));
  expect(f.client.submitOrder).toHaveBeenCalledOnce();
  expect(f.client.submitGrantEvidence).not.toHaveBeenCalled();
});
