import { expect, it } from "vitest";
import { writeConfig } from "../src/store/config.js";
import { enqueueOrder, listQueue } from "../src/store/queue.js";
import { withStore } from "../src/store/db.js";

it("refuses strict enqueue without authority and leaves the queue unchanged", async () => {
  const config = await writeConfig({
    serverUrl: "https://fixture.invalid",
    kioskId: "00000000-0000-4000-8000-000000000001",
    token: "test-only",
    kioskName: "Fixture",
    place: null,
    nextDeviceSeq: 2,
  });
  await withStore("offline-grants", "readwrite", (store) =>
    store.put(
      {
        binding: { serverUrl: config.serverUrl, kioskId: config.kioskId },
        credentialGeneration: config.credentialGeneration,
        tenantId: "tenant",
        epoch: 7,
        mode: "strict",
        requestedSequence: 0,
        installedSequence: 0,
        keysetRevision: "",
        keys: [],
        retiredKids: [],
        clock: null,
      },
      JSON.stringify(["state", config.serverUrl, config.kioskId]),
    ),
  );
  await expect(
    enqueueOrder(
      { deviceSeq: 1, badgeDigest: "badge", reason: "buy", items: [{ rawKm: "code" }] },
      "employee",
      "pending_attestation",
      1,
    ),
  ).rejects.toThrow("wrong_owner");
  expect(await listQueue()).toEqual([]);
});
it("does not overwrite an accepted sequence when two contexts race different order bodies", async () => {
  const first = {
    deviceSeq: 8,
    badgeDigest: "badge",
    reason: "buy" as const,
    items: [{ rawKm: "first" }],
  };
  const second = { ...first, items: [{ rawKm: "second" }] };
  const results = await Promise.allSettled([
    enqueueOrder(first, "employee"),
    enqueueOrder(second, "employee"),
  ]);
  expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
  expect(await listQueue()).toHaveLength(1);
});
async function strictFixture() {
  const { webcrypto } = await import("node:crypto");
  const { vi } = await import("vitest");
  vi.stubGlobal("crypto", webcrypto);
  const { clockSample } = await import("../src/grants/clock.js");
  const config = await writeConfig({
    serverUrl: "https://fixture.invalid",
    kioskId: "kiosk",
    token: "test-only",
    kioskName: "Fixture",
    place: null,
    nextDeviceSeq: 2,
  });
  const sample = clockSample();
  const grant = {
    tenantId: "tenant",
    deviceId: "kiosk",
    kind: "kiosk",
    credentialEpoch: 7,
    version: 1,
    issuer: config.serverUrl,
    grantId: "verified-fixture",
    entitlementRevision: "e1",
    policyRevision: "p1",
    issuedAt: 1000,
    notBefore: 1000,
    kindOfGrant: "device",
    startNotAfter: 100000,
    capabilities: ["pickup.start.v1"],
  };
  const state = {
    binding: { serverUrl: config.serverUrl, kioskId: "kiosk" },
    credentialGeneration: config.credentialGeneration,
    tenantId: "tenant",
    epoch: 7,
    mode: "strict",
    requestedSequence: 1,
    installedSequence: 1,
    keysetRevision: "test",
    keys: [],
    retiredKids: [],
    clock: {
      serverMs: 1000,
      monotonicMs: sample.monotonicMs,
      bootId: sample.bootId,
      highWaterMs: 1000,
      wallHighWaterMs: sample.wallMs,
    },
    device: {
      grant,
      compact: "signature covered in transport suite",
      kid: "test",
      credentialGeneration: config.credentialGeneration,
    },
  };
  const digest = "PGnhdQA2lW09CcvuOhCmvp0z4HbztWXaYIq7+dqmLoQ=";
  const snapshot = {
    bootstrap: {
      products: [{ id: "product", gtin14: "04600682000013" }],
      employees: [
        {
          id: "employee",
          badgeHash: `pbkdf2$sha256$100000$fwGrIt01vwgBxxDlhqLVRQ==$${digest}`,
          limitMode: "unlimited",
          dayLimit: 0,
          canWriteoff: false,
        },
      ],
      operators: [],
      pickupPolicy: { limitsEnabled: false },
      config: { dayLimitPerEmployee: 0 },
      reasons: [],
    },
    fetchedAt: "fixture",
  };
  const key = JSON.stringify(["state", config.serverUrl, "kiosk"]);
  await withStore("offline-grants", "readwrite", (store) => store.put(state, key));
  await withStore("snapshot", "readwrite", (store) => store.put(snapshot, "current"));
  return {
    state,
    key,
    snapshot,
    body: {
      deviceSeq: 1,
      badgeDigest: digest,
      reason: "buy" as const,
      items: [{ rawKm: "010460068200001321KYC9X7MQ\u001d93Abcd" }],
    },
  };
}
it("records owner-derived dimensions once and preserves exact accepted replay after dequeue/epoch renewal", async () => {
  const f = await strictFixture();
  await installCompletionFixture(f);
  await enqueueOrder(f.body, "employee", undefined, 99);
  const rows = await withStore<unknown[]>("offline-grants", "readonly", (s) => s.getAll());
  expect(rows).toContainEqual(
    expect.objectContaining({
      kind: "completion",
      cost: {
        "pickup.complete.v1:events": 1,
        "pickup.complete.v1:units": 1,
        "pickup.complete.v1:containers": 0,
      },
    }),
  );
  const { dequeueOrder } = await import("../src/store/queue.js");
  await dequeueOrder(1);
  await withStore("offline-grants", "readwrite", (s) =>
    s.put(
      {
        ...f.state,
        epoch: 8,
        device: {
          ...f.state.device,
          grant: { ...f.state.device.grant, credentialEpoch: 8, startNotAfter: 1001 },
        },
      },
      f.key,
    ),
  );
  await expect(
    enqueueOrder(f.body, "employee", "pending_attestation", 99),
  ).resolves.toBeUndefined();
  expect(await listQueue()).toEqual([]);
  await expect(
    enqueueOrder({ ...f.body, items: [{ rawKm: "changed" }] }, "employee"),
  ).rejects.toThrow("sequence_conflict");
});
it("rechecks current employee badge authority and rolls back both acceptance and clock on denial", async () => {
  const f = await strictFixture();
  await withStore("snapshot", "readwrite", (s) =>
    s.put({ ...f.snapshot, bootstrap: { ...f.snapshot.bootstrap, employees: [] } }, "current"),
  );
  await expect(enqueueOrder(f.body, "employee")).rejects.toThrow("wrong_owner");
  expect(await listQueue()).toEqual([]);
  const { readGrantState } = await import("../src/grants/store.js");
  expect((await readGrantState())?.clock?.highWaterMs).toBe(1000);
});
it("advances the current sequence atomically and rejects a captured owner after re-pair", async () => {
  const { boxRegistryCredentialOwnerOf } = await import("../src/store/installation-binding.js");
  const { readConfig } = await import("../src/store/config.js");
  const cfg = await writeConfig({
    serverUrl: "https://fixture.invalid",
    kioskId: "kiosk",
    token: "first-test-only",
    kioskName: "Fixture",
    place: null,
    nextDeviceSeq: 1,
  });
  const owner = boxRegistryCredentialOwnerOf(cfg);
  if (!owner) throw Error("owner");
  const body = {
    deviceSeq: 1,
    badgeDigest: "digest",
    reason: "buy" as const,
    items: [{ rawKm: "raw" }],
  };
  await enqueueOrder(body, "employee", "pending_attestation", 1, owner);
  expect((await readConfig())?.nextDeviceSeq).toBe(2);
  const next = await writeConfig({ ...cfg, token: "second-test-only", nextDeviceSeq: 5 });
  await expect(
    enqueueOrder({ ...body, deviceSeq: 2 }, "employee", "pending_attestation", 1, owner),
  ).rejects.toThrow("wrong_owner");
  expect((await readConfig())?.credentialGeneration).toBe(next.credentialGeneration);
  expect((await readConfig())?.nextDeviceSeq).toBe(5);
  expect(await listQueue()).toHaveLength(1);
});
it("strict drafts persist before network and cannot be accepted without a bounded task grant", async () => {
  const f = await strictFixture();
  const { preparePickupDraft } = await import("../src/grants/drafts.js");
  const { boxRegistryCredentialOwnerOf } = await import("../src/store/installation-binding.js");
  const { readConfig } = await import("../src/store/config.js");
  const cfg = await readConfig(),
    owner = boxRegistryCredentialOwnerOf(cfg);
  if (!owner) throw Error("owner");
  const confirmed = {
    screen: "confirmation" as const,
    submitting: false,
    session: {
      id: 1,
      badgeDigest: f.body.badgeDigest,
      employee: {
        id: "employee",
        fullName: "Employee",
        limitMode: "unlimited" as const,
        dayLimit: 0,
        canWriteoff: false,
      },
      cart: {
        reason: "buy" as const,
        writeoffReasonId: null,
        notice: null,
        lines: [
          {
            kind: "km" as const,
            rawKm: f.body.items[0]!.rawKm,
            kmKey: "04600682000013:KYC9X7MQ",
            gtin14: "04600682000013",
            serial: "KYC9X7MQ",
            productId: "product",
            name: "Product",
            unitPrice: null,
            bottleCount: 1 as const,
          },
        ],
      },
    },
  };
  const draft = await preparePickupDraft(owner, confirmed, "2026-09-13T00:00:00Z");
  expect(draft.body.deviceSeq).toBe(2);
  expect((await readConfig())?.nextDeviceSeq).toBe(3);
  expect(await listQueue()).toEqual([]);
  expect((await preparePickupDraft(owner, confirmed, "2026-09-13T00:00:01Z")).body).toEqual(
    draft.body,
  );
  await expect(enqueueOrder(draft.body, "employee", undefined, 1, owner)).rejects.toThrow(
    "missing_grant",
  );
  expect(await listQueue()).toEqual([]);
});
async function installCompletionFixture(f: Awaited<ReturnType<typeof strictFixture>>, maximum = 1) {
  const { readConfig } = await import("../src/store/config.js");
  const { boxRegistryCredentialOwnerOf } = await import("../src/store/installation-binding.js");
  const { canonical, orderContent, sha256 } = await import("../src/grants/scope.js");
  const { draftKey } = await import("../src/grants/drafts.js");
  const { reservationKey } = await import("../src/grants/reservations.js");
  const { taskKey } = await import("../src/grants/completion.js");
  const { validatePickupKm } = await import("@markiro/domain");
  const owner = boxRegistryCredentialOwnerOf(await readConfig());
  if (!owner) throw Error("owner");
  const rawKm = f.body.items[0]?.rawKm;
  if (!rawKm) throw Error("item");
  const parsed = validatePickupKm(rawKm);
  if (parsed.status === "not_km" || parsed.status === "incomplete") throw Error("km");
  const payloadDigest = await sha256(orderContent(f.body));
  const scope = {
    version: 1,
    deviceSeq: f.body.deviceSeq,
    payloadDigest,
    reason: "buy",
    writeoffReasonId: null,
    badgeIdentityDigest: await sha256(
      canonical({ badgeDigest: f.body.badgeDigest, badgeCode: null }),
    ),
    items: [{ rawKm, kmKey: parsed.key, productId: "product" }],
    boxes: [],
    unitCount: 1,
    containerCount: 0,
  };
  const source = canonical({ taskKind: "pickup", taskId: "reservation", scope }),
    snapshotDigest = await sha256(source);
  const grant = {
    tenantId: "tenant",
    deviceId: "kiosk",
    kind: "kiosk" as const,
    credentialEpoch: 7,
    version: 1 as const,
    issuer: owner.binding.serverUrl,
    grantId: "task-verified",
    entitlementRevision: "e1",
    policyRevision: "p1",
    issuedAt: 1000,
    notBefore: 1000,
    kindOfGrant: "task" as const,
    taskKind: "pickup" as const,
    taskId: "reservation",
    snapshotDigest,
    completeNotAfter: 100000,
    eventTypes: ["pickup.complete.v1" as const],
    budget: [
      { id: "pickup.complete.v1:events", unit: "event" as const, maximum },
      { id: "pickup.complete.v1:units", unit: "unit" as const, maximum },
      { id: "pickup.complete.v1:containers", unit: "container" as const, maximum: 0 },
    ],
  };
  const admission = { claimedAt: "2026-09-13T00:00:00Z", admissionProof: "opaque-server-proof" };
  Object.assign(f.body, {
    createdAt: admission.claimedAt,
    admissionProof: admission.admissionProof,
  });
  const saved = {
    grant,
    scope,
    canonical: source,
    compact: "signature covered in transport suite",
    kid: "test",
    credentialGeneration: owner.credentialGeneration,
    deviceSeq: f.body.deviceSeq,
    purpose: "reserved_draft",
  };
  await withStore("offline-grants", "readwrite", (store) => {
    store.put(
      {
        recordType: "pickup-draft",
        owner,
        employeeId: "employee",
        badgeDigest: f.body.badgeDigest,
        body: f.body,
        cart: { lines: [], reason: "buy", writeoffReasonId: null, notice: null },
        nonce: "fixed",
        status: "pending",
        taskReady: true,
      },
      draftKey(owner, f.body.deviceSeq),
    );
    store.put(
      {
        credentialGeneration: owner.credentialGeneration,
        deviceSeq: f.body.deviceSeq,
        taskId: grant.taskId,
        snapshotDigest,
        payloadDigest,
        admission,
      },
      reservationKey(owner, f.body.deviceSeq),
    );
    return store.put(
      saved,
      taskKey(owner.binding.serverUrl, "tenant", "kiosk", grant.taskId, snapshotDigest),
    );
  });
  return { owner, grant, saved };
}
it("completes a frozen draft after new-work expiry and consumes all dimensions once across contexts", async () => {
  const f = await strictFixture(),
    { grant } = await installCompletionFixture(f);
  await withStore("offline-grants", "readwrite", (s) =>
    s.put(
      {
        ...f.state,
        device: { ...f.state.device, grant: { ...f.state.device.grant, startNotAfter: 1000 } },
      },
      f.key,
    ),
  );
  const result = await Promise.allSettled([
    enqueueOrder(f.body, "employee"),
    enqueueOrder(f.body, "employee"),
  ]);
  expect(result.every((r) => r.status === "fulfilled")).toBe(true);
  expect(await listQueue()).toHaveLength(1);
  const { counterKey } = await import("../src/grants/completion.js");
  expect(await withStore("offline-grants", "readonly", (s) => s.get(counterKey(grant)))).toEqual({
    "pickup.complete.v1:events": 1,
    "pickup.complete.v1:units": 1,
    "pickup.complete.v1:containers": 0,
  });
  const { admitNewCart } = await import("../src/grants/admission.js");
  await expect(admitNewCart()).rejects.toThrow("expired");
});
it("denies exhausted task units despite a fresh device and preserves queue and counters", async () => {
  const f = await strictFixture(),
    { grant } = await installCompletionFixture(f, 0);
  await expect(enqueueOrder(f.body, "employee")).rejects.toThrow("budget_exhausted");
  expect(await listQueue()).toEqual([]);
  const { counterKey } = await import("../src/grants/completion.js");
  expect(
    await withStore("offline-grants", "readonly", (s) => s.get(counterKey(grant))),
  ).toBeUndefined();
});
it("fresh badge recovery selects only this employee's saved frozen draft", async () => {
  const f = await strictFixture(),
    { owner } = await installCompletionFixture(f);
  const { recoverPickupDraft } = await import("../src/grants/drafts.js");
  expect((await recoverPickupDraft(owner, "employee", f.body.badgeDigest))?.body).toEqual(f.body);
  expect(await recoverPickupDraft(owner, "different-employee", f.body.badgeDigest)).toBeNull();
  await enqueueOrder(f.body, "employee");
  expect(await recoverPickupDraft(owner, "employee", f.body.badgeDigest)).toBeNull();
});
it("rolls back task counters and draft acceptance when queue persistence fails", async () => {
  const f = await strictFixture(),
    { grant, owner } = await installCompletionFixture(f);
  const { vi } = await import("vitest");
  const { counterKey } = await import("../src/grants/completion.js");
  const { readPickupDraft } = await import("../src/grants/drafts.js");
  const original = IDBObjectStore.prototype.add;
  const spy = vi.spyOn(IDBObjectStore.prototype, "add").mockImplementation(function (
    this: IDBObjectStore,
    value: unknown,
    key?: IDBValidKey,
  ) {
    if (this.name === "queue") throw Error("fixture queue write failure");
    return original.call(this, value, key);
  });
  try {
    await expect(enqueueOrder(f.body, "employee")).rejects.toThrow("fixture queue write failure");
  } finally {
    spy.mockRestore();
  }
  expect(await listQueue()).toEqual([]);
  expect((await readPickupDraft(owner, f.body.deviceSeq))?.status).toBe("pending");
  expect(
    await withStore("offline-grants", "readonly", (s) => s.get(counterKey(grant))),
  ).toBeUndefined();
  await enqueueOrder(f.body, "employee");
  expect(await listQueue()).toHaveLength(1);
});
it("retains spent counters through grant, policy and credential epoch renewal", async () => {
  const f = await strictFixture(),
    { grant, owner, saved } = await installCompletionFixture(f);
  const { counterKey, taskKey } = await import("../src/grants/completion.js");
  const cost = {
    "pickup.complete.v1:events": 1,
    "pickup.complete.v1:units": 1,
    "pickup.complete.v1:containers": 0,
  };
  const renewed = { ...grant, grantId: "renewed", policyRevision: "p2", credentialEpoch: 8 };
  expect(counterKey(renewed)).toBe(counterKey(grant));
  await withStore("offline-grants", "readwrite", (s) => {
    s.put(cost, counterKey(grant));
    s.put({ ...f.state, epoch: 8 }, f.key);
    return s.put(
      { ...saved, grant: renewed },
      taskKey(owner.binding.serverUrl, "tenant", "kiosk", grant.taskId, grant.snapshotDigest),
    );
  });
  await expect(enqueueOrder(f.body, "employee")).rejects.toThrow("budget_exhausted");
  expect(await listQueue()).toEqual([]);
  expect(await withStore("offline-grants", "readonly", (s) => s.get(counterKey(grant)))).toEqual(
    cost,
  );
});
it("explicit cancellation retires a saved draft and denies late completion", async () => {
  const f = await strictFixture(),
    { owner } = await installCompletionFixture(f);
  const { readPickupDraft, abandonPickupDrafts, recoverPickupDraft } =
    await import("../src/grants/drafts.js");
  const draft = await readPickupDraft(owner, f.body.deviceSeq);
  if (!draft) throw Error("draft");
  await abandonPickupDrafts(owner, "employee", draft.cart);
  await expect(enqueueOrder(f.body, "employee")).rejects.toThrow("wrong_task");
  expect(await recoverPickupDraft(owner, "employee", f.body.badgeDigest)).toBeNull();
  expect(await listQueue()).toEqual([]);
});
