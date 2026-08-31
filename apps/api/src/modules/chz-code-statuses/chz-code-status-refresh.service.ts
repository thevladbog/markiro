import { Inject, Injectable, Logger } from "@nestjs/common";
import { schema, type Db } from "@markiro/db";
import { and, asc, eq, inArray, isNotNull, lte, sql } from "drizzle-orm";

import { DB } from "../../auth/auth.module";
import { ChzTokenService } from "../chz-exports/chz-token.service";
import { CISES_INFO_BATCH_LIMIT, TrueApiClient } from "../chz-exports/true-api.client";
import type { CisInfo, TrueApiAuth } from "../chz-exports/true-api.types";
import { JournalService, type AppendEventInput } from "../integrations/journal.service";
import { CHZ_CHANNEL_TYPE } from "../signer-agents/chz-constants";

/**
 * Codes per `cises/info` call. Tied to the client's own ceiling rather than
 * spelled again: a batch larger than that makes `TrueApiClient.cisesInfo`
 * throw, and two constants that must agree are two constants that can drift.
 */
export const CHZ_STATUS_BATCH_SIZE = CISES_INFO_BATCH_LIMIT;
/** Batches per pass, so one tenant cannot monopolise the worker. */
export const CHZ_STATUS_MAX_BATCHES_PER_PASS = 20;
export const CHZ_STATUS_UNKNOWN_RETRY_LIMIT = 3;

/**
 * The statuses that take a code out of circulation. Its complement — EMITTED,
 * APPLIED, INTRODUCED, DISAGGREGATION and anything ЧЗ adds later — is
 * deliberately not enumerated: see `intervalFor`.
 */
const WITHDRAWN_STATUSES = new Set(["RETIRED", "WITHDRAWN", "WRITTEN_OFF"]);

export const CHZ_STATUS_IN_CIRCULATION_INTERVAL_MS = 24 * 60 * 60_000;
export const CHZ_STATUS_WITHDRAWN_INTERVAL_MS = 30 * 24 * 60 * 60_000;

/**
 * Withdrawn is not terminal — ЧЗ permits returning a code to circulation —
 * so this returns a long interval rather than null. An unrecognised status
 * gets the short one: asking too often is cheap, and quietly losing track of
 * a code is not.
 */
function intervalFor(status: string): number {
  if (WITHDRAWN_STATUSES.has(status)) return CHZ_STATUS_WITHDRAWN_INTERVAL_MS;
  return CHZ_STATUS_IN_CIRCULATION_INTERVAL_MS;
}

export interface ChzCodeStatusRefreshResult {
  /**
   * How many `cises/info` calls this pass made and kept the result of. A
   * batch that stops the pass (`unavailable`/`unauthorized`) also makes a
   * call, but is deliberately not counted here -- see `stopReason` and
   * `refreshBatch`'s own doc for why a batch that touched no rows does not
   * belong in this count.
   */
  batches: number;
  /** Rows ЧЗ stated the facts for, and this pass wrote down. */
  updated: number;
  /** True only when the pass ran out of due rows rather than out of budget or of ЧЗ. */
  caughtUp: boolean;
}

interface FoundRow {
  codeHash: string;
  info: CisInfo;
}

/**
 * Why a batch asked the pass to stop. Carried out of `refreshBatch` rather
 * than collapsed to a boolean so the end-of-pass summary can say the pass
 * did not finish instead of quietly reporting `ok` for a batch that touched
 * no rows.
 */
type StopReason = "unavailable" | "unauthorized";

interface BatchOutcome {
  updated: number;
  unknown: number;
  /**
   * True only for a `rejected` product group: terminal for that group, not
   * for the pass, so it does not set `stopReason` and the loop moves on to
   * the next group -- but it is still something, not an `ok`. Carried out
   * to `run` so the end-of-pass summary can count it (see `rejectedGroups`
   * there).
   */
  rejected: boolean;
  /** Set when the next batch would fail for the same reason; null otherwise. */
  stopReason: StopReason | null;
}

/**
 * Asks ЧЗ what it currently says about the codes in `chz_code_statuses` and
 * writes the answer down. Nothing else: which codes belong in the table is
 * `ChzCodeStatusIngestService`'s decision, and this service never inserts a
 * code of its own.
 *
 * Three things shape the pass:
 *  - `cises/info` takes the product group as a query parameter, so one call
 *    covers exactly one group. A batch is therefore the oldest due row's
 *    group and up to `CHZ_STATUS_BATCH_SIZE` further rows sharing it.
 *  - The table stores a hash, not the raw code (see `chzCodeStatuses`'s doc),
 *    so every batch resolves its raws from `codes` or, failing that, from
 *    `inventory_snapshot_codes` — the two places a raw can live.
 *  - A batch that failed transiently leaves every one of its rows exactly as
 *    it found them. `checkedAt` records the moment ЧЗ stated the facts and
 *    never the moment we asked, so staleness stays visible instead of being
 *    papered over by a timestamp that describes an attempt.
 */
@Injectable()
export class ChzCodeStatusRefreshService {
  private readonly logger = new Logger(ChzCodeStatusRefreshService.name);

  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly tokens: ChzTokenService,
    private readonly client: TrueApiClient,
    private readonly journal: JournalService,
  ) {}

  async run(tenantId: string): Promise<ChzCodeStatusRefreshResult> {
    const token = await this.tokens.getActiveToken(tenantId);
    if (token.status !== "ok") {
      // Nothing else in this pass can proceed without it, and the operator is
      // the only one who can fix any of the four non-`ok` states.
      await this.append(tenantId, {
        outcome: "warn",
        direction: "local",
        grain: "session",
        message: "Статусы кодов Честного Знака не обновлены: нет токена",
        details: { tokenStatus: token.status },
      });
      return { batches: 0, updated: 0, caughtUp: false };
    }

    let batches = 0;
    let updated = 0;
    let unknown = 0;
    let unresolved = 0;
    let rejectedGroups = 0;
    let caughtUp = false;
    let stopReason: StopReason | null = null;

    for (let iteration = 0; iteration < CHZ_STATUS_MAX_BATCHES_PER_PASS; iteration += 1) {
      const productGroupCode = await this.nextDueProductGroup(tenantId);
      if (productGroupCode === null) {
        caughtUp = true;
        break;
      }

      const hashes = await this.dueHashes(tenantId, productGroupCode);
      const { hashByRaw, unresolvable } = await this.resolveRaws(tenantId, hashes);
      if (unresolvable.length > 0) {
        // Unrefreshable whatever ЧЗ would have said, so this is settled
        // before the call rather than after it.
        await this.pushOut(tenantId, unresolvable);
        unresolved += unresolvable.length;
      }
      if (hashByRaw.size === 0) continue;

      const outcome = await this.refreshBatch(tenantId, token.auth, productGroupCode, hashByRaw);
      if (outcome.stopReason !== null) {
        // The batch touched no rows -- it does not belong in `batches`,
        // which counts calls that did work.
        stopReason = outcome.stopReason;
        break;
      }
      batches += 1;
      updated += outcome.updated;
      unknown += outcome.unknown;
      if (outcome.rejected) rejectedGroups += 1;
    }

    if (stopReason === "unauthorized") {
      await this.tokens.invalidateAndRequestRefresh(tenantId, token.obtainedAt);
    }

    // Only when the pass actually did something: a cron tick over a tenant
    // with nothing due is not an event, and journalling it would bury the
    // ones that are. A pass that stopped early is always something, even if
    // it managed zero batches -- reporting `ok` there would tell the
    // operator's channel card that codes were refreshed when none were. The
    // same argument holds for a rejected group: `JournalService.append`
    // overwrites the channel row's `lastOutcome` on every append, so the
    // per-group `warn` written inside the loop above would otherwise be
    // clobbered by this session-grain summary reporting `ok` right after it,
    // leaving the channel card claiming everything worked.
    if (batches > 0 || unresolved > 0 || stopReason !== null) {
      await this.append(tenantId, {
        outcome: stopReason !== null || rejectedGroups > 0 ? "warn" : "ok",
        direction: "out",
        grain: "session",
        message:
          stopReason !== null
            ? "Обновление статусов кодов Честного Знака остановлено раньше срока"
            : rejectedGroups > 0
              ? "Статусы кодов Честного Знака обновлены не полностью"
              : "Обновлены статусы кодов Честного Знака",
        details: { batches, updated, unknown, unresolved, rejectedGroups, stopReason },
      });
    }
    return { batches, updated, caughtUp };
  }

  /**
   * The oldest due row's product group, which the batch below is then built
   * around. Deliberately a second query rather than reading the group off the
   * batch itself: the ingest stamps one `nextRefreshAt` per insert, so due
   * rows of different groups interleave freely, and filtering a
   * `CHZ_STATUS_BATCH_SIZE` window down to its first group would leave most
   * calls carrying a handful of codes each.
   */
  private async nextDueProductGroup(tenantId: string): Promise<number | null> {
    const [head] = await this.db
      .select({ chzProductGroupCode: schema.chzCodeStatuses.chzProductGroupCode })
      .from(schema.chzCodeStatuses)
      .where(this.dueCondition(tenantId))
      .orderBy(asc(schema.chzCodeStatuses.nextRefreshAt))
      .limit(1);
    // The `is not null` in `dueCondition` is what makes the null branch
    // unreachable; drizzle types the column nullable regardless.
    return head?.chzProductGroupCode ?? null;
  }

  private async dueHashes(tenantId: string, productGroupCode: number): Promise<string[]> {
    const rows = await this.db
      .select({ codeHash: schema.chzCodeStatuses.codeHash })
      .from(schema.chzCodeStatuses)
      .where(
        and(
          this.dueCondition(tenantId),
          eq(schema.chzCodeStatuses.chzProductGroupCode, productGroupCode),
        ),
      )
      .orderBy(asc(schema.chzCodeStatuses.nextRefreshAt))
      .limit(CHZ_STATUS_BATCH_SIZE);
    return rows.map((row) => row.codeHash);
  }

  /** Matches `chz_code_statuses_due_idx`, which exists for exactly this shape. */
  private dueCondition(tenantId: string) {
    return and(
      eq(schema.chzCodeStatuses.tenantId, tenantId),
      isNotNull(schema.chzCodeStatuses.chzProductGroupCode),
      lte(schema.chzCodeStatuses.nextRefreshAt, new Date()),
    );
  }

  /**
   * Raw codes come from two places: `codes` holds what the Station scanned,
   * `inventory_snapshot_codes` holds what an ordered export delivered, and a
   * tenant bootstrapped from an export has its codes only in the second. Any
   * one row per hash will do — a hash is a hash of its raw, so every row that
   * carries it carries the same string — and `codes` is preferred as the
   * tenant's own record.
   *
   * The returned map is keyed by raw and valued by hash: the batch is sent as
   * raws and comes back keyed by `cis`, and this is what matches an answer to
   * the row that asked for it. Its insertion order is the batch's order, so
   * the codes are sent oldest-due first.
   */
  private async resolveRaws(
    tenantId: string,
    hashes: string[],
  ): Promise<{ hashByRaw: Map<string, string>; unresolvable: string[] }> {
    const rawByHash = new Map<string, string>();
    if (hashes.length > 0) {
      const scanned = await this.db
        .selectDistinctOn([schema.codes.codeHash], {
          codeHash: schema.codes.codeHash,
          canonicalRaw: schema.codes.canonicalRaw,
        })
        .from(schema.codes)
        .where(and(eq(schema.codes.tenantId, tenantId), inArray(schema.codes.codeHash, hashes)))
        .orderBy(schema.codes.codeHash);
      for (const row of scanned) rawByHash.set(row.codeHash, row.canonicalRaw);

      const missing = hashes.filter((codeHash) => !rawByHash.has(codeHash));
      if (missing.length > 0) {
        const exported = await this.db
          .selectDistinctOn([schema.inventorySnapshotCodes.codeHash], {
            codeHash: schema.inventorySnapshotCodes.codeHash,
            canonicalRaw: schema.inventorySnapshotCodes.canonicalRaw,
          })
          .from(schema.inventorySnapshotCodes)
          .where(
            and(
              eq(schema.inventorySnapshotCodes.tenantId, tenantId),
              inArray(schema.inventorySnapshotCodes.codeHash, missing),
            ),
          )
          .orderBy(schema.inventorySnapshotCodes.codeHash);
        for (const row of exported) rawByHash.set(row.codeHash, row.canonicalRaw);
      }
    }

    const hashByRaw = new Map<string, string>();
    const unresolvable: string[] = [];
    for (const codeHash of hashes) {
      const raw = rawByHash.get(codeHash);
      if (raw === undefined) unresolvable.push(codeHash);
      else hashByRaw.set(raw, codeHash);
    }
    return { hashByRaw, unresolvable };
  }

  private async refreshBatch(
    tenantId: string,
    auth: TrueApiAuth,
    productGroupCode: number,
    hashByRaw: Map<string, string>,
  ): Promise<BatchOutcome> {
    const result = await this.client.cisesInfo(auth, productGroupCode, [...hashByRaw.keys()]);

    if (result.status === "unavailable") {
      // Not one row of this batch is touched, and the pass stops rather than
      // walking the remaining groups into the same unreachable ЧЗ. The
      // end-of-pass summary is what tells the operator this happened -- see
      // `stopReason` there -- so no item/session entry is duplicated here.
      return { updated: 0, unknown: 0, rejected: false, stopReason: "unavailable" };
    }
    if (result.status === "unauthorized") {
      // The same condition as a token we could not load: the tenant's agent
      // has to sign in again before anything else can move. The batch stays
      // due and untouched.
      await this.append(tenantId, {
        outcome: "warn",
        direction: "out",
        grain: "session",
        message: "Статусы кодов Честного Знака не обновлены: нет токена",
        details: { tokenStatus: "unauthorized", productGroupCode },
      });
      return { updated: 0, unknown: 0, rejected: false, stopReason: "unauthorized" };
    }
    if (result.status === "rejected") {
      // Terminal for this group -- a missing contract is not fixed by asking
      // again -- so its rows go far out and the pass moves to the next group.
      await this.pushOut(tenantId, [...hashByRaw.values()]);
      await this.append(tenantId, {
        outcome: "warn",
        direction: "out",
        grain: "item",
        message: "Честный Знак отказал в запросе статусов кодов",
        // ЧЗ's own words, verbatim: the refusal is the operator's to act on.
        details: {
          productGroupCode,
          code: result.code,
          message: result.message,
          codes: hashByRaw.size,
        },
      });
      return { updated: 0, unknown: 0, rejected: true, stopReason: null };
    }

    const infoByCis = new Map(result.value.map((info) => [info.cis, info]));
    const found: FoundRow[] = [];
    const unknownHashes: string[] = [];
    for (const [raw, codeHash] of hashByRaw) {
      const info = infoByCis.get(raw);
      if (info === undefined) unknownHashes.push(codeHash);
      else found.push({ codeHash, info });
    }
    // A `cis` we did not ask about cannot be attributed to a row, so it is
    // dropped -- but not silently: it means the request and the answer
    // disagree about what was asked.
    const unexpected = result.value.filter((info) => !hashByRaw.has(info.cis)).length;
    if (unexpected > 0) {
      await this.append(tenantId, {
        outcome: "warn",
        direction: "in",
        grain: "item",
        message: "Честный Знак ответил о кодах, о которых не спрашивали",
        details: { productGroupCode, unexpected },
      });
    }

    const now = new Date();
    if (found.length > 0) await this.writeFacts(tenantId, productGroupCode, found, now);
    if (unknownHashes.length > 0) await this.countUnknown(tenantId, unknownHashes, now);
    return {
      updated: found.length,
      unknown: unknownHashes.length,
      rejected: false,
      stopReason: null,
    };
  }

  /**
   * One statement for the whole batch. Written as an upsert rather than a
   * loop of updates because ЧЗ's answer differs per row, and a batch is up to
   * `CHZ_STATUS_BATCH_SIZE` rows: that would be a thousand round trips per
   * call. Every row here was selected from this table moments ago, so the
   * insert branch is only reachable if the row disappeared in between — in
   * which case re-creating it with ЧЗ's current answer is what the ingest
   * would have done anyway.
   */
  private async writeFacts(
    tenantId: string,
    productGroupCode: number,
    found: FoundRow[],
    now: Date,
  ): Promise<void> {
    const values = found.map(({ codeHash, info }) => ({
      tenantId,
      codeHash,
      chzProductGroupCode: productGroupCode,
      status: info.status,
      statusEx: info.statusEx,
      ownerInn: info.ownerInn,
      withdrawReason: info.withdrawReason,
      // Reset, not left standing: ЧЗ answered, so whatever run of silence
      // came before it is over.
      unknownAttempts: 0,
      checkedAt: now,
      nextRefreshAt: new Date(now.getTime() + intervalFor(info.status)),
      updatedAt: now,
    }));
    await this.db
      .insert(schema.chzCodeStatuses)
      .values(values)
      .onConflictDoUpdate({
        target: [schema.chzCodeStatuses.tenantId, schema.chzCodeStatuses.codeHash],
        set: {
          // Every fact column is overwritten, nulls included: a code returned
          // to circulation must lose the reason it was withdrawn for.
          status: sql`excluded.status`,
          statusEx: sql`excluded.status_ex`,
          ownerInn: sql`excluded.owner_inn`,
          withdrawReason: sql`excluded.withdraw_reason`,
          unknownAttempts: sql`excluded.unknown_attempts`,
          checkedAt: sql`excluded.checked_at`,
          nextRefreshAt: sql`excluded.next_refresh_at`,
          updatedAt: sql`excluded.updated_at`,
        },
      });
  }

  /**
   * A code ЧЗ had no row for. The facts are left exactly as they were and
   * `checkedAt` is not advanced — there is nothing new to have checked — but
   * the silence is counted, and past `CHZ_STATUS_UNKNOWN_RETRY_LIMIT` the row
   * stops being asked about daily. It is never dropped: an unknown code means
   * it belongs to someone else or is malformed, and that is a fact the
   * operator needs.
   *
   * The count is incremented in SQL rather than from the value read earlier
   * in the pass, so two overlapping passes cannot lose one another's attempt.
   */
  private async countUnknown(tenantId: string, hashes: string[], now: Date): Promise<void> {
    const short = new Date(now.getTime() + CHZ_STATUS_IN_CIRCULATION_INTERVAL_MS);
    const long = new Date(now.getTime() + CHZ_STATUS_WITHDRAWN_INTERVAL_MS);
    await this.db
      .update(schema.chzCodeStatuses)
      .set({
        unknownAttempts: sql`${schema.chzCodeStatuses.unknownAttempts} + 1`,
        nextRefreshAt: sql`case when ${schema.chzCodeStatuses.unknownAttempts} + 1 >= ${CHZ_STATUS_UNKNOWN_RETRY_LIMIT} then ${long}::timestamptz else ${short}::timestamptz end`,
        updatedAt: now,
      })
      .where(
        and(
          eq(schema.chzCodeStatuses.tenantId, tenantId),
          inArray(schema.chzCodeStatuses.codeHash, hashes),
        ),
      );
  }

  /**
   * Out to the long interval with no other change: for a rejected group,
   * because retrying a refusal is what that branch exists to avoid, and for a
   * hash no source can resolve a raw for, because it is unrefreshable by
   * construction rather than failing. Never `null` — the queue is the only
   * record that these codes exist at all.
   */
  private async pushOut(tenantId: string, hashes: string[]): Promise<void> {
    const now = new Date();
    await this.db
      .update(schema.chzCodeStatuses)
      .set({
        nextRefreshAt: new Date(now.getTime() + CHZ_STATUS_WITHDRAWN_INTERVAL_MS),
        updatedAt: now,
      })
      .where(
        and(
          eq(schema.chzCodeStatuses.tenantId, tenantId),
          inArray(schema.chzCodeStatuses.codeHash, hashes),
        ),
      );
  }

  /**
   * A failed audit write is noise, not a reason to abandon a pass: the row
   * changes it describes have already committed and the remaining batches
   * still have requests to make. Same shape as the signer scheduler's expiry
   * loop. The token never appears in `details` — nothing here carries it.
   */
  private async append(
    tenantId: string,
    event: Omit<AppendEventInput, "tenantId" | "channelType" | "sessionId">,
  ): Promise<void> {
    try {
      await this.journal.append({
        tenantId,
        channelType: CHZ_CHANNEL_TYPE,
        sessionId: null,
        ...event,
      });
    } catch (error) {
      this.logger.error(
        `Failed to journal ChZ code status refresh for tenant ${tenantId}`,
        error instanceof Error ? error.stack : undefined,
      );
    }
  }
}
