import { platformTenantIdSchema, platformUuidSchema } from "./primitives.js";

const OBJECT_KEY_PREFIX = "tenant-billing";
const LEGACY_SAFE_TENANT_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const ENCODED_TENANT_SEGMENT = /^~u(?:[0-9a-f]{4}){1,128}$/;

export function tenantBillingActObjectKey(
  tenantId: string,
  actId: string,
  documentId: string,
): string {
  const tenantSegment = tenantBillingTenantKeySegment(tenantId);
  const canonicalActId = platformUuidSchema.parse(actId);
  const canonicalDocumentId = platformUuidSchema.parse(documentId);
  return `${OBJECT_KEY_PREFIX}/${tenantSegment}/acts/${canonicalActId}/${canonicalDocumentId}.pdf`;
}

export function parseTenantBillingActObjectKey(
  key: string,
): { tenantId: string; actId: string; documentId: string } | null {
  const match = /^tenant-billing\/([^/]+)\/acts\/([^/]+)\/([^/]+)\.pdf$/.exec(key);
  if (!match) return null;
  const [, tenantSegment, actValue, documentValue] = match;
  if (!tenantSegment || !actValue || !documentValue) return null;
  const tenantId = parseTenantBillingTenantKeySegment(tenantSegment);
  const act = platformUuidSchema.safeParse(actValue);
  const document = platformUuidSchema.safeParse(documentValue);
  if (tenantId === null || !act.success || !document.success) return null;
  const canonical = tenantBillingActObjectKey(tenantId, act.data, document.data);
  if (key !== canonical) return null;
  return { tenantId, actId: act.data, documentId: document.data };
}

export function tenantBillingRequestAttachmentObjectKey(
  tenantId: string,
  requestId: string,
  attachmentId: string,
): string {
  const tenantSegment = tenantBillingTenantKeySegment(tenantId);
  const canonicalRequestId = platformUuidSchema.parse(requestId);
  const canonicalAttachmentId = platformUuidSchema.parse(attachmentId);
  return `${OBJECT_KEY_PREFIX}/${tenantSegment}/requests/${canonicalRequestId}/${canonicalAttachmentId}`;
}

export function parseTenantBillingRequestAttachmentObjectKey(
  key: string,
): { tenantId: string; requestId: string; attachmentId: string } | null {
  const match = /^tenant-billing\/([^/]+)\/requests\/([^/]+)\/([^/]+)$/.exec(key);
  if (!match) return null;
  const [, tenantSegment, requestValue, attachmentValue] = match;
  if (!tenantSegment || !requestValue || !attachmentValue) return null;
  const tenantId = parseTenantBillingTenantKeySegment(tenantSegment);
  const request = platformUuidSchema.safeParse(requestValue);
  const attachment = platformUuidSchema.safeParse(attachmentValue);
  if (tenantId === null || !request.success || !attachment.success) return null;
  const canonical = tenantBillingRequestAttachmentObjectKey(
    tenantId,
    request.data,
    attachment.data,
  );
  if (key !== canonical) return null;
  return { tenantId, requestId: request.data, attachmentId: attachment.data };
}

export function tenantBillingTenantKeySegment(tenantId: string): string {
  const canonicalTenantId = platformTenantIdSchema.parse(tenantId);
  if (LEGACY_SAFE_TENANT_SEGMENT.test(canonicalTenantId) && !canonicalTenantId.includes("..")) {
    return canonicalTenantId;
  }

  let encoded = "~u";
  for (let index = 0; index < canonicalTenantId.length; index += 1) {
    encoded += canonicalTenantId.charCodeAt(index).toString(16).padStart(4, "0");
  }
  return encoded;
}

function parseTenantBillingTenantKeySegment(segment: string): string | null {
  if (LEGACY_SAFE_TENANT_SEGMENT.test(segment) && !segment.includes("..")) {
    return platformTenantIdSchema.safeParse(segment).success ? segment : null;
  }
  if (!ENCODED_TENANT_SEGMENT.test(segment)) return null;

  let decoded = "";
  for (let index = 2; index < segment.length; index += 4) {
    decoded += String.fromCharCode(Number.parseInt(segment.slice(index, index + 4), 16));
  }
  const tenantId = platformTenantIdSchema.safeParse(decoded);
  if (!tenantId.success || tenantBillingTenantKeySegment(tenantId.data) !== segment) return null;
  return tenantId.data;
}
