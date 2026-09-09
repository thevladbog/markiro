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
// UTF-16 code units, not network bytes. Covers the existing 9,001,024-byte
// import body bound plus the small intent envelope; browser quota may be lower.
// Persistence still must round-trip exactly before any POST can proceed.
const MAX_SERIALIZED_CHARACTERS = 9_002_048;
export type IntentState =
  | { status: "missing" }
  | { status: "valid"; intent: PendingIntent }
  | { status: "corrupt" }
  | { status: "unavailable" };
export function loadIntent(identity: string, sessionId: string): IntentState {
  let raw: string | null;
  try {
    raw = sessionStorage.getItem(key(identity, sessionId));
  } catch {
    return { status: "unavailable" };
  }
  if (raw === null) return { status: "missing" };
  if (raw.length > MAX_SERIALIZED_CHARACTERS) return { status: "corrupt" };
  let intent: PendingIntent;
  try {
    intent = intentSchema.parse(JSON.parse(raw));
  } catch {
    return { status: "corrupt" };
  }
  if (intent.sessionId !== sessionId) return { status: "corrupt" };
  if (intent.kind === "prepare" && Date.parse(intent.expiresAt) <= Date.now()) {
    try {
      abandonIntent(identity, sessionId);
      return { status: "missing" };
    } catch {
      return { status: "unavailable" };
    }
  }
  return { status: "valid", intent };
}
/** Deliberate local abandonment must prove removal before admitting another intent. */
export function abandonIntent(identity: string, sessionId: string) {
  sessionStorage.removeItem(key(identity, sessionId));
  if (sessionStorage.getItem(key(identity, sessionId)) !== null)
    throw new Error("storage_unavailable");
}
export function saveIntent(identity: string, intent: PendingIntent) {
  const parsed = intentSchema.parse(intent);
  const existing = loadIntent(identity, intent.sessionId);
  if (existing.status === "corrupt" || existing.status === "unavailable")
    throw new Error("storage_unavailable");
  if (existing.status === "valid" && JSON.stringify(existing.intent) !== JSON.stringify(parsed))
    throw new Error("unresolved_intent");
  const raw = JSON.stringify(parsed);
  if (raw.length > MAX_SERIALIZED_CHARACTERS) throw new Error("storage_unavailable");
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
