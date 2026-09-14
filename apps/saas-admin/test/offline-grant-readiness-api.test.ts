import { afterEach, describe, expect, it, vi } from "vitest";

import { ApiRequestError } from "../src/api/client.js";
import {
  listOfflineGrantReadiness,
  previewOfflineGrantReadiness,
} from "../src/pages/catalog/offline-grant-readiness-api.js";
import {
  policyId,
  readinessList,
  readinessPreview,
  readyDeviceId,
  requestId,
} from "./offline-grant-readiness-fixtures.js";
import { jsonResponse } from "./render.js";

afterEach(() => vi.unstubAllGlobals());

describe("offline grant readiness API", () => {
  it("validates filters and preserves the exact preview body", async () => {
    const fetchMock = vi.fn<typeof fetch>(async (_input, init) =>
      jsonResponse(200, init?.method === "POST" ? readinessPreview : readinessList),
    );
    vi.stubGlobal("fetch", fetchMock);

    await listOfflineGrantReadiness(
      { tenantId: "tenant ready", deviceKind: "station", readiness: "eligible", policyId },
      "next_page",
    );
    const previewRequest = {
      policyId,
      mode: "strict" as const,
      deviceIds: [readyDeviceId],
      requestId,
    };
    await previewOfflineGrantReadiness(previewRequest);

    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      `/api/platform/offline-grants/readiness?tenantId=tenant+ready&deviceKind=station&readiness=eligible&policyId=${policyId}&cursor=next_page&limit=50`,
    );
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toEqual(previewRequest);
  });

  it("rejects a malformed readiness success at the browser boundary", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async () =>
        jsonResponse(200, {
          ...readinessList,
          items: [
            {
              ...readinessList.items[0],
              eligibility: { status: "eligible", reasons: ["client_report_missing"] },
            },
          ],
        }),
      ),
    );

    await expect(listOfflineGrantReadiness()).rejects.toMatchObject({
      kind: "contract",
      endpoint: "/offline-grants/readiness",
    });
  });

  it("surfaces a valid authorization envelope as authorization", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async () => jsonResponse(403, { code: "FORBIDDEN" })),
    );

    await expect(listOfflineGrantReadiness()).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof ApiRequestError && error.kind === "authorization" && error.status === 403,
    );
  });
});
