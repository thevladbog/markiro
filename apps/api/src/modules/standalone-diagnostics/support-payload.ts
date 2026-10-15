import {
  standaloneSupportPayloadSchema,
  type StandaloneSupportPayload,
} from "@markiro/platform-contracts";

const FUTURE_TOLERANCE_MS = 24 * 60 * 60 * 1000;

export type ParsedSupportPayload =
  | { ok: true; payload: StandaloneSupportPayload }
  | { ok: false; reason: "payload_invalid" | "generated_in_future" };

/**
 * The strict schema (v1 or v2), then the clock rule: the client's clock is the only source of
 * `generatedAt`, so an instant more than a day ahead of the server is cut; the past is accepted.
 */
export function parseSupportPayload(json: unknown, now: Date): ParsedSupportPayload {
  const parsed = standaloneSupportPayloadSchema.safeParse(json);
  if (!parsed.success) return { ok: false, reason: "payload_invalid" };
  if (Date.parse(parsed.data.generatedAt) > now.getTime() + FUTURE_TOLERANCE_MS)
    return { ok: false, reason: "generated_in_future" };
  return { ok: true, payload: parsed.data };
}
