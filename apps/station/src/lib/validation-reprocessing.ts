import {
  VALIDATION_REPROCESSING_PROTOCOL,
  validationCodeHistorySchema,
  validationOccurrenceOutcomeSchema,
  validationOccurrenceStatusSchema,
  type ValidationCodeHistory,
  type ValidationOccurrenceStatus,
} from "@markiro/domain";
import { z } from "zod";
import { StationApiError, type StationClient } from "./api-client.js";
import { AUTHORIZED_CREDENTIAL_OWNERS_SQL } from "./device-recovery.js";
import type { SqlExecutor } from "./mirror.js";

type Occurrence = ValidationOccurrenceStatus["occurrences"][number];

/** One publication statement replaces the complete history in its SQLite trigger. */
export async function refreshValidationHistory(
  exec: SqlExecutor,
  client: Pick<StationClient, "get">,
  shiftId: string,
  productId: string,
  isCurrent: () => boolean = () => true,
): Promise<void> {
  for (let restart = 0; restart < 2; restart++) {
    let publication: ValidationCodeHistory | undefined;
    const items: ValidationCodeHistory["items"] = [];
    const cursors = new Set<string>();
    let cursor: string | null = null;
    try {
      do {
        const query = new URLSearchParams({ limit: "1000" });
        if (publication && cursor) {
          query.set("snapshot", publication.snapshot);
          query.set("cursor", cursor);
        }
        const page = validationCodeHistorySchema.parse(
          await client.get<unknown>(`/shifts/${shiftId}/code-history?${query.toString()}`),
        );
        if (!isCurrent()) return;
        if (
          page.shiftId !== shiftId ||
          page.productId !== productId ||
          page.complete !== (page.nextCursor === null) ||
          (!page.complete && !page.nextCursor) ||
          (publication &&
            (page.snapshot !== publication.snapshot ||
              page.fetchedAt !== publication.fetchedAt ||
              page.expiresAt !== publication.expiresAt)) ||
          (page.nextCursor !== null && cursors.has(page.nextCursor))
        )
          throw new Error("Invalid validation history publication");
        publication ??= page;
        items.push(...page.items);
        cursor = page.nextCursor;
        if (cursor !== null) cursors.add(cursor);
      } while (cursor !== null);
      if (!publication || !isCurrent()) return;
      await exec.run(
        `INSERT INTO validation_history_publications(shift_id,product_id,snapshot,fetched_at,expires_at,items_json)
         VALUES(?,?,?,?,?,?) ON CONFLICT(shift_id) DO UPDATE SET
         product_id=excluded.product_id,snapshot=excluded.snapshot,fetched_at=excluded.fetched_at,
         expires_at=excluded.expires_at,items_json=excluded.items_json`,
        [
          shiftId,
          productId,
          publication.snapshot,
          publication.fetchedAt,
          publication.expiresAt,
          JSON.stringify(items),
        ],
      );
      return;
    } catch (error) {
      if (
        restart === 0 &&
        error instanceof StationApiError &&
        error.status === 409 &&
        error.code === "VALIDATION_HISTORY_EXPIRED"
      )
        continue;
      throw error;
    }
  }
}

export function parseValidationOutcomes(value: unknown): Occurrence[] {
  return z.array(validationOccurrenceOutcomeSchema).parse(value);
}

/** Apply before scan acknowledgement. Replays and lost replies are harmless; evidence is retained. */
export async function applyValidationOutcomes(
  exec: SqlExecutor,
  credentialOwnership: string,
  outcomes: readonly Occurrence[],
): Promise<void> {
  const validated = validationOccurrenceStatusSchema.parse({
    protocol: VALIDATION_REPROCESSING_PROTOCOL,
    occurrences: outcomes,
  });
  for (const outcome of validated.occurrences) {
    await exec.run(
      `UPDATE validation_occurrences SET outcome=?,receipt_outcome=CASE WHEN ?='pending' THEN receipt_outcome ELSE ? END,
         ownership_released=CASE WHEN ?=1 THEN 1 ELSE ownership_released END
       WHERE credential_ownership IN (${AUTHORIZED_CREDENTIAL_OWNERS_SQL}) AND shift_id=? AND code_hash=?
         AND julianday(scanned_at)=julianday(?) AND outcome<>'conflict' AND (ownership_released=0 OR ?='conflict')`,
      [
        outcome.outcome,
        outcome.outcome,
        outcome.outcome,
        outcome.ownership === "released" ? 1 : 0,
        credentialOwnership,
        outcome.shiftId,
        outcome.codeHash,
        outcome.scannedAt,
        outcome.outcome,
      ],
    );
  }
}

/** Query acknowledged rows too: a later delivered earlier scan can displace an acceptance. */
export async function reconcileValidationOccurrences(
  exec: SqlExecutor,
  client: Pick<StationClient, "post">,
  credentialOwnership: string,
  isCurrent: () => boolean,
): Promise<void> {
  let afterShift = "";
  let afterHash = "";
  for (;;) {
    const occurrences = await exec.all<{ shiftId: string; codeHash: string; scannedAt: string }>(
      `SELECT shift_id AS shiftId,code_hash AS codeHash,scanned_at AS scannedAt FROM validation_occurrences
       WHERE credential_ownership IN (${AUTHORIZED_CREDENTIAL_OWNERS_SQL})
         AND (shift_id>? OR (shift_id=? AND code_hash>?)) ORDER BY shift_id,code_hash LIMIT 500`,
      [credentialOwnership, afterShift, afterShift, afterHash],
    );
    if (occurrences.length === 0 || !isCurrent()) return;
    const response = validationOccurrenceStatusSchema.parse(
      await client.post<unknown>("/station/validation-occurrences/status", { occurrences }),
    );
    if (!isCurrent()) return;
    const key = (value: { shiftId: string; codeHash: string; scannedAt: string }) =>
      `${value.shiftId}/${value.codeHash}/${Date.parse(value.scannedAt)}`;
    const requested = new Set(occurrences.map(key));
    const received = new Set(response.occurrences.map(key));
    if (
      received.size !== requested.size ||
      response.occurrences.length !== requested.size ||
      response.occurrences.some((value) => !requested.has(key(value)))
    )
      throw new Error("Invalid validation occurrence receipt");
    await applyValidationOutcomes(exec, credentialOwnership, response.occurrences);
    const last = occurrences.at(-1);
    if (!last) return;
    afterShift = last.shiftId;
    afterHash = last.codeHash;
  }
}

export async function readValidationProcessingState(exec: SqlExecutor, shiftId: string) {
  const [state] = await exec.all<{
    fetchedAt: string | null;
    pending: number;
    conflicts: number;
    processed: number;
  }>(
    `SELECT (SELECT fetched_at FROM validation_history_publications WHERE shift_id=?) AS fetchedAt,
       (SELECT COUNT(*) FROM validation_occurrences WHERE shift_id=? AND outcome='pending') AS pending,
       (SELECT COUNT(*) FROM validation_occurrences WHERE shift_id=? AND outcome='conflict') AS conflicts,
       (SELECT COUNT(*) FROM station_processed_codes WHERE shift_id=?) AS processed`,
    [shiftId, shiftId, shiftId, shiftId],
  );
  return state ?? { fetchedAt: null, pending: 0, conflicts: 0, processed: 0 };
}

/** Explains the durable refusal without exposing raw KM or identifiers. */
export async function readValidationRejectionReason(
  exec: SqlExecutor,
  shiftId: string,
  codeHash: string,
): Promise<"current" | "active" | "previous" | "unconfirmed"> {
  const [row] = await exec.all<{ reason: "current" | "active" | "previous" | "unconfirmed" }>(
    `SELECT CASE
      WHEN EXISTS(SELECT 1 FROM validation_occurrences WHERE shift_id=? AND code_hash=?)
        OR EXISTS(SELECT 1 FROM validation_code_history WHERE shift_id=? AND code_hash=? AND source_shift_id=?)
        OR EXISTS(SELECT 1 FROM codes_mirror WHERE shift_id=? AND code_hash=?) THEN 'current'
      WHEN EXISTS(SELECT 1 FROM validation_code_history WHERE shift_id=? AND code_hash=? AND shift_status<>'closed')
        OR EXISTS(SELECT 1 FROM validation_occurrences other
         JOIN station_processed_codes effective ON effective.shift_id=other.shift_id AND effective.code_hash=other.code_hash
         LEFT JOIN shift_mirror shift ON shift.id=other.shift_id WHERE other.code_hash=? AND other.shift_id<>? AND other.outcome<>'conflict' AND COALESCE(shift.status,'active')<>'closed'
           AND NOT EXISTS(SELECT 1 FROM validation_code_history confirmed WHERE confirmed.shift_id=? AND confirmed.code_hash=other.code_hash AND confirmed.kind='original' AND confirmed.source_shift_id=other.shift_id AND confirmed.shift_status='closed')) THEN 'active'
      WHEN COALESCE((SELECT json_extract(validation_print_context,'$.policy.allowPreviouslyAcceptedCodes') FROM shift_mirror WHERE id=?),0)=0 THEN 'previous'
      ELSE 'unconfirmed' END AS reason`,
    [
      shiftId,
      codeHash,
      shiftId,
      codeHash,
      shiftId,
      shiftId,
      codeHash,
      shiftId,
      codeHash,
      codeHash,
      shiftId,
      shiftId,
      shiftId,
    ],
  );
  return row?.reason ?? "unconfirmed";
}
