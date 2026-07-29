import { randomBytes } from "node:crypto";
import { Inject, Injectable } from "@nestjs/common";
import { schema, type Db } from "@markiro/db";
import { and, asc, eq, inArray, isNull, lt, max } from "drizzle-orm";
import { DB } from "../../auth/auth.module";
import { hashDeviceToken } from "../../pickup/device-token";
import type { IntegrationChannelType } from "../integrations/channel-registry";
import { JournalService } from "../integrations/journal.service";

/**
 * A session outlives one exchange, not a day -- an hour is enough for a
 * large catalog uploaded in chunks, and short enough that an abandoned
 * mid-transfer exchange doesn't leave its chunks around forever (спека §3).
 */
export const SESSION_TTL_MS = 3_600_000;

/**
 * Ceiling for one `mode=file` chunk. Doubles as the `limit` passed to
 * `express.raw` in `exchange.module.ts` -- the two must never drift apart,
 * so both read this one constant rather than each hardcoding 512KB.
 */
export const FILE_CHUNK_LIMIT = 512 * 1024;

/**
 * Name of the cookie `checkauth` mints and 1С repeats on every later
 * request. Sent to 1С purely in the plain-text protocol body (`success\n
 * <name>\n<value>`), never as a `Set-Cookie` header -- 1С's "Обмен с
 * сайтом" client is not a browser and does not negotiate cookies; it reads
 * the name and value from the response body and replays them as a `Cookie`
 * request header itself.
 */
export const EXCHANGE_COOKIE_NAME = "mk_1c_session";

export interface OpenedExchangeSession {
  id: string;
  /** Plaintext cookie value -- handed to the caller exactly once, here; only its hash is persisted. */
  cookie: string;
}

export interface ResolvedExchangeSession {
  id: string;
  tenantId: string;
  channelType: IntegrationChannelType;
}

/**
 * A `mode=import` progress marker for one `filename`: how many of its
 * planned rows (price updates, then candidate upserts, in that fixed order --
 * see `exchange.controller.ts`) already made it to the database, PLUS a
 * `fingerprint` of the exact worklist `offset` was measured against.
 *
 * The fingerprint exists because `offset` alone is not enough (review fix):
 * the worklist behind it is rebuilt from scratch every round (a fresh
 * product query, a fresh `decideApplication`), and nothing stops an admin
 * from linking or unlinking a product between two rounds of the SAME
 * filename (1С resubmits `mode=import` verbatim after a `progress` reply).
 * That reshuffles the filtered arrays in a way a bare numeric offset can't
 * detect, so `exchange.controller.ts` compares the stored fingerprint
 * against a freshly computed one every round and restarts the file, loudly,
 * on a mismatch rather than resuming at a now-meaningless position.
 */
export interface ImportCursor {
  offset: number;
  fingerprint: string;
}

/**
 * Same discipline as `hashDeviceToken`: the cookie is 256 bits of randomness
 * from `randomBytes`, not a low-entropy secret a dump could brute force
 * offline, so a plain unkeyed sha256 is enough -- no salt/pepper needed.
 * Reusing the existing primitive rather than re-implementing the same three
 * lines under a new name.
 */
const hashExchangeCookie = hashDeviceToken;

/**
 * Pulls the exchange session cookie's value out of a raw `Cookie` request
 * header. No `cookie-parser` middleware is installed (nothing else in this
 * API needs one -- see `EXCHANGE_COOKIE_NAME`'s comment: 1С is not a
 * browser), so this is the one place that understands the wire format.
 */
export function extractExchangeCookie(header: string | undefined): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const sep = part.indexOf("=");
    if (sep < 0) continue;
    if (part.slice(0, sep).trim() === EXCHANGE_COOKIE_NAME) {
      return part.slice(sep + 1).trim();
    }
  }
  return null;
}

@Injectable()
export class ExchangeSessionService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly journal: JournalService,
  ) {}

  /**
   * Opens a session for `tenantId`/`channelType` and mints its cookie.
   * Delegates the row itself to `JournalService.openSession` -- it already
   * owns `integrationSessions` -- and hands back the one and only plaintext
   * copy of the cookie; the DB only ever sees `cookieHash`.
   */
  async open(
    tenantId: string,
    channelType: IntegrationChannelType,
  ): Promise<OpenedExchangeSession> {
    const cookie = randomBytes(32).toString("base64url");
    const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
    const { id } = await this.journal.openSession(tenantId, channelType, {
      cookieHash: hashExchangeCookie(cookie),
      expiresAt,
    });
    return { id, cookie };
  }

  /**
   * Looks up the live session behind a presented cookie. `null` covers three
   * cases identically, on purpose -- a caller presenting a bad cookie must
   * not be able to distinguish "never existed" from "expired" from
   * "finished" by the response: no row, an expired `expiresAt`, and a
   * non-null `finishedAt`. The last one matters because `finishSession`
   * (called only by `sweepExpired` below, since Fix 1 -- no route handler
   * calls it any more) is a terminal for the session's event stream -- an
   * event appended after close can be pruned along with the session -- so a
   * step running against an already-finished session would be building on a
   * foundation retention is free to erase. Treat it as gone, the same as an
   * unknown cookie.
   */
  async resolve(cookie: string): Promise<ResolvedExchangeSession | null> {
    const cookieHash = hashExchangeCookie(cookie);
    const [row] = await this.db
      .select()
      .from(schema.integrationSessions)
      .where(eq(schema.integrationSessions.cookieHash, cookieHash));
    if (!row) return null;
    if (row.finishedAt) return null;
    if (row.expiresAt.getTime() <= Date.now()) return null;
    return {
      id: row.id,
      tenantId: row.tenantId,
      channelType: row.channelType as IntegrationChannelType,
    };
  }

  /**
   * Appends one chunk of `filename` within `sessionId`. The protocol carries
   * no explicit chunk number -- only the order the POSTs arrive in -- so one
   * is assigned here: one past the highest already stored for this
   * (sessionId, filename) pair. 1С posts a file's chunks sequentially, never
   * concurrently, so there is no race to close on this read-then-insert.
   */
  async appendChunk(
    tenantId: string,
    sessionId: string,
    filename: string,
    body: Buffer,
  ): Promise<void> {
    const [existing] = await this.db
      .select({ max: max(schema.exchangeUploads.chunk) })
      .from(schema.exchangeUploads)
      .where(
        and(
          eq(schema.exchangeUploads.sessionId, sessionId),
          eq(schema.exchangeUploads.filename, filename),
        ),
      );
    const chunk = (existing?.max ?? -1) + 1;
    await this.db
      .insert(schema.exchangeUploads)
      .values({ tenantId, sessionId, filename, chunk, body });
  }

  /**
   * Concatenates every stored chunk of `filename` back into the original
   * byte stream, in chunk order. Not called anywhere yet -- parsing and
   * applying the assembled file is later work (`mode=import`) -- but the
   * transport that stores the chunks is this task's job, so the method that
   * un-does the chunking belongs next to it.
   */
  async assemble(sessionId: string, filename: string): Promise<Buffer> {
    const rows = await this.db
      .select({ body: schema.exchangeUploads.body })
      .from(schema.exchangeUploads)
      .where(
        and(
          eq(schema.exchangeUploads.sessionId, sessionId),
          eq(schema.exchangeUploads.filename, filename),
        ),
      )
      .orderBy(asc(schema.exchangeUploads.chunk));
    return Buffer.concat(rows.map((r) => r.body));
  }

  /**
   * Reads the cursor for `filename` within `sessionId`. `null` when nothing
   * has been recorded yet -- either the very first `mode=import` call for
   * this filename, or a filename this session never touched.
   *
   * Piggybacks on `integrationSessions.summary` rather than a new column:
   * that jsonb field is otherwise write-only until `JournalService.
   * finishSession` sets the FINAL summary and closes the session for good.
   * A live session (this method's only caller) and a finished one are
   * mutually exclusive states of the same row -- `resolve()` already treats
   * `finishedAt` as "gone" -- so scratch progress here can never be
   * confused with, or overwritten by, the terminal summary.
   */
  async readImportCursor(sessionId: string, filename: string): Promise<ImportCursor | null> {
    const [row] = await this.db
      .select({ summary: schema.integrationSessions.summary })
      .from(schema.integrationSessions)
      .where(eq(schema.integrationSessions.id, sessionId));
    const cursors = row?.summary?.["importCursors"] as Record<string, ImportCursor> | undefined;
    return cursors?.[filename] ?? null;
  }

  /**
   * Records how far `mode=import` got for `filename` within `sessionId`, so
   * the next `import` call for the SAME filename (1С repeats it verbatim
   * after a `progress` reply) resumes instead of redoing already-applied
   * rows. Merges into whatever scratch state is already there rather than
   * overwriting `summary` wholesale -- a session could in principle be
   * mid-import on more than one filename at once (Fix 1 makes this the
   * normal case: one `checkauth` session now carries every file 1С sends,
   * not just the first).
   */
  async writeImportCursor(
    sessionId: string,
    filename: string,
    cursor: ImportCursor,
  ): Promise<void> {
    const [row] = await this.db
      .select({ summary: schema.integrationSessions.summary })
      .from(schema.integrationSessions)
      .where(eq(schema.integrationSessions.id, sessionId));
    const summary = { ...(row?.summary ?? {}) };
    const cursors = { ...((summary["importCursors"] as Record<string, ImportCursor>) ?? {}) };
    cursors[filename] = cursor;
    summary["importCursors"] = cursors;
    await this.db
      .update(schema.integrationSessions)
      .set({ summary })
      .where(eq(schema.integrationSessions.id, sessionId));
  }

  /**
   * Closes sessions whose TTL ran out, along with purging their chunks, so a
   * transfer that never resumes doesn't leave large binary rows in Postgres
   * forever. Targets `finishedAt is null AND expiresAt < now`.
   *
   * This is now (Fix 1) the ONLY place a session ever finishes. CommerceML's
   * "Обмен с сайтом" protocol has no explicit goodbye (спека §3): 1С just
   * stops calling once it has nothing left to send. `exchange.controller.ts`
   * used to call `JournalService.finishSession` the moment any ONE file's
   * `mode=import` finished -- which killed the cookie before a second file in
   * the SAME exchange (offers.xml after import.xml is the common case) could
   * ever be uploaded. A session must outlive each individual file; only
   * running out of time (this method) or never having existed can end it.
   *
   * The outcome recorded is derived, not assumed: "error" if this session
   * ever journaled an `outcome: "error"` event, "ok" otherwise. Plain silence
   * -- no error, just no more files -- is the ordinary, successful end of an
   * exchange under this protocol, not a failure, so it must not default to
   * "error" just because nothing ever explicitly said "done".
   *
   * The session ROW itself is no longer deleted here -- only finished, same
   * as any other completed session. `JournalService.prune`'s existing
   * 90-day-from-`finishedAt` retention removes it later, exactly like every
   * other session that ever finishes; a session that merely timed out has no
   * reason to get a shorter, second retention rule of its own. Chunks
   * (`exchangeUploads`) are still deleted unconditionally: they are the
   * actual bytes this TTL exists to bound (see `SESSION_TTL_MS`'s own
   * comment), and once a session is finished nothing will ever `assemble()`
   * them again regardless of outcome.
   *
   * Not wired to a scheduled job by this task -- like `JournalService.prune`,
   * that's Task 16's job; this only needs to exist and be correct.
   */
  async sweepExpired(now: Date): Promise<void> {
    const expired = await this.db
      .select({
        id: schema.integrationSessions.id,
        tenantId: schema.integrationSessions.tenantId,
      })
      .from(schema.integrationSessions)
      .where(
        and(
          isNull(schema.integrationSessions.finishedAt),
          lt(schema.integrationSessions.expiresAt, now),
        ),
      );
    if (expired.length === 0) return;

    for (const session of expired) {
      const [errorEvent] = await this.db
        .select({ id: schema.integrationEvents.id })
        .from(schema.integrationEvents)
        .where(
          and(
            eq(schema.integrationEvents.sessionId, session.id),
            eq(schema.integrationEvents.outcome, "error"),
          ),
        )
        .limit(1);
      await this.journal.finishSession(session.tenantId, session.id, errorEvent ? "error" : "ok", {
        reason: "expired",
      });
    }

    const ids = expired.map((row) => row.id);
    await this.db
      .delete(schema.exchangeUploads)
      .where(inArray(schema.exchangeUploads.sessionId, ids));
  }
}
