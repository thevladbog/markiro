import { ApiRequestError } from "../src/api/client.js";
import { afterEach, expect, it, vi } from "vitest";
import {
  inspectDeviceRetention,
  previewDeviceRetention,
  confirmDeviceRetention,
  retentionErrorKind,
} from "../src/pages/tenants/device-retention-api.js";
import {
  inspection,
  preview,
  request,
  selection,
  response,
  id,
  otherId,
} from "./device-retention-fixtures.js";
afterEach(() => vi.unstubAllGlobals());
it("validates routes, bodies and original receipt", async () => {
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(response(inspection))
    .mockResolvedValueOnce(response(preview))
    .mockResolvedValueOnce(response({ requestId: id, selection }));
  vi.stubGlobal("fetch", fetch);
  await inspectDeviceRetention("tenant-a");
  await previewDeviceRetention("tenant-a", request);
  await confirmDeviceRetention("tenant-a", { requestId: id, previewId: preview.id }, preview);
  expect(fetch.mock.calls.map((x) => x[0])).toEqual([
    "/api/platform/tenants/tenant-a/device-licensing/retention",
    "/api/platform/tenants/tenant-a/device-licensing/retention/preview",
    "/api/platform/tenants/tenant-a/device-licensing/retention/confirm",
  ]);
  expect(JSON.parse(String(fetch.mock.calls[1]?.[1]?.body))).toEqual(request);
});
it.each(["tenant", "revision", "set", "request", "boundary"])(
  "rejects mismatched preview %s",
  async (field) => {
    const value = structuredClone(preview);
    if (field === "tenant") {
      value.observation.current.tenantId = "other";
      value.observation.future.tenantId = "other";
    }
    if (field === "revision") value.expectedRevision = 1;
    if (field === "set") value.selectedDeviceIds = [];
    if (field === "request") value.requestId = otherId;
    if (field === "boundary") value.observation.boundary.key = "b".repeat(64);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response(value)));
    await expect(previewDeviceRetention("tenant-a", request)).rejects.toBeDefined();
  },
);
it.each(["revision", "observation", "set", "request"])(
  "rejects mismatched receipt %s",
  async (field) => {
    const result = { requestId: id, selection: structuredClone(selection) };
    if (field === "revision") result.selection.revision = 2;
    if (field === "observation") {
      const device = result.selection.observation.devices[0];
      if (!device) throw new Error("Missing device");
      device.name = "changed";
    }
    if (field === "set") result.selection.selectedDeviceIds = [];
    if (field === "request") result.requestId = otherId;
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response(result)));
    await expect(
      confirmDeviceRetention("tenant-a", { requestId: id, previewId: preview.id }, preview),
    ).rejects.toBeDefined();
  },
);
it.each([401, 403, 409])("keeps malformed HTTP %i uncertain", async (status) => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response({ message: "Forbidden" }, status)));
  expect(retentionErrorKind(await inspectDeviceRetention("tenant-a").catch((e) => e))).toBe(
    "uncertain",
  );
});

it("accepts server canonical device ordering", async () => {
  const value = structuredClone(preview);
  const first = value.observation.devices[0];
  if (!first) throw new Error("Missing device");
  value.observation.devices.push({ ...first, deviceId: otherId, name: "Second" });
  value.observation.future.candidate.quotas.stations = { limit: 2, used: 2, remaining: 0 };
  value.selectedDeviceIds = [id, otherId];
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response(value)));
  await expect(
    previewDeviceRetention("tenant-a", { ...request, selectedDeviceIds: [otherId, id] }),
  ).resolves.toEqual(value);
});
it.each([
  "device_retention_request_conflict",
  "device_retention_stale",
  "device_retention_ineligible_selection",
  "device_retention_revision_exhausted",
])("recognizes deterministic domain %s", async (code) => {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(response({ code, message: "Changed", requestId: id }, 409)),
  );
  expect(retentionErrorKind(await inspectDeviceRetention("tenant-a").catch((e) => e))).toBe(
    "conflict",
  );
});
it.each([401, 403])("recognizes complete authorization %i", async (status) => {
  vi.stubGlobal(
    "fetch",
    vi
      .fn()
      .mockResolvedValue(response({ code: "forbidden", message: "Denied", requestId: id }, status)),
  );
  expect(retentionErrorKind(await inspectDeviceRetention("tenant-a").catch((e) => e))).toBe(
    "authorization",
  );
});
it("does not classify platform contract errors by status or code", () => {
  expect(
    retentionErrorKind(
      new ApiRequestError(409, "Malformed", "device_retention_stale", { kind: "contract" }),
    ),
  ).toBe("uncertain");
  expect(
    retentionErrorKind(new ApiRequestError(403, "Malformed", "forbidden", { kind: "contract" })),
  ).toBe("uncertain");
});
