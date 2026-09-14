import { afterEach, expect, it, vi } from "vitest";
import { writeConfig } from "../src/store/config.js";
import { enqueueOrder, listQueue } from "../src/store/queue.js";
import { withStore, STORE_GRANTS, STORE_GRANT_READINESS } from "../src/store/db.js";
import { boxRegistryCredentialOwnerOf } from "../src/store/installation-binding.js";
import { emptyState, stateKey } from "../src/grants/store.js";
import { createKioskClient } from "../src/api/client.js";
import { flushQueue, cancelFlushRetry } from "../src/sync/worker.js";
afterEach(() => {
  cancelFlushRetry();
  vi.unstubAllGlobals();
});
it("uploads an already accepted order after strict grants disappear and preserves the opaque admission proof", async () => {
  const cfg = await writeConfig({
    serverUrl: "https://fixture.invalid",
    kioskId: "00000000-0000-4000-8000-000000000001",
    token: "test-only",
    kioskName: "Fixture",
    place: null,
    nextDeviceSeq: 2,
  });
  const body = {
    deviceSeq: 1,
    badgeDigest: "digest",
    reason: "buy" as const,
    items: [{ rawKm: "saved-raw" }],
  };
  await enqueueOrder(body, "00000000-0000-4000-8000-000000000002", "pending_attestation");
  const owner = boxRegistryCredentialOwnerOf(cfg);
  if (!owner) throw Error("owner");
  await withStore(STORE_GRANTS, "readwrite", (s) =>
    s.put({ ...emptyState(owner), tenantId: "tenant", epoch: 7, mode: "strict" }, stateKey(owner)),
  );
  const submitted: unknown[] = [];
  const fetchMock = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    const path = String(url);
    let response: unknown;
    if (path.endsWith("/reservations")) response = { status: "denied", reason: "not_entitled" };
    else if (path.endsWith("/order-admissions"))
      response = { claimedAt: "2026-09-13T00:00:00.000Z", admissionProof: "opaque-proof" };
    else {
      submitted.push(JSON.parse(String(init?.body)));
      response = { orderNo: "ORD-1", status: "pending", itemCount: 1, conflicts: [] };
    }
    return new Response(JSON.stringify(response), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  });
  vi.stubGlobal("fetch", fetchMock);
  await flushQueue(
    createKioskClient({ ...cfg, token: "test-only" }),
    () => new Date("2026-09-13T00:00:00Z"),
  );
  expect(await listQueue()).toEqual([]);
  expect(submitted).toEqual([
    { ...body, createdAt: "2026-09-13T00:00:00.000Z", admissionProof: "opaque-proof" },
  ]);
  expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual([
    "https://fixture.invalid/kiosk/grants/v1/reservations",
    "https://fixture.invalid/kiosk/order-admissions",
    "https://fixture.invalid/kiosk/orders",
  ]);
});

it("cancels a pending readiness intent when the kiosk credential owner changes", async () => {
  const paired = await writeConfig({
    serverUrl: "https://fixture.invalid",
    kioskId: "00000000-0000-4000-8000-000000000001",
    token: "first-token",
    kioskName: "Fixture",
    place: null,
    nextDeviceSeq: 1,
  });
  const owner = boxRegistryCredentialOwnerOf(paired);
  if (!owner) throw Error("owner");
  await withStore(STORE_GRANT_READINESS, "readwrite", (store) =>
    store.put({
      requestId: "11111111-1111-4111-8111-111111111111",
      owner,
      body: { requestId: "11111111-1111-4111-8111-111111111111" },
    }),
  );
  await writeConfig({ ...paired, token: null });
  expect(await withStore(STORE_GRANT_READINESS, "readonly", (store) => store.getAll())).toEqual([]);
});
