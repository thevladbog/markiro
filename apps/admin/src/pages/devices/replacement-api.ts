import { z } from "zod";
import {
  cabinetDeviceReplacementContracts as contracts,
  type DeviceReplacementPreviewRequest,
  type DeviceReplacementConfirm,
  type DeviceReplacementCancel,
} from "@markiro/platform-contracts";
import { ApiRequestError, apiFetch } from "../../api/client.js";
const conflicts = z.enum([
  "device_replacement_inconsistent",
  "device_replacement_source_ineligible",
  "device_replacement_request_conflict",
  "device_replacement_stale",
  "device_replacement_already_prepared",
]);
export function replacementErrorKind(error: unknown): "authorization" | "conflict" | "uncertain" {
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
function route(path: string, tenantId: string, idName?: string, id?: string) {
  let result = path.replace(":tenantId", encodeURIComponent(tenantId));
  if (idName && id) result = result.replace(`:${idName}`, encodeURIComponent(id));
  return result;
}
export async function listDeviceReplacements(tenantId: string) {
  const c = contracts.list;
  return c.response.parse(await apiFetch<unknown>(route(c.path, tenantId), {}));
}
export async function previewDeviceReplacement(
  tenantId: string,
  deviceId: string,
  body: DeviceReplacementPreviewRequest,
) {
  const c = contracts.preview;
  const request = c.body.parse(body);
  const result = c.response.parse(
    await apiFetch<unknown>(route(c.path, tenantId, "deviceId", deviceId), {
      method: c.method,
      body: JSON.stringify(request),
    }),
  );
  if (
    result.requestId !== request.requestId ||
    result.sourceDeviceId !== deviceId ||
    result.observation.target.name !== request.target.name ||
    result.observation.target.kind !== request.target.kind
  )
    throw new Error("Replacement response identity mismatch");
  return result;
}
export async function confirmDeviceReplacement(
  tenantId: string,
  deviceId: string,
  body: DeviceReplacementConfirm,
) {
  const c = contracts.confirm;
  const request = c.body.parse(body);
  const result = c.response.parse(
    await apiFetch<unknown>(route(c.path, tenantId, "deviceId", deviceId), {
      method: c.method,
      body: JSON.stringify(request),
    }),
  );
  if (result.requestId !== request.requestId || result.preparation.sourceDeviceId !== deviceId)
    throw new Error("Replacement response identity mismatch");
  return result;
}
export async function cancelDeviceReplacement(
  tenantId: string,
  preparationId: string,
  body: DeviceReplacementCancel,
) {
  const c = contracts.cancel;
  const request = c.body.parse(body);
  const result = c.response.parse(
    await apiFetch<unknown>(route(c.path, tenantId, "preparationId", preparationId), {
      method: c.method,
      body: JSON.stringify(request),
    }),
  );
  if (
    result.requestId !== request.requestId ||
    result.preparation.id !== preparationId ||
    result.preparation.state !== "cancelled"
  )
    throw new Error("Replacement response identity mismatch");
  return result;
}
