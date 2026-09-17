import { z } from "zod";
import {
  platformDeviceReplacementContracts as contracts,
  type DeviceReplacementPreviewRequest,
  type DeviceReplacementConfirm,
  type DeviceReplacementCancel,
  type DeviceReplacementDrainRequest,
  type DeviceReplacementEmergencyPreviewRequest,
  type DeviceReplacementExecuteRequest,
  type DeviceReplacementRecoveryCloseRequest,
} from "@markiro/platform-contracts";
import { ApiRequestError, platformApiFetch } from "../../api/client.js";
const conflicts = z.enum([
  "device_replacement_inconsistent",
  "device_replacement_source_ineligible",
  "device_replacement_request_conflict",
  "device_replacement_stale",
  "device_replacement_already_prepared",
  "device_replacement_recovery_conflict",
  "device_replacement_facts_unknown",
  "device_replacement_capacity_unavailable",
  "device_replacement_facts_too_large",
  "device_replacement_offline_boundary_unknown",
  "device_replacement_not_ready",
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

export async function requestReplacementDrain(
  tenantId: string,
  preparationId: string,
  body: DeviceReplacementDrainRequest,
) {
  const c = contracts.drain;
  const request = c.body.parse(body);
  const result = await platformApiFetch(route(c.path, tenantId, "preparationId", preparationId), {
    method: c.method,
    body: JSON.stringify(request),
    responseSchema: c.response,
  });
  if (result.requestId !== request.requestId || result.preparation.id !== preparationId)
    throw new Error("Replacement response identity mismatch");
  return result;
}

export async function previewReplacementExecution(
  tenantId: string,
  preparationId: string,
  body: DeviceReplacementDrainRequest,
) {
  const c = contracts.executionPreview;
  const request = c.body.parse(body);
  const result = await platformApiFetch(route(c.path, tenantId, "preparationId", preparationId), {
    method: c.method,
    body: JSON.stringify(request),
    responseSchema: c.response,
  });
  if (
    result.requestId !== request.requestId ||
    result.preparationId !== preparationId ||
    result.expectedRevision !== request.expectedRevision ||
    result.mode !== "normal"
  )
    throw new Error("Replacement response identity mismatch");
  return result;
}

export async function previewEmergencyReplacement(
  tenantId: string,
  preparationId: string,
  body: DeviceReplacementEmergencyPreviewRequest,
) {
  const c = contracts.emergencyPreview;
  const request = c.body.parse(body);
  const result = await platformApiFetch(route(c.path, tenantId, "preparationId", preparationId), {
    method: c.method,
    body: JSON.stringify(request),
    responseSchema: c.response,
  });
  if (
    result.requestId !== request.requestId ||
    result.preparationId !== preparationId ||
    result.expectedRevision !== request.expectedRevision ||
    result.mode !== "emergency"
  )
    throw new Error("Replacement response identity mismatch");
  return result;
}

export async function executeReplacement(
  tenantId: string,
  preparationId: string,
  body: DeviceReplacementExecuteRequest,
) {
  const c = body.mode === "emergency" ? contracts.emergencyExecute : contracts.execute;
  const request = c.body.parse(body);
  const result = await platformApiFetch(route(c.path, tenantId, "preparationId", preparationId), {
    method: c.method,
    body: JSON.stringify(request),
    responseSchema: c.response,
  });
  if (result.requestId !== request.requestId || result.preparation.id !== preparationId)
    throw new Error("Replacement response identity mismatch");
  if (
    result.preparation.execution?.mode !== request.mode ||
    !["executing", "completed"].includes(result.preparation.state)
  )
    throw new Error("Replacement execution mismatch");
  return result;
}

export async function issueReplacementRecoveryCode(
  tenantId: string,
  preparationId: string,
  body: DeviceReplacementDrainRequest,
) {
  const c = contracts.recoveryCode;
  const request = c.body.parse(body);
  const result = await platformApiFetch(route(c.path, tenantId, "preparationId", preparationId), {
    method: c.method,
    body: JSON.stringify(request),
    responseSchema: c.response,
  });
  if (result.requestId !== request.requestId || result.preparation.id !== preparationId)
    throw new Error("Replacement response identity mismatch");
  return result;
}

export async function closeReplacementRecovery(
  tenantId: string,
  preparationId: string,
  body: DeviceReplacementRecoveryCloseRequest,
) {
  const c = contracts.recoveryClose;
  const request = c.body.parse(body);
  const result = await platformApiFetch(route(c.path, tenantId, "preparationId", preparationId), {
    method: c.method,
    body: JSON.stringify(request),
    responseSchema: c.response,
  });
  if (result.requestId !== request.requestId || result.preparation.id !== preparationId)
    throw new Error("Replacement response identity mismatch");
  return result;
}

export async function issueReplacementTargetCode(
  tenantId: string,
  preparationId: string,
  targetDeviceId: string,
  body: DeviceReplacementDrainRequest,
) {
  const c = contracts.targetCode;
  const request = c.body.parse(body);
  const result = await platformApiFetch(route(c.path, tenantId, "preparationId", preparationId), {
    method: c.method,
    body: JSON.stringify(request),
    responseSchema: c.response,
  });
  if (
    result.requestId !== request.requestId ||
    result.preparation.id !== preparationId ||
    result.preparation.execution?.targetDeviceId !== targetDeviceId
  )
    throw new Error("Replacement target identity mismatch");
  return result;
}
