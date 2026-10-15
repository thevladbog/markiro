import {
  standaloneSupportPayloadSchema,
  type StandaloneSupportPayload,
} from "@markiro/platform-contracts";

const FUTURE_TOLERANCE_MS = 24 * 60 * 60 * 1000;
/** Before this no app of ours existed; below year 1 PostgreSQL would refuse the instant with a 500. */
const EARLIEST_GENERATED_MS = Date.UTC(2000, 0, 1);

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
  const generated = Date.parse(parsed.data.generatedAt);
  if (!(generated >= EARLIEST_GENERATED_MS)) return { ok: false, reason: "payload_invalid" };
  if (generated > now.getTime() + FUTURE_TOLERANCE_MS)
    return { ok: false, reason: "generated_in_future" };
  return { ok: true, payload: parsed.data };
}
