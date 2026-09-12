import { afterEach, expect, it, vi } from "vitest";
import {
  listDeviceReplacements,
  previewDeviceReplacement,
  confirmDeviceReplacement,
  cancelDeviceReplacement,
  replacementErrorKind,
} from "../src/pages/tenants/replacement-api.js";
import {
  SOURCE,
  PROJECT,
  PREVIEW,
  preparation,
  preview,
  response,
} from "./device-replacement-fixtures.js";
afterEach(() => vi.unstubAllGlobals());
it("uses each exact route and validates all success contracts", async () => {
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(response({ canPrepare: true, items: [] }))
    .mockResolvedValueOnce(response(preview(SOURCE)))
    .mockResolvedValueOnce(response({ requestId: SOURCE, preparation }))
    .mockResolvedValueOnce(
      response({
        requestId: SOURCE,
        preparation: {
          ...preparation,
          state: "cancelled",
          revision: 2,
          cancelledAt: "2026-09-12T10:01:00.000Z",
        },
      }),
    );
  vi.stubGlobal("fetch", fetch);
  await listDeviceReplacements("tenant-1");
  await previewDeviceReplacement("tenant-1", SOURCE, {
    requestId: SOURCE,
    target: preparation.observation.target,
    reason: "reason",
  });
  await confirmDeviceReplacement("tenant-1", SOURCE, { requestId: SOURCE, previewId: PREVIEW });
  await cancelDeviceReplacement("tenant-1", PROJECT, { requestId: SOURCE, expectedRevision: 1 });
  expect(fetch.mock.calls.map((x) => x[0])).toEqual([
    "/api/platform/tenants/tenant-1/device-licensing/replacements",
    `/api/platform/tenants/tenant-1/device-licensing/${SOURCE}/replacements/preview`,
    `/api/platform/tenants/tenant-1/device-licensing/${SOURCE}/replacements/confirm`,
    `/api/platform/tenants/tenant-1/device-licensing/replacements/${PROJECT}/cancel`,
  ]);
});
it.each([401, 403, 409])("does not trust malformed HTTP %i", async (status) => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response({ message: "Forbidden" }, status)));
  const error = await listDeviceReplacements("tenant-1").catch((error) => error);
  expect(replacementErrorKind(error)).toBe("uncertain");
});
it("rejects malformed and mismatched successes", async () => {
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(response({ canPrepare: true, items: [], privateReason: "secret" }))
    .mockResolvedValueOnce(response(preview(PROJECT)))
    .mockResolvedValueOnce(response({ requestId: PROJECT, preparation }));
  vi.stubGlobal("fetch", fetch);
  await expect(listDeviceReplacements("tenant-1")).rejects.toBeDefined();
  await expect(
    previewDeviceReplacement("tenant-1", SOURCE, {
      requestId: SOURCE,
      target: preparation.observation.target,
      reason: "reason",
    }),
  ).rejects.toBeDefined();
  await expect(
    confirmDeviceReplacement("tenant-1", SOURCE, { requestId: SOURCE, previewId: PREVIEW }),
  ).rejects.toBeDefined();
});
