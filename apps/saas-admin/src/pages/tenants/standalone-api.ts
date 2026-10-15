import {
  platformStandaloneLicenseContracts as contracts,
  platformUuidSchema,
  standaloneOpaqueIdSchema,
  standaloneSiteInspectRequestSchema,
  type StandaloneIssuanceConfirm,
  type StandaloneIssuanceList,
  type StandaloneIssuancePreview,
  type StandaloneIssuancePreviewRequest,
  type StandaloneLicenseFile,
  type StandaloneSite,
  type StandaloneSiteInspectRequest,
  type StandaloneSiteInspection,
  type StandaloneSiteList,
  type StandaloneSiteRegister,
} from "@markiro/platform-contracts";

import { platformApiFetch } from "../../api/client.js";

export type ActivationRequest = StandaloneSiteInspectRequest["request"];
/** An activation request is a few hundred bytes; anything above 64 KiB is not one. */
export const MAX_ACTIVATION_REQUEST_BYTES = 64 * 1024;

export class ActivationFileError extends Error {
  readonly reason: "too_large" | "not_json" | "invalid";
  constructor(reason: "too_large" | "not_json" | "invalid") {
    super(`activation_request_${reason}`);
    this.name = "ActivationFileError";
    this.reason = reason;
  }
}

function platformPath(template: string, params: Record<string, string>): string {
  let path = template.replace(/^\/platform/u, "");
  for (const [name, value] of Object.entries(params))
    path = path.replace(`:${name}`, encodeURIComponent(value));
  return path;
}

function tenant(tenantId: string) {
  return { tenantId: standaloneOpaqueIdSchema.parse(tenantId) };
}

function site(tenantId: string, siteId: string) {
  return { ...tenant(tenantId), siteId: platformUuidSchema.parse(siteId) };
}

export function getStandaloneSites(tenantId: string): Promise<StandaloneSiteList> {
  return platformApiFetch(platformPath(contracts.list.path, tenant(tenantId)), {
    responseSchema: contracts.list.response,
  });
}

export function inspectActivationRequest(
  tenantId: string,
  input: StandaloneSiteInspectRequest,
): Promise<StandaloneSiteInspection> {
  return platformApiFetch(platformPath(contracts.inspect.path, tenant(tenantId)), {
    method: contracts.inspect.method,
    responseSchema: contracts.inspect.response,
    body: JSON.stringify(contracts.inspect.body.parse(input)),
  });
}

export function registerStandaloneSite(
  tenantId: string,
  input: StandaloneSiteRegister,
): Promise<StandaloneSite> {
  return platformApiFetch(platformPath(contracts.register.path, tenant(tenantId)), {
    method: contracts.register.method,
    responseSchema: contracts.register.response,
    body: JSON.stringify(contracts.register.body.parse(input)),
  });
}

export function previewStandaloneLicense(
  tenantId: string,
  siteId: string,
  input: StandaloneIssuancePreviewRequest,
): Promise<StandaloneIssuancePreview> {
  return platformApiFetch(platformPath(contracts.previewIssuance.path, site(tenantId, siteId)), {
    method: contracts.previewIssuance.method,
    responseSchema: contracts.previewIssuance.response,
    body: JSON.stringify(contracts.previewIssuance.body.parse(input)),
  });
}

export function confirmStandaloneLicense(
  tenantId: string,
  siteId: string,
  input: StandaloneIssuanceConfirm,
): Promise<StandaloneLicenseFile> {
  return platformApiFetch(platformPath(contracts.confirmIssuance.path, site(tenantId, siteId)), {
    method: contracts.confirmIssuance.method,
    responseSchema: contracts.confirmIssuance.response,
    body: JSON.stringify(contracts.confirmIssuance.body.parse(input)),
  });
}

export function getStandaloneIssuances(
  tenantId: string,
  siteId: string,
): Promise<StandaloneIssuanceList> {
  return platformApiFetch(platformPath(contracts.listIssuances.path, site(tenantId, siteId)), {
    responseSchema: contracts.listIssuances.response,
  });
}

export function downloadStandaloneLicense(
  tenantId: string,
  siteId: string,
  licenseId: string,
): Promise<StandaloneLicenseFile> {
  return platformApiFetch(
    platformPath(contracts.download.path, {
      ...site(tenantId, siteId),
      licenseId: platformUuidSchema.parse(licenseId),
    }),
    { responseSchema: contracts.download.response },
  );
}

/** Reads the host's «Запрос на активацию» file in the browser and validates it before sending. */
export async function readActivationRequestFile(file: Blob): Promise<ActivationRequest> {
  if (file.size > MAX_ACTIVATION_REQUEST_BYTES) throw new ActivationFileError("too_large");
  let value: unknown;
  try {
    value = JSON.parse(await file.text());
  } catch {
    throw new ActivationFileError("not_json");
  }
  const parsed = standaloneSiteInspectRequestSchema.shape.request.safeParse(value);
  if (!parsed.success) throw new ActivationFileError("invalid");
  return parsed.data;
}
