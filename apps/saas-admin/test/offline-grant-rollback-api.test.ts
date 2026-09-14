import { afterEach, expect, it, vi } from "vitest";
import {
  cancelOfflineGrantRollback,
  confirmOfflineGrantRollback,
  listOfflineGrantRollbackCandidates,
  listOfflineGrantRollbacks,
  prepareOfflineGrantRollback,
} from "../src/pages/catalog/offline-grant-rollback-api.js";
import { jsonResponse } from "./render.js";

const ids = {
  activation: "018f7bd1-4420-4b13-9f77-89f3a5374803",
  preparation: "018f7bd1-4420-4b13-9f77-89f3a5374802",
  request: "018f7bd1-4420-4b13-9f77-89f3a5374801",
};
afterEach(() => vi.unstubAllGlobals());
it("serializes rollback candidate, list and mutation routes", async () => {
  const fetchMock = vi.fn<typeof fetch>(async (input) => {
    const url = String(input);
    if (url.includes("/candidates?")) return jsonResponse(200, { items: [], nextCursor: null });
    if (url.includes("?")) return jsonResponse(200, { items: [], nextCursor: null });
    return jsonResponse(500, { kind: "unexpected" });
  });
  vi.stubGlobal("fetch", fetchMock);
  await listOfflineGrantRollbackCandidates({ tenantId: "tenant-a", limit: 10 });
  await listOfflineGrantRollbacks({ state: "prepared", limit: 10 });
  await expect(
    prepareOfflineGrantRollback({
      protocol: "offline-grants-rollback-v1",
      activationIds: [ids.activation],
      decisionReference: "CAB-RB",
      requestId: ids.request,
    }),
  ).rejects.toBeTruthy();
  await expect(
    confirmOfflineGrantRollback(ids.preparation, {
      protocol: "offline-grants-rollback-v1",
      rollbackDigest: "a".repeat(64),
      requestId: ids.request,
    }),
  ).rejects.toBeTruthy();
  await expect(
    cancelOfflineGrantRollback(ids.preparation, {
      protocol: "offline-grants-rollback-v1",
      reason: "cancel",
      requestId: ids.request,
    }),
  ).rejects.toBeTruthy();
  expect(fetchMock.mock.calls.map(([input]) => String(input))).toEqual([
    "/api/platform/offline-grants/rollbacks/candidates?limit=10&tenantId=tenant-a",
    "/api/platform/offline-grants/rollbacks?limit=10&state=prepared",
    "/api/platform/offline-grants/rollbacks",
    `/api/platform/offline-grants/rollbacks/${ids.preparation}/confirm`,
    `/api/platform/offline-grants/rollbacks/${ids.preparation}/cancel`,
  ]);
  expect(JSON.parse(String(fetchMock.mock.calls[2]?.[1]?.body))).toEqual({
    protocol: "offline-grants-rollback-v1",
    activationIds: [ids.activation],
    decisionReference: "CAB-RB",
    requestId: ids.request,
  });
});
