import { afterEach, expect, it, vi } from "vitest";

import {
  cancelOfflineGrantActivation,
  confirmOfflineGrantActivation,
  getOfflineGrantActivation,
  listOfflineGrantActivations,
  prepareOfflineGrantActivation,
} from "../src/pages/catalog/offline-grant-activation-api.js";
import {
  activationId,
  activationRequestId,
  cancelRequestId,
  confirmRequestId,
  preparedActivation,
} from "./offline-grant-activation-fixtures.js";
import { policyId, readinessPreview, readyDeviceId } from "./offline-grant-readiness-fixtures.js";
import { jsonResponse } from "./render.js";

afterEach(() => vi.unstubAllGlobals());

it("serializes every activation route and parses its contract", async () => {
  const fetchMock = vi.fn<typeof fetch>(async (input) => {
    const url = String(input);
    if (url.endsWith("/confirm")) {
      return jsonResponse(200, {
        status: "needs_review",
        requestId: confirmRequestId,
        preparation: { ...preparedActivation, state: "needs_review" },
        reasons: ["client_report_stale"],
      });
    }
    if (url.endsWith("/cancel")) {
      return jsonResponse(200, {
        ...preparedActivation,
        state: "cancelled",
        cancelledBy: { userId: "user-2", role: "platform_admin" },
        cancelledAt: readinessPreview.asOf,
        cancellationReason: "Changed cohort",
      });
    }
    if (url.includes(`/${activationId}`)) return jsonResponse(200, preparedActivation);
    if (url.includes("?"))
      return jsonResponse(200, { items: [preparedActivation], nextCursor: null });
    return jsonResponse(200, preparedActivation);
  });
  vi.stubGlobal("fetch", fetchMock);

  await listOfflineGrantActivations({ state: "prepared", limit: 10 });
  await getOfflineGrantActivation(activationId);
  await prepareOfflineGrantActivation({
    protocol: "offline-grants-activation-v1",
    previewRequestId: readinessPreview.requestId,
    previewDigest: readinessPreview.previewDigest,
    policyId,
    deviceIds: [readyDeviceId],
    decisionReference: "CAB-2026-0914",
    requestId: activationRequestId,
  });
  await confirmOfflineGrantActivation(activationId, {
    protocol: "offline-grants-activation-v1",
    preparationDigest: preparedActivation.preparationDigest,
    requestId: confirmRequestId,
  });
  await cancelOfflineGrantActivation(activationId, {
    protocol: "offline-grants-activation-v1",
    reason: "Changed cohort",
    requestId: cancelRequestId,
  });

  expect(fetchMock.mock.calls.map(([input]) => String(input))).toEqual([
    "/api/platform/offline-grants/activations?limit=10&state=prepared",
    `/api/platform/offline-grants/activations/${activationId}`,
    "/api/platform/offline-grants/activations",
    `/api/platform/offline-grants/activations/${activationId}/confirm`,
    `/api/platform/offline-grants/activations/${activationId}/cancel`,
  ]);
  expect(JSON.parse(String(fetchMock.mock.calls[4]?.[1]?.body))).toEqual({
    protocol: "offline-grants-activation-v1",
    reason: "Changed cohort",
    requestId: cancelRequestId,
  });
});
