import { afterEach, expect, it, vi } from "vitest";
import {
  listDeviceReplacements,
  previewDeviceReplacement,
  confirmDeviceReplacement,
  cancelDeviceReplacement,
  replacementErrorKind,
  requestReplacementDrain,
  previewReplacementExecution,
  previewEmergencyReplacement,
  executeReplacement,
  issueReplacementRecoveryCode,
  closeReplacementRecovery,
} from "../src/pages/devices/replacement-api.js";
import {
  workflowPreparation,
  executionPreview,
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
    "/api/device-licensing/replacements",
    `/api/device-licensing/${SOURCE}/replacements/preview`,
    `/api/device-licensing/${SOURCE}/replacements/confirm`,
    `/api/device-licensing/replacements/${PROJECT}/cancel`,
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
it.each([
  { message: "Forbidden", statusCode: 403 },
  { message: "Unauthorized", statusCode: 401 },
  { message: "Fresh permissions required", statusCode: 403, error: "Forbidden" },
])("recognizes complete installed Nest authorization envelope %o", async (body) => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response(body, body.statusCode)));
  const error = await listDeviceReplacements("tenant-1").catch((error) => error);
  expect(replacementErrorKind(error)).toBe("authorization");
});
it.each([
  { message: "Forbidden", statusCode: 401 },
  { message: "Forbidden", error: "Forbidden" },
  { message: "Other", statusCode: 403 },
  { message: "", statusCode: 403, error: "Forbidden" },
])("keeps incomplete or mismatched authorization uncertain %o", async (body) => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response(body, 403)));
  const error = await listDeviceReplacements("tenant-1").catch((error) => error);
  expect(replacementErrorKind(error)).toBe("uncertain");
});

it("validates execution receipts and exact operation identity", async () => {
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(
      response({ requestId: SOURCE, preparation: workflowPreparation("draining") }),
    )
    .mockResolvedValueOnce(response(executionPreview(SOURCE)))
    .mockResolvedValueOnce(response(executionPreview(SOURCE, "emergency")))
    .mockResolvedValueOnce(
      response({ requestId: SOURCE, preparation: workflowPreparation("completed") }),
    )
    .mockResolvedValueOnce(
      response({
        requestId: SOURCE,
        preparation: workflowPreparation("completed", "required"),
        code: "12345678",
        expiresAt: "2026-09-18T13:00:00.000Z",
      }),
    )
    .mockResolvedValueOnce(
      response({
        requestId: SOURCE,
        preparation: workflowPreparation("completed", "evidence_unavailable"),
      }),
    );
  vi.stubGlobal("fetch", fetch);
  const request = { requestId: SOURCE, expectedRevision: 3 };
  await requestReplacementDrain("tenant-1", PROJECT, request);
  await previewReplacementExecution("tenant-1", PROJECT, request);
  await previewEmergencyReplacement("tenant-1", PROJECT, { ...request, reason: " reason " });
  await executeReplacement("tenant-1", PROJECT, { ...request, mode: "normal", previewId: PREVIEW });
  await issueReplacementRecoveryCode("tenant-1", PROJECT, { ...request, expectedRevision: 9 });
  await closeReplacementRecovery("tenant-1", PROJECT, {
    ...request,
    expectedRevision: 9,
    reason: " lost ",
  });
  expect(fetch.mock.calls.map((call) => call[0])).toEqual(
    [
      "drain",
      "execution/preview",
      "emergency/preview",
      "execute",
      "recovery/code",
      "recovery/close",
    ].map((suffix) => `/api/device-licensing/replacements/${PROJECT}/${suffix}`),
  );
});
it("rejects execution preview mode/revision/identity mismatch and malformed receipts", async () => {
  const request = { requestId: SOURCE, expectedRevision: 3 };
  for (const patch of [
    { mode: "emergency" },
    { expectedRevision: 4 },
    { requestId: PROJECT },
    { preparationId: SOURCE },
    { privateKey: "never" },
  ]) {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(response({ ...executionPreview(SOURCE), ...patch })),
    );
    await expect(previewReplacementExecution("tenant-1", PROJECT, request)).rejects.toBeDefined();
  }
  vi.stubGlobal(
    "fetch",
    vi
      .fn()
      .mockResolvedValue(
        response({ requestId: PROJECT, preparation: workflowPreparation("completed") }),
      ),
  );
  await expect(
    executeReplacement("tenant-1", PROJECT, { ...request, mode: "normal", previewId: PREVIEW }),
  ).rejects.toBeDefined();
});

it.each(["capacity_unavailable", "facts_too_large", "offline_boundary_unknown"])(
  "refreshes facts for a definitive %s domain rejection",
  async (reason) => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(response({ code: `device_replacement_${reason}` }, 409)),
    );
    const error = await listDeviceReplacements("tenant-1").catch((error) => error);
    expect(replacementErrorKind(error)).toBe("conflict");
  },
);
it.each(["execution_incomplete", "credential_revoke_unconfirmed"])(
  "preserves request identity for recoverable %s",
  async (reason) => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(response({ code: `device_replacement_${reason}` }, 409)),
    );
    const error = await listDeviceReplacements("tenant-1").catch((error) => error);
    expect(replacementErrorKind(error)).toBe("uncertain");
  },
);

it("treats a definitive unsupported-client refusal as a conflict, freeing the workflow for emergency replacement", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(response({ code: "client_upgrade_required" }, 409)),
  );
  const error = await requestReplacementDrain("tenant-1", PROJECT, {
    requestId: SOURCE,
    expectedRevision: 1,
  }).catch((error) => error);
  expect(replacementErrorKind(error)).toBe("conflict");
});
