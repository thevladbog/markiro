import { z } from "zod";
import {
  cabinetDeviceRetentionContracts as contracts,
  type DeviceRetentionPreviewRequest,
  type DeviceRetentionConfirm,
  type DeviceRetentionPreview,
} from "@markiro/platform-contracts";
import { ApiRequestError, apiFetch } from "../../api/client.js";
const conflicts = z.enum([
  "device_retention_request_conflict",
  "device_retention_stale",
  "device_retention_ineligible_selection",
  "device_retention_revision_exhausted",
]);
export function retentionErrorKind(error: unknown): "authorization" | "conflict" | "uncertain" {
  if (!(error instanceof ApiRequestError)) return "uncertain";
  if (
    error.status === 409 &&
    z.object({ code: conflicts }).strict().safeParse(error.details).success
  )
    return "conflict";
  if (error.status === 401 || error.status === 403) {
    const name = error.status === 401 ? "Unauthorized" : "Forbidden";
    const defaultEnvelope = z
      .object({ statusCode: z.literal(error.status), message: z.literal(name) })
      .strict();
    const customEnvelope = z
      .object({
        statusCode: z.literal(error.status),
        error: z.literal(name),
        message: z.string().trim().min(1),
      })
      .strict();
    if (z.union([defaultEnvelope, customEnvelope]).safeParse(error.details).success)
      return "authorization";
  }
  return "uncertain";
}
function route(path: string, tenantId: string) {
  return path.replace(":tenantId", encodeURIComponent(tenantId));
}
function sameSet(a: string[], b: string[]) {
  return a.length === b.length && a.every((id) => b.includes(id));
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return JSON.stringify(value.map(canonical));
  if (value !== null && typeof value === "object")
    return JSON.stringify(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => [k, canonical(v)]),
    );
  return JSON.stringify(value);
}
export async function inspectDeviceRetention(tenantId: string) {
  const c = contracts.inspect;
  const result = c.response.parse(await apiFetch<unknown>(route(c.path, tenantId), {}));
  const observations = [
    ...(result.observation ? [result.observation] : []),
    ...result.selections.map((item) => item.selection.observation),
  ];
  if (observations.some((o) => o.current.tenantId !== tenantId || o.future.tenantId !== tenantId))
    throw new Error("Retention response tenant mismatch");
  return result;
}
export async function previewDeviceRetention(
  tenantId: string,
  body: DeviceRetentionPreviewRequest,
) {
  const c = contracts.preview;
  const request = c.body.parse(body);
  const result = c.response.parse(
    await apiFetch<unknown>(route(c.path, tenantId), {
      method: c.method,
      body: JSON.stringify(request),
    }),
  );
  if (
    result.requestId !== request.requestId ||
    result.expectedRevision !== request.expectedRevision ||
    result.observation.boundary.key !== request.boundaryKey ||
    result.observation.current.tenantId !== tenantId ||
    result.observation.future.tenantId !== tenantId ||
    !sameSet(result.selectedDeviceIds, request.selectedDeviceIds)
  )
    throw new Error("Retention preview identity mismatch");
  return result;
}
export async function confirmDeviceRetention(
  tenantId: string,
  body: DeviceRetentionConfirm,
  expected: DeviceRetentionPreview,
) {
  const c = contracts.confirm;
  const request = c.body.parse(body);
  if (
    request.previewId !== expected.id ||
    request.requestId !== expected.requestId ||
    expected.observation.current.tenantId !== tenantId
  )
    throw new Error("Retention confirmation identity mismatch");
  const result = c.response.parse(
    await apiFetch<unknown>(route(c.path, tenantId), {
      method: c.method,
      body: JSON.stringify(request),
    }),
  );
  if (
    result.requestId !== request.requestId ||
    result.selection.revision !== expected.expectedRevision + 1 ||
    !sameSet(result.selection.selectedDeviceIds, expected.selectedDeviceIds) ||
    canonical(result.selection.observation) !== canonical(expected.observation)
  )
    throw new Error("Retention receipt identity mismatch");
  return result;
}
