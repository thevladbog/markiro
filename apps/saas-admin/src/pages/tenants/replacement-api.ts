import { z } from "zod";
import {
  platformDeviceReplacementContracts as contracts,
  type DeviceReplacementPreviewRequest,
  type DeviceReplacementConfirm,
  type DeviceReplacementCancel,
} from "@markiro/platform-contracts";
import { ApiRequestError, platformApiFetch } from "../../api/client.js";
const conflicts = z.enum([
  "device_replacement_inconsistent",
  "device_replacement_source_ineligible",
  "device_replacement_request_conflict",
  "device_replacement_stale",
  "device_replacement_already_prepared",
]);
export function replacementErrorKind(error: unknown): "authorization" | "conflict" | "uncertain" {
  if (!(error instanceof ApiRequestError)) return "uncertain";
  if (error.kind === "authorization" && (error.status === 401 || error.status === 403))
    return "authorization";
  if (error.kind === "domain" && error.status === 409 && conflicts.safeParse(error.code).success)
    return "conflict";
  return "uncertain";
}
function route(path: string, tenantId: string, idName?: string, id?: string) {
  let result = path.replace(":tenantId", encodeURIComponent(tenantId));
  if (idName && id) result = result.replace(`:${idName}`, encodeURIComponent(id));
  return result.replace(/^\/platform(?=\/)/u, "");
}
export async function listDeviceReplacements(tenantId: string) {
  const c = contracts.list;
  return await platformApiFetch(route(c.path, tenantId), { responseSchema: c.response });
}
export async function previewDeviceReplacement(
  tenantId: string,
  deviceId: string,
  body: DeviceReplacementPreviewRequest,
) {
  const c = contracts.preview;
  const request = c.body.parse(body);
  const result = await platformApiFetch(route(c.path, tenantId, "deviceId", deviceId), {
    method: c.method,
    body: JSON.stringify(request),
    responseSchema: c.response,
  });
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
  const result = await platformApiFetch(route(c.path, tenantId, "deviceId", deviceId), {
    method: c.method,
    body: JSON.stringify(request),
    responseSchema: c.response,
  });
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
  const result = await platformApiFetch(route(c.path, tenantId, "preparationId", preparationId), {
    method: c.method,
    body: JSON.stringify(request),
    responseSchema: c.response,
  });
  if (
    result.requestId !== request.requestId ||
    result.preparation.id !== preparationId ||
    result.preparation.state !== "cancelled"
  )
    throw new Error("Replacement response identity mismatch");
  return result;
}
