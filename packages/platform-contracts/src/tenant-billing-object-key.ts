import { platformTenantIdSchema, platformUuidSchema } from "./primitives.js";

const ACT_OBJECT_KEY_PREFIX = "tenant-billing";

export function tenantBillingActObjectKey(
  tenantId: string,
  actId: string,
  documentId: string,
): string {
  const canonicalTenantId = platformTenantIdSchema.parse(tenantId);
  const canonicalActId = platformUuidSchema.parse(actId);
  const canonicalDocumentId = platformUuidSchema.parse(documentId);
  return `${ACT_OBJECT_KEY_PREFIX}/${canonicalTenantId}/acts/${canonicalActId}/${canonicalDocumentId}.pdf`;
}

export function parseTenantBillingActObjectKey(
  key: string,
): { tenantId: string; actId: string; documentId: string } | null {
  const match = /^tenant-billing\/([^/]+)\/acts\/([^/]+)\/([^/]+)\.pdf$/.exec(key);
  if (!match) return null;
  const tenant = platformTenantIdSchema.safeParse(match[1]);
  const act = platformUuidSchema.safeParse(match[2]);
  const document = platformUuidSchema.safeParse(match[3]);
  if (!tenant.success || !act.success || !document.success) return null;
  const canonical = tenantBillingActObjectKey(tenant.data, act.data, document.data);
  if (key !== canonical) return null;
  return { tenantId: tenant.data, actId: act.data, documentId: document.data };
}
