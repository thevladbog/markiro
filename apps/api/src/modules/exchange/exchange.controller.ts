import { createHash } from "node:crypto";
import {
  Controller,
  Get,
  Inject,
  Ip,
  Logger,
  Post,
  Query,
  Req,
  Res,
  UseFilters,
} from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import { schema, type Db } from "@markiro/db";
import { and, eq, inArray, isNotNull, isNull } from "drizzle-orm";
import type { Response } from "express";
import { DB } from "../../auth/auth.module";
import type { IntegrationChannelType } from "../integrations/channel-registry";
import { JournalService } from "../integrations/journal.service";
import { PickupOrdersService } from "../pickup-orders/pickup-orders.service";
import { decideApplication, type KnownProduct } from "./commerceml/apply";
import { parseCommerceMl } from "./commerceml/parse";
import { parseOrderStatusDocuments, resolveMappedStatus } from "./commerceml/order-status";
import { buildOrdersDocument, planExport } from "./commerceml/order-export";
import {
  assertUnderCheckauthLimit,
  checkauthWindowStart,
  DUMMY_EXCHANGE_PHC,
  refundCheckauthAttempt,
  verifyExchangeSecret,
} from "./exchange-credentials";
import { ExchangeExceptionFilter, type ExchangeRequest } from "./exchange-exception.filter";
import {
  EXCHANGE_COOKIE_NAME,
  ExchangeSessionService,
  extractExchangeCookie,
  FILE_CHUNK_LIMIT,
  NO_SESSION_MESSAGE,
  rawFailureBody,
  type ResolvedExchangeSession,
} from "./exchange-session.service";

/**
 * Ceiling on how many planned rows (price updates, then candidate upserts)
 * `mode=import` writes to the database in one HTTP round trip. A catalog
 * bigger than this comes back as multiple `progress` replies instead of one
 * long transaction-free write loop -- spec §4.4: "Большой каталог не грузим
 * одной транзакцией". Not tuned against a real large file yet; picked as a
 * number comfortably larger than any fixture in this test suite and small
 * enough that one batch is a bounded amount of work.
 */
export const IMPORT_BATCH_SIZE = 500;

/**
 * Ceiling on how many orders `mode=query` offers in one round -- spec §5's
 * outbound direction, mirroring `IMPORT_BATCH_SIZE`'s own reasoning: an order
 * document is heavier than a single price row, so this batch is smaller.
 * Picked comfortably larger than any fixture in this test suite; not tuned
 * against a real large backlog yet.
 */
export const EXPORT_BATCH_SIZE = 200;

/** One row of the plan this controller actually writes, in a fixed, stable order (see `handleImport`). */
type ImportWorkItem =
  | { kind: "price"; productId: string; unitPrice: string }
  | {
      kind: "candidate";
      externalRef: string;
      name: string;
      article: string | null;
      unit: string | null;
    };

/**
 * Fingerprints a `mode=import` worklist -- its length plus a hash of its
 * ordered keys (`productId` for a price row, `externalRef` for a candidate
 * row) -- so a stored cursor (Fix 2, `ExchangeSessionService.ImportCursor`)
 * can tell whether a later round's freshly rebuilt worklist is still the
 * SAME list its `offset` was measured against. Length alone would miss a
 * swap (one row replaced by another of the same overall count); hashing the
 * keys in order catches that too, at the cost of one cheap hash per round --
 * worklist itself is already rebuilt every round regardless.
 */
function fingerprintOf(worklist: ImportWorkItem[]): string {
  const keys = worklist.map((item) =>
    item.kind === "price" ? `p:${item.productId}` : `c:${item.externalRef}`,
  );
  const hash = createHash("sha256").update(keys.join(" ")).digest("hex");
  return `${worklist.length}:${hash}`;
}

/**
 * The fixed wire text every method below sends the moment ANY query
 * parameter it reads (`mode`, `type`, `filename`) turns out not to be a
 * single string -- see `singleQueryValue`'s own comment for why that can
 * happen at all on a plain `Record<string, unknown>` read off `req.query`.
 */
const REPEATED_PARAM_MESSAGE = "repeated query parameter";

/**
 * `@Query()` below reads `req.query` as `Record<string, unknown>` -- not
 * `Record<string, string>` -- because that is the honest shape Express (via
 * `qs`) actually hands back: a repeated key (`?filename=a.xml&filename=
 * b.xml`, `?type=catalog&type=sale`) comes back `string[]`, not `string`,
 * and bracket syntax (`?filename[x]=y`) comes back a nested object.
 * Something a genuine 1С "Обмен с сайтом" client never sends -- спека §3
 * addresses one value per key, always -- but this route carries neither
 * `TenantGuard` nor `SessionOnlyGuard` (see the class-level comment: it is
 * the one cabinet-adjacent route reachable with no credential at all), so
 * whatever shows up here is externally controlled input a reader cannot
 * assume away.
 *
 * Trusting the old `Record<string, string>` annotation and using `mode`/
 * `type`/`filename` as strings without this check first is exactly the
 * type confusion CodeQL flags: a string method downstream would throw, an
 * `===` mode comparison would just silently never match (masking a real
 * `mode=checkauth` attempt as "no session" instead of naming the actual
 * problem), and handing the array on into something typed `string`
 * (`ExchangeSessionService.appendChunk`/`.assemble`, both `filename:
 * string`) would let a DB driver see a bind value its column was never
 * meant to receive.
 *
 * Returns the value unchanged when it is `undefined` (the key was never
 * sent -- every caller already has its own "missing" handling for that) or
 * a plain `string`. Anything else comes back `null`: a distinct, explicit
 * "tampered" outcome no caller can mistake for "absent", so each one can
 * refuse outright -- the clearer response, per this route's own decision --
 * rather than silently reading the first element or stringifying the whole
 * array into a comparison that was never going to match anyway.
 */
function singleQueryValue(raw: unknown): string | undefined | null {
  if (raw === undefined) return undefined;
  return typeof raw === "string" ? raw : null;
}

/**
 * Names every key in `values` whose `singleQueryValue` result came back
 * `null` -- i.e. every query parameter THIS request repeated (or otherwise
 * mangled into a non-string shape). Centralised so `get()` and `post()`
 * build the same shape of list, and therefore the same journal message,
 * rather than each hand-rolling its own filter.
 */
function repeatedParamKeys(values: Record<string, string | undefined | null>): string[] {
  return Object.entries(values)
    .filter(([, value]) => value === null)
    .map(([key]) => key);
}

/**
 * True exactly when `value` is a genuine Node.js `Buffer` -- the SAME
 * runtime check `Buffer.isBuffer` itself performs, just re-declared as a
 * type predicate IN THIS FILE. `Buffer.isBuffer`'s own `value is Buffer`
 * signature lives in `@types/node`, a library declaration outside the
 * source CodeQL's `js/type-confusion-through-parameter-tampering` query
 * actually reasons about -- so a bare `Buffer.isBuffer(body)` call narrows
 * `body` for TypeScript (see `post()`, `mode === "file"`) but leaves that
 * analysis believing `req.body` (read as `unknown` off `express.raw()`'s
 * output, see exchange.module.ts) could still reach `body.length` as an
 * array or a string. Re-declaring the identical check as a LOCAL predicate
 * makes the narrowing visible to both analyses without changing what the
 * check actually verifies.
 */
function isRequestBuffer(value: unknown): value is Buffer {
  return Buffer.isBuffer(value);
}

/**
 * Fixed wire text `mode=import` sends whenever `parseCommerceMl` throws --
 * never the real parser exception message (`detail`, below), which can
 * carry arbitrary internal detail (a fast-xml-parser message, a byte
 * offset -- in principle anything reachable through `cause`) that this
 * ungated route (see the class-level comment) must not hand an anonymous
 * caller. The real detail still reaches the journal -- in `message`, for
 * the 1С specialist who actually needs it, exactly as `parseXml`'s own
 * comment in commerceml/parse.ts intends -- only the WIRE response and
 * `details.raw` (which brief 08 requires to record exactly what was sent,
 * verbatim) use this constant instead. Same split
 * `ExchangeExceptionFilter.INTERNAL_ERROR_RAW` already holds for its own
 * catch-all, for the same reason.
 */
const IMPORT_PARSE_FAILURE = "invalid file";

/**
 * Constant address 1С's "Обмен с сайтом" client calls (спека §3):
 * `checkauth` -> `init` -> `mode=file` (chunked upload), repeated. Parsing
 * and applying an assembled file (`mode=import`) is later work.
 *
 * Deliberately carries NEITHER `TenantGuard` NOR `SessionOnlyGuard`. This is
 * not an oversight -- it is the one cabinet-adjacent route that cannot use
 * either: the tenant is resolved from the exchange's OWN machine credentials
 * (Basic auth on `checkauth`, then a session cookie this controller itself
 * issues), never from a Better Auth session or a station `x-api-key`. Recorded
 * honestly as an exception in docs/device-key-surface.md rather than left for
 * a reader of that document to wonder whether it was missed.
 *
 * Every response is plain text with a 200 status, on every branch, including
 * failure: 1С parses the BODY, not the status code, and turns any 4xx into an
 * opaque "network error" for the person running the exchange -- hiding the
 * one line (`failure\n<message>`) that would have told them what actually
 * went wrong. `checkauth` succeeds with three lines (`success`, cookie name,
 * cookie value); every other success is mode-specific; everything else is
 * `failure\n<message>`.
 */
@ApiTags("exchange")
@Controller()
@UseFilters(ExchangeExceptionFilter)
export class ExchangeController {
  private readonly logger = new Logger(ExchangeController.name);

  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly sessions: ExchangeSessionService,
    private readonly journal: JournalService,
    private readonly pickupOrders: PickupOrdersService,
  ) {}

  @Get("1c_exchange")
  async get(
    @Query() query: Record<string, unknown>,
    @Req() req: ExchangeRequest,
    @Res() res: Response,
    @Ip() ip: string,
  ): Promise<void> {
    const mode = singleQueryValue(query.mode);
    const type = singleQueryValue(query.type);
    const filename = singleQueryValue(query.filename);

    if (mode === "checkauth") {
      // No tenant is known yet -- credentials haven't even been parsed, the
      // same boundary `!credentials` below draws -- so a tampered `type`
      // here is refused with text and 200, but nothing to journal against.
      if (type === null) {
        this.fail(res, REPEATED_PARAM_MESSAGE);
        return;
      }
      await this.checkauth(type, req, res, ip);
      return;
    }

    const session = await this.resolveSession(req);
    if (!session) {
      this.fail(res, NO_SESSION_MESSAGE);
      return;
    }
    req.exchangeContext = {
      tenantId: session.tenantId,
      channelType: session.channelType,
      sessionId: session.id,
    };

    // Checked as direct `=== null` comparisons, not via a helper call, so
    // TypeScript's control-flow narrowing drops `null` from `mode`/`type`/
    // `filename` below -- every use past this point can stay exactly the
    // `string | undefined` shape it always was.
    if (mode === null || type === null || filename === null) {
      await this.rejectRepeatedParam(session, res, repeatedParamKeys({ mode, type, filename }));
      return;
    }

    if (mode === "init") {
      await this.journal.append({
        tenantId: session.tenantId,
        channelType: session.channelType,
        sessionId: session.id,
        direction: "in",
        outcome: "ok",
        grain: "session",
        message: "init",
        details: { type: type ?? null },
      });
      // `zip=no` in v1 (спека §3): archives are a new dependency and attack
      // surface (zip-bomb) to save bandwidth on a file that is megabytes,
      // not gigabytes. `file_limit` is the SAME ceiling as `FILE_CHUNK_LIMIT`
      // and express.raw's `limit` in exchange.module.ts -- we declare it, so
      // all three read one constant rather than three independent numbers.
      this.text(res, [`zip=no`, `file_limit=${FILE_CHUNK_LIMIT}`].join("\n"));
      return;
    }

    if (mode === "import") {
      await this.import(session, type, filename, res);
      return;
    }

    if (mode === "query") {
      await this.query(session, res);
      return;
    }

    await this.unknownMode(session, mode);
    this.fail(res, "unknown mode");
  }

  @Post("1c_exchange")
  async post(
    @Query() query: Record<string, unknown>,
    @Req() req: ExchangeRequest,
    @Res() res: Response,
  ): Promise<void> {
    const mode = singleQueryValue(query.mode);
    const filename = singleQueryValue(query.filename);

    const session = await this.resolveSession(req);
    if (!session) {
      this.fail(res, NO_SESSION_MESSAGE);
      return;
    }
    req.exchangeContext = {
      tenantId: session.tenantId,
      channelType: session.channelType,
      sessionId: session.id,
    };

    // Direct `=== null` comparisons, not a helper call -- see the matching
    // comment in `get()` for why: it lets TypeScript narrow `mode`/
    // `filename` below back to `string | undefined`.
    if (mode === null || filename === null) {
      await this.rejectRepeatedParam(session, res, repeatedParamKeys({ mode, filename }));
      return;
    }

    if (mode === "file") {
      const body: unknown = req.body;
      if (!filename || !isRequestBuffer(body)) {
        await this.journal.append({
          tenantId: session.tenantId,
          channelType: session.channelType,
          sessionId: session.id,
          direction: "in",
          outcome: "error",
          grain: "session",
          message: "file: отсутствует имя файла или тело запроса",
          details: { filename: filename ?? null, raw: rawFailureBody("missing filename or body") },
        });
        this.fail(res, "missing filename or body");
        return;
      }

      await this.sessions.appendChunk(session.tenantId, session.id, filename, body);
      await this.journal.append({
        tenantId: session.tenantId,
        channelType: session.channelType,
        sessionId: session.id,
        direction: "in",
        outcome: "ok",
        grain: "session",
        message: `file: получен кусок «${filename}»`,
        details: { filename, bytes: body.length },
      });
      this.text(res, "success");
      return;
    }

    if (mode === "success") {
      await this.success(session, res);
      return;
    }

    await this.unknownMode(session, mode);
    this.fail(res, "unknown mode");
  }

  private async checkauth(
    type: string | undefined,
    req: ExchangeRequest,
    res: Response,
    ip: string,
  ): Promise<void> {
    // `source` is the caller's resolved address, the same choice
    // `KioskPairController` makes for `/kiosk/pair` -- and for the same
    // reason: `checkauth` sits behind no gate at all (there is no credential
    // yet to gate on), so the calling address is the only signal available
    // BEFORE login/secret are known. `@Ip()` only resolves to the real
    // client when `TRUST_PROXY_HOPS` is configured for the deployment
    // topology (see main.ts); misconfigured, every caller collapses onto one
    // bucket, same known/accepted degradation as kiosk pairing.
    const source = ip;
    const now = new Date();
    const windowStart = checkauthWindowStart(now);

    // Charged BEFORE the credentials are even looked at, and refunded ONLY
    // after a confirmed success below -- same order as
    // `PairingService.redeem` (pairing.service.ts:178-220), and for the same
    // reason: checking first and charging only on failure would let a
    // targeted flood of wrong guesses against one login evade the budget
    // (each miss is "checked", not "charged", until it style-matches
    // whatever the check verifies), while charging after success without a
    // refund would let the counter itself lock out a working, legitimate
    // exchange over time. Counts every ATTEMPT, not misses on a matched row
    // -- see `assertUnderCheckauthLimit`'s own comment for why a login that
    // matches nothing must still cost budget.
    try {
      await assertUnderCheckauthLimit(this.db, source, windowStart);
    } catch {
      this.fail(res, "too many attempts");
      return;
    }

    const credentials = parseBasicAuth(req.headers.authorization);
    if (!credentials) {
      this.fail(res, "missing credentials");
      return;
    }

    const [row] = await this.db
      .select()
      .from(schema.integrationChannels)
      .where(eq(schema.integrationChannels.credentialLogin, credentials.login));

    // Always runs a full PBKDF2 verification, even when `row` (or its
    // `credentialHash`) doesn't exist -- against `DUMMY_EXCHANGE_PHC` in that
    // case, whose result is discarded either way. A short-circuited `!row ||
    // ...` would skip `verifyExchangeSecret` entirely for an unknown login,
    // answering measurably faster than a known login with a wrong secret --
    // exactly the timing side channel `DUMMY_EXCHANGE_PHC`'s own comment
    // guards against.
    const validSecret = await verifyExchangeSecret(
      credentials.secret,
      row?.credentialHash ?? DUMMY_EXCHANGE_PHC,
    );

    if (!row || !row.credentialHash || !validSecret) {
      // A login that matches no row has no tenant to journal against --
      // there is nowhere to write the event, the same boundary the attempt
      // counter above already draws. A login that DOES match, with a wrong
      // secret, has a known tenant: log it there.
      if (row) {
        await this.journal.append({
          tenantId: row.tenantId,
          channelType: row.type as IntegrationChannelType,
          sessionId: null,
          direction: "in",
          outcome: "error",
          grain: "session",
          message: "checkauth: неверный пароль",
          details: { raw: rawFailureBody("invalid credentials") },
        });
      }
      this.fail(res, "invalid credentials");
      return;
    }

    const channelType = row.type as IntegrationChannelType;
    // Known from here on -- a genuine credential match -- so an unhandled
    // throw below (e.g. `sessions.open` hitting a DB outage) can still be
    // journaled against the right tenant by `ExchangeExceptionFilter`, even
    // though the session itself hasn't opened yet (`sessionId: null`, same
    // as the "неверный пароль" event above).
    req.exchangeContext = { tenantId: row.tenantId, channelType, sessionId: null };

    // `.catch()`ed rather than awaited plain: this runs AFTER the password
    // has already been confirmed correct. If the refund itself throws (a DB
    // hiccup on this one UPDATE), the caller has valid credentials and must
    // still get its session and cookie -- not an exception -- while the
    // checkauth budget simply stays one unit overcharged for the rest of
    // this window. Mirrors `PairingService.redeem`'s own compensating
    // refund (`pairing.service.ts:204-220`), which swallows exactly the same
    // failure for exactly the same reason: the alternative would let a
    // successful, correctly-credentialed login fail outright over pure
    // bookkeeping.
    await refundCheckauthAttempt(this.db, source, windowStart).catch((error: unknown) => {
      this.logger.warn(
        `exchange checkauth refund failed after verified credentials (budget stays overcharged): ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    });

    const opened = await this.sessions.open(row.tenantId, channelType);
    req.exchangeContext = { tenantId: row.tenantId, channelType, sessionId: opened.id };
    await this.journal.append({
      tenantId: row.tenantId,
      channelType,
      sessionId: opened.id,
      direction: "in",
      outcome: "ok",
      grain: "session",
      message: "checkauth: сеанс открыт",
      details: { type: type ?? null },
    });

    this.text(res, ["success", EXCHANGE_COOKIE_NAME, opened.cookie].join("\n"));
  }

  /**
   * `mode=import`: assembles `filename`'s chunks (Task 6), parses them ONCE
   * as BOTH a catalog and an offer pack (Task 7 / Fix 3 -- whichever section
   * a given file actually carries wins; the other simply comes back empty,
   * so this never has to guess a file's kind from its name), decides what to
   * apply (Task 8), then writes that decision to the database: prices only,
   * and candidates by upsert. Never silent: every skipped offer and every
   * offer for a product this connection hasn't linked yet is journaled, and
   * each file's outcome lands as a journal event of its own (Fix 1) --
   * NEVER by finishing the session. A real CommerceML exchange sends more
   * than one file (nomenclature, then offers/prices) through the SAME
   * `checkauth` session; ending the session the moment one file finishes
   * would strand every file after the first with a cookie that now resolves
   * to nothing. Only `ExchangeSessionService.sweepExpired` (TTL) ever
   * finishes a session -- see its own comment.
   */
  private async import(
    session: ResolvedExchangeSession,
    type: string | undefined,
    filename: string | undefined,
    res: Response,
  ): Promise<void> {
    if (!filename) {
      await this.journal.append({
        tenantId: session.tenantId,
        channelType: session.channelType,
        sessionId: session.id,
        direction: "in",
        outcome: "error",
        grain: "session",
        message: "import: отсутствует имя файла",
        details: { raw: rawFailureBody("missing filename") },
      });
      this.fail(res, "missing filename");
      return;
    }

    const bytes = await this.sessions.assemble(session.id, filename);

    if (type === "sale") {
      await this.importOrderStatuses(session, filename, bytes, res);
      return;
    }

    let items: ReturnType<typeof parseCommerceMl>["items"];
    let offers: ReturnType<typeof parseCommerceMl>["offers"];
    try {
      // Fix 3: one `parseCommerceMl` call decodes and parses `bytes` exactly
      // once and hands back both sections -- `parseCatalog`+`parseOffers`
      // back-to-back used to pay for that decode+parse twice per round for
      // no reason (neither call needs the other's section).
      const parsed = parseCommerceMl(bytes);
      items = parsed.items;
      offers = parsed.offers;
    } catch (cause) {
      const detail = cause instanceof Error ? cause.message : String(cause);
      // `message` below keeps the real `detail` -- the 1С specialist reading
      // this journal needs it (see `parseXml`'s own comment in
      // commerceml/parse.ts). `details.raw` does NOT: brief 08's "verbatim
      // what we actually answered" means verbatim what was actually SENT,
      // which is `IMPORT_PARSE_FAILURE` below, not `detail` -- see that
      // constant's own comment for why the real exception text must never
      // reach an anonymous caller on this ungated route.
      await this.journal.append({
        tenantId: session.tenantId,
        channelType: session.channelType,
        sessionId: session.id,
        direction: "in",
        outcome: "error",
        grain: "session",
        message: `import: ${detail}`,
        details: { filename, raw: rawFailureBody(IMPORT_PARSE_FAILURE) },
      });
      // Fix 1: a broken FILE is not a broken EXCHANGE -- 1С may still retry
      // this filename or move on to another one with the same cookie, so
      // the session is left open rather than finished here.
      this.fail(res, IMPORT_PARSE_FAILURE);
      return;
    }

    const knownRows = await this.db
      .select({ id: schema.products.id, externalRef: schema.products.externalRef })
      .from(schema.products)
      .where(
        and(eq(schema.products.tenantId, session.tenantId), isNotNull(schema.products.externalRef)),
      );
    const known: KnownProduct[] = knownRows.map((row) => ({
      id: row.id,
      externalRef: row.externalRef!,
    }));

    const [channelRow] = await this.db
      .select({ settings: schema.integrationChannels.settings })
      .from(schema.integrationChannels)
      .where(
        and(
          eq(schema.integrationChannels.tenantId, session.tenantId),
          eq(schema.integrationChannels.type, session.channelType),
        ),
      );
    const configuredPriceType = (channelRow?.settings as { priceType?: string } | undefined)
      ?.priceType;

    const plan = decideApplication({ known, items, offers, configuredPriceType });

    // Offers decideApplication had nothing to do with at all: no known link
    // to price, and offers carry no name/article/unit, so unlike catalog
    // items they cannot become a candidate either (apply.ts). Not this
    // connection's fault and not necessarily wrong -- the matching catalog
    // item may simply not have arrived (or been linked) yet -- but it must
    // not vanish without a trace either, per this task's brief.
    const knownRefs = new Set(known.map((product) => product.externalRef));
    const unmatchedOfferRefs = [
      ...new Set(
        offers.filter((offer) => !knownRefs.has(offer.externalRef)).map((o) => o.externalRef),
      ),
    ];

    const worklist: ImportWorkItem[] = [
      ...plan.priceUpdates.map((update): ImportWorkItem => ({
        kind: "price",
        productId: update.productId,
        unitPrice: update.unitPrice,
      })),
      ...plan.candidates.map((item): ImportWorkItem => ({
        kind: "candidate",
        externalRef: item.externalRef,
        name: item.name,
        article: item.article,
        unit: item.unit,
      })),
    ];

    // Fix 2: `worklist` above was just rebuilt from scratch -- a fresh
    // `known` query, a fresh `decideApplication` -- same as it is every
    // round. A bare stored offset trusts that THIS round's worklist lines up
    // row-for-row with whichever round wrote that offset; nothing guarantees
    // that between two rounds of the SAME filename (1С resubmits `mode=
    // import` verbatim after a `progress` reply), since an admin linking or
    // unlinking a product in between shifts the filtered arrays. The
    // fingerprint -- length plus a hash of ordered keys -- pins that down:
    // matching fingerprints mean the stored offset still points at the same
    // logical position; a mismatch means it doesn't, and continuing would
    // silently apply the wrong rows (or skip some) with no trace, since the
    // skip/unmatched journal below only fires at offset 0.
    const fingerprint = fingerprintOf(worklist);
    const stored = await this.sessions.readImportCursor(session.id, filename);
    let offset = stored?.offset ?? 0;
    if (stored && stored.fingerprint !== fingerprint) {
      await this.journal.append({
        tenantId: session.tenantId,
        channelType: session.channelType,
        sessionId: session.id,
        direction: "in",
        outcome: "warn",
        grain: "session",
        message: `import: список для «${filename}» изменился между кругами — файл начат заново`,
        details: { filename, previousOffset: stored.offset },
      });
      offset = 0;
    }

    if (offset === 0) {
      // Logged once, on the first batch of this import round (or again after
      // a fingerprint-mismatch restart above) -- decideApplication is a pure
      // function of `known`/`items`/`offers`, which do not change between
      // retries of the SAME filename UNLESS that mismatch just fired, so an
      // ordinary `progress` retry would just be re-deriving (and
      // re-journaling) an identical list.
      for (const skip of plan.skipped) {
        await this.journal.append({
          tenantId: session.tenantId,
          channelType: session.channelType,
          sessionId: session.id,
          direction: "in",
          outcome: "warn",
          grain: "item",
          message: `цена не применена (${skip.reason}): ${skip.externalRef}`,
          details: {
            externalRef: skip.externalRef,
            reason: skip.reason,
            priceTypes: skip.priceTypes ?? null,
          },
        });
      }
      if (unmatchedOfferRefs.length > 0) {
        await this.journal.append({
          tenantId: session.tenantId,
          channelType: session.channelType,
          sessionId: session.id,
          direction: "in",
          outcome: "warn",
          grain: "session",
          message: `предложения без связанного товара: ${unmatchedOfferRefs.length}`,
          details: { count: unmatchedOfferRefs.length, sample: unmatchedOfferRefs.slice(0, 20) },
        });
      }
    }

    const end = Math.min(offset + IMPORT_BATCH_SIZE, worklist.length);
    for (let i = offset; i < end; i++) {
      await this.applyWorkItem(session, worklist[i]!);
    }

    if (end < worklist.length) {
      await this.sessions.writeImportCursor(session.id, filename, { offset: end, fingerprint });
      this.text(res, "progress");
      return;
    }

    // Accepted limitation (final review, Fix 9): a file that took more than
    // one round to finish leaves its LAST intermediate cursor entry
    // (`session.summary.importCursors[filename]`) sitting in the row after
    // completion -- nothing here ever deletes it. Harmless in practice: a
    // stale entry is only ever read again if the SAME filename comes back
    // against the SAME session, and the fingerprint check above (Fix 2)
    // already refuses to resume blindly from it the moment the underlying
    // worklist has actually changed. Worst case is one redundant re-apply of
    // the file's last batch (idempotent either way -- a price `UPDATE` and a
    // candidate upsert both are) if 1С genuinely resends an already-completed
    // filename verbatim. Not worth a second write just to clear a key that
    // does no harm left in place.
    //
    // Fix 1: this FILE is done, but the exchange might not be -- 1С can still
    // send another file (e.g. offers.xml after import.xml) against the SAME
    // cookie, so the outcome is recorded as a journal event, not by finishing
    // the session. Only `ExchangeSessionService.sweepExpired` (TTL) does that
    // now, once the exchange itself has genuinely gone quiet.
    await this.journal.append({
      tenantId: session.tenantId,
      channelType: session.channelType,
      sessionId: session.id,
      direction: "in",
      outcome: "ok",
      grain: "session",
      message: `import: файл «${filename}» применён`,
      details: {
        filename,
        updated: plan.priceUpdates.length,
        candidates: plan.candidates.length,
        skipped: plan.skipped.length,
        unmatchedOffers: unmatchedOfferRefs.length,
      },
    });
    this.text(res, "success");
  }

  /**
   * `type=sale&mode=import` -- спека §6, "Из 1С к нам". Reads changed-order
   * documents 1С reports (Task 5's `parseOrderStatusDocuments`) and, for
   * each, resolves its own status requisite through this connection's
   * `statusMapping` (Task 5's `resolveMappedStatus`) into one of the three
   * transitions `PickupOrdersService.applyExternalStatus` (Task 7) can
   * apply. One row's outcome never aborts the round -- same discipline
   * `apply.ts`'s price decisions already follow.
   */
  private async importOrderStatuses(
    session: ResolvedExchangeSession,
    filename: string,
    bytes: Buffer,
    res: Response,
  ): Promise<void> {
    const [channelRow] = await this.db
      .select({ settings: schema.integrationChannels.settings })
      .from(schema.integrationChannels)
      .where(
        and(
          eq(schema.integrationChannels.tenantId, session.tenantId),
          eq(schema.integrationChannels.type, session.channelType),
        ),
      );
    const settings = (channelRow?.settings ?? {}) as {
      orderStatusField?: string;
      statusMapping?: Record<string, string>;
    };

    let documents: ReturnType<typeof parseOrderStatusDocuments>;
    try {
      documents = parseOrderStatusDocuments(bytes, settings.orderStatusField);
    } catch (cause) {
      const detail = cause instanceof Error ? cause.message : String(cause);
      await this.journal.append({
        tenantId: session.tenantId,
        channelType: session.channelType,
        sessionId: session.id,
        direction: "in",
        outcome: "error",
        grain: "session",
        message: `import (sale): ${detail}`,
        details: { filename, raw: rawFailureBody(IMPORT_PARSE_FAILURE) },
      });
      this.fail(res, IMPORT_PARSE_FAILURE);
      return;
    }

    let applied = 0;
    let discrepancies = 0;
    for (const document of documents) {
      const mapped = resolveMappedStatus(document.statusValue, settings.statusMapping);
      if (mapped === null) {
        discrepancies++;
        await this.journal.append({
          tenantId: session.tenantId,
          channelType: session.channelType,
          sessionId: session.id,
          direction: "in",
          outcome: "warn",
          grain: "item",
          message: `статус не сопоставлен: ${document.externalRef}`,
          details: { externalRef: document.externalRef, statusValue: document.statusValue },
        }).catch((error: unknown) => {
          this.logger.warn(
            `import (sale): status-unmapped journal failed (continuing): ${document.externalRef} — ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        });
        continue;
      }

      const result = await this.pickupOrders.applyExternalStatus(
        session.tenantId,
        document.externalRef,
        mapped,
      );
      if (result.outcome === "applied") {
        applied++;
        continue;
      }
      discrepancies++;
      await this.journal.append({
        tenantId: session.tenantId,
        channelType: session.channelType,
        sessionId: session.id,
        direction: "in",
        outcome: "warn",
        grain: "item",
        message: `расхождение статуса (${result.outcome}): ${document.externalRef} -> ${mapped}`,
        details: { externalRef: document.externalRef, mapped, outcome: result.outcome },
      }).catch((error: unknown) => {
        this.logger.warn(
          `import (sale): status-discrepancy journal failed (continuing): ${document.externalRef} — ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      });
    }

    await this.journal.append({
      tenantId: session.tenantId,
      channelType: session.channelType,
      sessionId: session.id,
      direction: "in",
      outcome: "ok",
      grain: "session",
      message: `import (sale): файл «${filename}» применён`,
      details: { filename, applied, discrepancies, total: documents.length },
    });
    this.text(res, "success");
  }

  /**
   * Writes exactly one planned row. The one rule this whole route exists to
   * hold literally: a price update touches `products.unit_price` and
   * NOTHING else on the row -- name, GTIN, ЕГАИС code, label template and
   * kiosk listing are never part of this `set()`, no matter what the
   * incoming catalog said about them.
   */
  private async applyWorkItem(
    session: ResolvedExchangeSession,
    work: ImportWorkItem,
  ): Promise<void> {
    if (work.kind === "price") {
      await this.db
        .update(schema.products)
        .set({ unitPrice: work.unitPrice })
        .where(
          and(
            eq(schema.products.tenantId, session.tenantId),
            eq(schema.products.id, work.productId),
          ),
        );
      return;
    }

    const now = new Date();
    await this.db
      .insert(schema.integrationCandidates)
      .values({
        tenantId: session.tenantId,
        channelType: session.channelType,
        externalRef: work.externalRef,
        name: work.name,
        article: work.article,
        unit: work.unit,
        lastSeenAt: now,
      })
      .onConflictDoUpdate({
        target: [
          schema.integrationCandidates.tenantId,
          schema.integrationCandidates.channelType,
          schema.integrationCandidates.externalRef,
        ],
        set: { name: work.name, article: work.article, unit: work.unit, lastSeenAt: now },
      });
  }

  /**
   * `mode=query`: спека §5's outbound direction. Builds this round's
   * eligible-order document (Task 4's `planExport`/`buildOrdersDocument`),
   * remembers which order ids it just offered (Task 8's
   * `writeQueriedOrderIds` -- `mode=success` reads this back rather than
   * trusting whatever 1С's own confirmation happens to say), and journals a
   * held-order warning for every order this round is NOT offering because a
   * product still lacks a 1С link (спека §5: "товар без связи придерживает
   * заявку").
   */
  private async query(session: ResolvedExchangeSession, res: Response): Promise<void> {
    const candidates = await this.pickupOrders.findExportCandidates(session.tenantId, EXPORT_BATCH_SIZE);
    const plan = planExport(candidates);

    for (const held of plan.held) {
      await this.journal.append({
        tenantId: session.tenantId,
        channelType: session.channelType,
        sessionId: session.id,
        direction: "out",
        outcome: "warn",
        grain: "item",
        message: `заявка придержана — товар без связи с 1С: ${held.orderNo}`,
        details: { orderId: held.orderId, orderNo: held.orderNo, unlinkedProductIds: held.unlinkedProductIds },
      }).catch((error: unknown) => {
        this.logger.warn(
          `query: held-order journal failed (continuing): ${held.orderNo} — ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      });
    }

    const [channelRow] = await this.db
      .select({ settings: schema.integrationChannels.settings })
      .from(schema.integrationChannels)
      .where(
        and(
          eq(schema.integrationChannels.tenantId, session.tenantId),
          eq(schema.integrationChannels.type, session.channelType),
        ),
      );
    const settings = (channelRow?.settings ?? {}) as {
      splitWriteoffDocument?: boolean;
      writeoffDocumentType?: string;
    };

    const xml = buildOrdersDocument(plan.eligible, {
      splitWriteoffDocument: settings.splitWriteoffDocument ?? false,
      writeoffDocumentType: settings.writeoffDocumentType,
    });

    await this.sessions.writeQueriedOrderIds(
      session.id,
      plan.eligible.map((eligible) => eligible.order.id),
    );

    await this.journal.append({
      tenantId: session.tenantId,
      channelType: session.channelType,
      sessionId: session.id,
      direction: "out",
      outcome: "ok",
      grain: "session",
      message: `query: предложено заявок: ${plan.eligible.length}`,
      details: { offered: plan.eligible.length, held: plan.held.length },
    });

    res.status(200).type("application/xml").send(xml);
  }

  /**
   * `mode=success`: спека §5's "подтверждение до пометки" -- marks EXACTLY
   * the order ids the immediately preceding `mode=query` on THIS session
   * offered (Task 8's `readQueriedOrderIds`, not whatever 1С's own success
   * call happens to say) as exported, and only those still `pending` with no
   * `exportedAt` yet -- a race with a manual admin resolve/cancel in between
   * is harmless either way (the order is already terminal, or already
   * exported by a concurrent success call). Clears the recorded ids after,
   * so a stray extra `mode=success` with nothing pending confirms zero.
   */
  private async success(session: ResolvedExchangeSession, res: Response): Promise<void> {
    const orderIds = await this.sessions.readQueriedOrderIds(session.id);
    let confirmed = 0;

    if (orderIds.length > 0) {
      const updated = await this.db
        .update(schema.pickupOrders)
        .set({ exportedAt: new Date() })
        .where(
          and(
            eq(schema.pickupOrders.tenantId, session.tenantId),
            inArray(schema.pickupOrders.id, orderIds),
            eq(schema.pickupOrders.status, "pending"),
            isNull(schema.pickupOrders.exportedAt),
          ),
        )
        .returning({ id: schema.pickupOrders.id });
      confirmed = updated.length;
      await this.sessions.writeQueriedOrderIds(session.id, []);
    }

    await this.journal.append({
      tenantId: session.tenantId,
      channelType: session.channelType,
      sessionId: session.id,
      direction: "out",
      outcome: "ok",
      grain: "session",
      message: `success: подтверждено заявок: ${confirmed}`,
      details: { confirmed, offered: orderIds.length },
    });

    this.text(res, "success");
  }

  private async unknownMode(
    session: ResolvedExchangeSession,
    mode: string | undefined,
  ): Promise<void> {
    await this.journal.append({
      tenantId: session.tenantId,
      channelType: session.channelType,
      sessionId: session.id,
      direction: "in",
      outcome: "error",
      grain: "session",
      message: `неизвестный режим: ${mode ?? "(пусто)"}`,
      // `"unknown mode"` here, not this method's own more specific message
      // above -- both call sites (`get`/`post`) always follow `unknownMode`
      // with `this.fail(res, "unknown mode")`, verbatim, so that fixed
      // string is the actual wire response `details.raw` must record.
      details: { mode: mode ?? null, raw: rawFailureBody("unknown mode") },
    });
  }

  /**
   * A query parameter this controller reads (`mode`, `type`, `filename`)
   * came back `null` from `singleQueryValue` -- present, but not a single
   * string. Only called once a tenant is already known (`get`/`post` call
   * this after `resolveSession` above has succeeded), unlike the
   * pre-authentication tampering check in `get()`'s own `checkauth` branch,
   * which has no tenant yet to journal against -- the same "no tenant, no
   * journal" boundary this file already draws for every other pre-auth
   * failure (e.g. `!credentials` in `checkauth` below).
   */
  private async rejectRepeatedParam(
    session: ResolvedExchangeSession,
    res: Response,
    keys: string[],
  ): Promise<void> {
    await this.journal.append({
      tenantId: session.tenantId,
      channelType: session.channelType,
      sessionId: session.id,
      direction: "in",
      outcome: "error",
      grain: "session",
      message: `повторён параметр запроса: ${keys.join(", ")}`,
      details: { keys, raw: rawFailureBody(REPEATED_PARAM_MESSAGE) },
    });
    this.fail(res, REPEATED_PARAM_MESSAGE);
  }

  private async resolveSession(req: ExchangeRequest): Promise<ResolvedExchangeSession | null> {
    const cookie = extractExchangeCookie(req.headers.cookie);
    if (!cookie) return null;
    return this.sessions.resolve(cookie);
  }

  private fail(res: Response, message: string): void {
    this.text(res, rawFailureBody(message));
  }

  /**
   * Every protocol response goes through here: plain text, 200, always --
   * see the class-level comment for why a 4xx must never happen on this
   * route, no matter what went wrong.
   */
  private text(res: Response, body: string): void {
    res.status(200).type("text/plain").send(body);
  }
}

/**
 * Manual `Authorization: Basic <base64(login:secret)>` parsing -- there is no
 * `basic-auth` package in this workspace, and pulling one in for a three-line
 * decode plus a single `indexOf(":")` split isn't worth the dependency.
 */
function parseBasicAuth(header: string | undefined): { login: string; secret: string } | null {
  if (!header?.startsWith("Basic ")) return null;
  const decoded = Buffer.from(header.slice("Basic ".length), "base64").toString("utf8");
  const sep = decoded.indexOf(":");
  if (sep < 0) return null;
  return { login: decoded.slice(0, sep), secret: decoded.slice(sep + 1) };
}
