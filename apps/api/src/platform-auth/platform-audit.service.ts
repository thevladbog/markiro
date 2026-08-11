import { Injectable } from "@nestjs/common";
import { schema, type Db, type PlatformRole } from "@markiro/db";

export interface PlatformAuditEvent {
  actorPlatformUserId: string | null;
  actorRole: PlatformRole | null;
  action: string;
  outcome: string;
  tenantId: string | null;
  targetType: string;
  targetId: string | null;
  reason: string | null;
  before: unknown;
  after: unknown;
  requestId: string | null;
}

export type PlatformAuditTransaction = Pick<Db, "insert">;

const SECRET_KEY_PATTERN =
  /(password|secret|token|session|cookie|authorization|credential|backup.?codes?)/i;
const FINANCIAL_KEY_PATTERN = /(amount|price|offer|payment|billing|currency|cost|invoice|tax)/i;
const MAX_METADATA_DEPTH = 4;
const MAX_METADATA_KEYS = 50;
const MAX_METADATA_ARRAY_ITEMS = 50;
const MAX_METADATA_STRING_LENGTH = 1_024;

@Injectable()
export class PlatformAuditService {
  async record(tx: PlatformAuditTransaction, event: PlatformAuditEvent): Promise<void> {
    await tx.insert(schema.platformAuditEvents).values({
      actorPlatformUserId: event.actorPlatformUserId,
      actorRole: event.actorRole,
      action: event.action,
      outcome: event.outcome,
      tenantId: event.tenantId,
      targetType: event.targetType,
      targetId: event.targetId,
      reason: event.reason,
      before: sanitizeAuditMetadata(event.before),
      after: sanitizeAuditMetadata(event.after),
      requestId: event.requestId,
    });
  }
}

export function sanitizeAuditMetadata(value: unknown, depth = 0): unknown {
  return sanitizeMetadata(value, depth, false);
}

export function sanitizeSupportAuditMetadata(value: unknown): unknown {
  return sanitizeMetadata(value, 0, true);
}

function sanitizeMetadata(value: unknown, depth: number, redactFinancial: boolean): unknown {
  if (value === null || typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value === "string") return value.slice(0, MAX_METADATA_STRING_LENGTH);
  if (depth >= MAX_METADATA_DEPTH) return "[truncated]";
  if (Array.isArray(value)) {
    return value
      .slice(0, MAX_METADATA_ARRAY_ITEMS)
      .map((item) => sanitizeMetadata(item, depth + 1, redactFinancial));
  }
  if (typeof value !== "object") return null;

  const sanitized: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value).slice(0, MAX_METADATA_KEYS)) {
    if (SECRET_KEY_PATTERN.test(key) || (redactFinancial && FINANCIAL_KEY_PATTERN.test(key))) {
      continue;
    }
    sanitized[key] = sanitizeMetadata(item, depth + 1, redactFinancial);
  }
  return sanitized;
}
