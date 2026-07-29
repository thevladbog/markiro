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
import { eq } from "drizzle-orm";
import type { Response } from "express";
import { DB } from "../../auth/auth.module";
import type { IntegrationChannelType } from "../integrations/channel-registry";
import { JournalService } from "../integrations/journal.service";
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
  type ResolvedExchangeSession,
} from "./exchange-session.service";

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
  ) {}

  @Get("1c_exchange")
  async get(
    @Query() query: Record<string, string>,
    @Req() req: ExchangeRequest,
    @Res() res: Response,
    @Ip() ip: string,
  ): Promise<void> {
    if (query.mode === "checkauth") {
      await this.checkauth(query, req, res, ip);
      return;
    }

    const session = await this.resolveSession(req);
    if (!session) {
      this.fail(res, "no session");
      return;
    }
    req.exchangeContext = {
      tenantId: session.tenantId,
      channelType: session.channelType,
      sessionId: session.id,
    };

    if (query.mode === "init") {
      await this.journal.append({
        tenantId: session.tenantId,
        channelType: session.channelType,
        sessionId: session.id,
        direction: "in",
        outcome: "ok",
        grain: "session",
        message: "init",
        details: { type: query.type ?? null },
      });
      // `zip=no` in v1 (спека §3): archives are a new dependency and attack
      // surface (zip-bomb) to save bandwidth on a file that is megabytes,
      // not gigabytes. `file_limit` is the SAME ceiling as `FILE_CHUNK_LIMIT`
      // and express.raw's `limit` in exchange.module.ts -- we declare it, so
      // all three read one constant rather than three independent numbers.
      this.text(res, [`zip=no`, `file_limit=${FILE_CHUNK_LIMIT}`].join("\n"));
      return;
    }

    await this.unknownMode(session, query.mode);
    this.fail(res, "unknown mode");
  }

  @Post("1c_exchange")
  async post(
    @Query() query: Record<string, string>,
    @Req() req: ExchangeRequest,
    @Res() res: Response,
  ): Promise<void> {
    const session = await this.resolveSession(req);
    if (!session) {
      this.fail(res, "no session");
      return;
    }
    req.exchangeContext = {
      tenantId: session.tenantId,
      channelType: session.channelType,
      sessionId: session.id,
    };

    if (query.mode === "file") {
      const filename = query.filename;
      const body: unknown = req.body;
      if (!filename || !Buffer.isBuffer(body)) {
        await this.journal.append({
          tenantId: session.tenantId,
          channelType: session.channelType,
          sessionId: session.id,
          direction: "in",
          outcome: "error",
          grain: "session",
          message: "file: отсутствует имя файла или тело запроса",
          details: { filename: filename ?? null },
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

    await this.unknownMode(session, query.mode);
    this.fail(res, "unknown mode");
  }

  private async checkauth(
    query: Record<string, string>,
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
      details: { type: query.type ?? null },
    });

    this.text(res, ["success", EXCHANGE_COOKIE_NAME, opened.cookie].join("\n"));
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
      details: { mode: mode ?? null },
    });
  }

  private async resolveSession(req: ExchangeRequest): Promise<ResolvedExchangeSession | null> {
    const cookie = extractExchangeCookie(req.headers.cookie);
    if (!cookie) return null;
    return this.sessions.resolve(cookie);
  }

  private fail(res: Response, message: string): void {
    this.text(res, ["failure", message].join("\n"));
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
