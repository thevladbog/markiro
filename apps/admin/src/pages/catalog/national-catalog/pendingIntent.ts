import { z } from "zod";
import { importApplySchema, importPrepareSchema } from "@markiro/platform-contracts";
const prefix = "markiro.nc.pending.v1:";
const common = { version: z.literal(1), sessionId: z.uuid(), expiresAt: z.iso.datetime() };
const intentSchema = z.discriminatedUnion("kind", [
  z.object({ ...common, kind: z.literal("prepare"), body: importPrepareSchema }).strict(),
  z.object({ ...common, kind: z.literal("apply"), body: importApplySchema }).strict(),
]);
export type PendingIntent = z.infer<typeof intentSchema>;
export const identityKey = (tenant: string, user: string) =>
  `${encodeURIComponent(tenant)}:${encodeURIComponent(user)}:`;
const key = (identity: string, sessionId: string) => `${prefix}${identity}${sessionId}`;
const MAX_BYTES = 200_000;
export function loadIntent(identity: string, sessionId: string): PendingIntent | null {
  try {
    const raw = sessionStorage.getItem(key(identity, sessionId));
    if (!raw) return null;
    if (raw.length > MAX_BYTES) throw new Error("invalid_intent");
    const intent = intentSchema.parse(JSON.parse(raw));
    if (
      intent.sessionId !== sessionId ||
      (intent.kind === "prepare" && Date.parse(intent.expiresAt) <= Date.now())
    ) {
      clearIntent(identity, sessionId);
      return null;
    }
    return intent;
  } catch {
    clearIntent(identity, sessionId);
    return null;
  }
}
export function saveIntent(identity: string, intent: PendingIntent) {
  const parsed = intentSchema.parse(intent);
  const existing = loadIntent(identity, intent.sessionId);
  if (existing && JSON.stringify(existing) !== JSON.stringify(parsed))
    throw new Error("unresolved_intent");
  const raw = JSON.stringify(parsed);
  if (raw.length > MAX_BYTES) throw new Error("storage_unavailable");
  sessionStorage.setItem(key(identity, intent.sessionId), raw);
  if (sessionStorage.getItem(key(identity, intent.sessionId)) !== raw)
    throw new Error("storage_unavailable");
}
export function clearIntent(identity: string, sessionId: string) {
  try {
    sessionStorage.removeItem(key(identity, sessionId));
  } catch {
    /* Storage can be blocked. No mutation proceeds without verified persistence. */
  }
}
export function clearIdentityIntents(identity: string) {
  try {
    const keys = Object.keys(sessionStorage).filter((k) => k.startsWith(`${prefix}${identity}`));
    keys.forEach((k) => sessionStorage.removeItem(k));
  } catch {
    /* No other application storage is touched. */
  }
}

const ownerKey = "markiro.nc.pending.owner.v1";
export function readIntentOwner(): string | null | undefined {
  try {
    const raw = sessionStorage.getItem(ownerKey);
    if (raw === null) return undefined;
    const parsed: unknown = JSON.parse(raw);
    return parsed === null || (typeof parsed === "string" && parsed.length < 2000)
      ? parsed
      : undefined;
  } catch {
    return undefined;
  }
}
export function writeIntentOwner(identity: string | null) {
  try {
    sessionStorage.setItem(ownerKey, JSON.stringify(identity));
  } catch {
    /* Pending POST persistence has its own mandatory write/verify gate. */
  }
}
