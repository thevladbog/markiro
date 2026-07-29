import {
  Injectable,
  Module,
  RequestMethod,
  type MiddlewareConsumer,
  type NestMiddleware,
  type NestModule,
} from "@nestjs/common";
import express from "express";
import type { NextFunction, Request, RequestHandler, Response } from "express";
import { JournalService } from "../integrations/journal.service";
import { ExchangeController } from "./exchange.controller";
import {
  ExchangeSessionService,
  extractExchangeCookie,
  FILE_CHUNK_LIMIT,
} from "./exchange-session.service";

const EXCHANGE_ROUTE = "1c_exchange";
/** Same route, as an absolute path -- what `req.path` actually looks like. */
export const EXCHANGE_ROUTE_PATH = `/${EXCHANGE_ROUTE}`;

/**
 * Wraps `middleware` (in practice, `express.json()`) so it never runs for
 * `/1c_exchange`. Every place this app assembles its global Express
 * middleware stack -- `main.ts`, and any e2e test that reproduces that same
 * stack (`server.use(express.json())` after `mountAuth`, before
 * `app.init()`) -- must use this instead of registering the parser bare.
 *
 * Confirmed empirically, not assumed: a bare global `express.json()` DOES
 * reach `POST /1c_exchange` before this module's own `ensureContentType` /
 * `express.raw` ever see the request, for any caller that sends `Content-Type:
 * application/json` (mismatched or not) -- `server.use(express.json())` in
 * main.ts executes immediately, while `NestModule.configure()` below only
 * wires this module's per-route middleware during `app.init()`, which runs
 * strictly later. A malformed JSON body under that content type then 400s
 * straight out of `express.json()`'s own parser, before this controller gets
 * a chance to turn it into the `failure\n<message>`/200 its whole contract
 * promises. Excluding the path here holds regardless of registration order,
 * rather than relying on `ensureContentType` running first.
 */
export function excludeExchangeRoute(middleware: RequestHandler): RequestHandler {
  return (req, res, next) => {
    if (req.path === EXCHANGE_ROUTE_PATH) {
      next();
      return;
    }
    middleware(req, res, next);
  };
}

/**
 * `express.raw`'s own `type` matcher (`type-is` under the hood) returns
 * `false` for ANY pattern -- including the wildcard "match anything" one
 * passed below -- when the request carries no `Content-Type` header at all:
 * it has nothing to compare the pattern against, wildcard or not. 1С's
 * chunked-file POSTs are not guaranteed to
 * set one. Without this, such a request would sail past `express.raw`
 * untouched, leaving `req.body` `undefined` and silently falling into this
 * controller's "missing body" branch instead of ever being read. Backfilling
 * a default ONLY when the header is absent preserves whatever content-type a
 * real caller does send (harmless either way, since this route always reads
 * the body as opaque bytes) while guaranteeing `express.raw` below always has
 * something to match.
 */
function ensureContentType(req: Request, _res: Response, next: NextFunction): void {
  if (!req.headers["content-type"]) {
    req.headers["content-type"] = "application/octet-stream";
  }
  next();
}

/**
 * Rejects an oversized `mode=file` chunk BEFORE `express.raw` gets to it, by
 * its declared `Content-Length` -- so the caller gets this route's own
 * `failure\n...` (200) without paying for reading the whole oversized body
 * first. `Content-Length` is absent under chunked transfer-encoding; that
 * rarer case falls through to `ExchangeRawBodyMiddleware` below, which
 * converts the SAME outcome (`failure\nchunk too large`, 200) out of
 * `express.raw`'s own `limit` instead -- so either path produces an
 * identical response, just at a different point (before vs. after the body
 * is read).
 */
@Injectable()
class ExchangeChunkLimitMiddleware implements NestMiddleware {
  constructor(
    private readonly sessions: ExchangeSessionService,
    private readonly journal: JournalService,
  ) {}

  async use(req: Request, res: Response, next: NextFunction): Promise<void> {
    if (req.query.mode !== "file") {
      next();
      return;
    }
    const contentLength = Number(req.headers["content-length"]);
    if (!Number.isFinite(contentLength) || contentLength <= FILE_CHUNK_LIMIT) {
      next();
      return;
    }

    const cookie = extractExchangeCookie(req.headers.cookie);
    const session = cookie ? await this.sessions.resolve(cookie) : null;
    if (session) {
      await this.journal.append({
        tenantId: session.tenantId,
        channelType: session.channelType,
        sessionId: session.id,
        direction: "in",
        outcome: "error",
        grain: "session",
        message: `file: кусок превышает потолок (${contentLength} байт > ${FILE_CHUNK_LIMIT})`,
      });
    }
    res.status(200).type("text/plain").send("failure\nchunk too large");
  }
}

/**
 * Wraps `express.raw` so a rejected body never reaches Express's own default
 * error handling -- a bare JSON `413`, exactly the 4xx this whole controller
 * exists to never produce. `ExchangeChunkLimitMiddleware` above only catches
 * an oversized `mode=file` chunk when the caller declares an honest
 * `Content-Length`; chunked transfer-encoding carries none, so that check
 * silently no-ops (`!Number.isFinite(contentLength)`) and an oversized body
 * reaches `express.raw` itself, whose own `limit` (the same
 * `FILE_CHUNK_LIMIT`) then throws a `PayloadTooLargeError`.
 *
 * That throw happens in Express middleware, OUTSIDE `ExchangeController`'s
 * own request-handling pipeline -- `ExchangeExceptionFilter` (`@UseFilters`
 * on the controller) never sees it, confirmed empirically: `curl` with
 * `Transfer-Encoding: chunked` (no `Content-Length`) against a body over
 * `FILE_CHUNK_LIMIT` returned a bare `{"statusCode":413,...}` before this
 * middleware existed, filter and all.
 *
 * Manually invoking `express.raw`'s returned handler with OUR OWN callback,
 * rather than binding it directly as a third middleware in `configure()`
 * below (as it used to be), is what makes this interceptable at all: body-
 * parser style middleware reports failure by calling its `next` argument
 * with an error instead of throwing synchronously, so supplying a callback
 * that branches on that argument -- instead of Express's real `next` --
 * is enough to catch it, with no dependency on Express's arity-sniffed
 * 4-argument error-middleware convention (which `NestModule.configure()`
 * cannot express for a class-based `NestMiddleware` in the first place,
 * since `NestMiddleware.use` is always a 3-argument method).
 */
@Injectable()
class ExchangeRawBodyMiddleware implements NestMiddleware {
  private readonly parseRawBody = express.raw({ type: "*/*", limit: FILE_CHUNK_LIMIT });

  constructor(
    private readonly sessions: ExchangeSessionService,
    private readonly journal: JournalService,
  ) {}

  use(req: Request, res: Response, next: NextFunction): void {
    this.parseRawBody(req, res, (error?: unknown) => {
      if (!error) {
        next();
        return;
      }
      void this.reportOversized(req, res);
    });
  }

  /** Same response, and the same journal-if-resolvable discipline, as `ExchangeChunkLimitMiddleware`'s early check above. */
  private async reportOversized(req: Request, res: Response): Promise<void> {
    const cookie = extractExchangeCookie(req.headers.cookie);
    const session = cookie ? await this.sessions.resolve(cookie) : null;
    if (session) {
      await this.journal.append({
        tenantId: session.tenantId,
        channelType: session.channelType,
        sessionId: session.id,
        direction: "in",
        outcome: "error",
        grain: "session",
        message: `file: кусок превышает потолок (${FILE_CHUNK_LIMIT} байт, chunked без Content-Length)`,
      });
    }
    res.status(200).type("text/plain").send("failure\nchunk too large");
  }
}

/**
 * Home of the CommerceML "Обмен с сайтом" transport. The global
 * `express.json()` in main.ts is registered (and, per `excludeExchangeRoute`
 * above, must be registered) to skip `/1c_exchange` entirely -- it is NOT
 * enough to rely on it only touching request bodies whose Content-Type says
 * `application/json`, which `ensureContentType` below never sets by default:
 * a real 1С client, or an attacker, can still send that exact header on
 * `mode=file`, and a bare global parser would 400 on it before this module's
 * own `ensureContentType`/`express.raw` ever run (`NestModule.configure()`
 * below wires those up during `app.init()`, which always runs after
 * main.ts's earlier `server.use()` call -- registration order that cannot be
 * relied on to save a request from the global parser). `express.raw` is
 * bound ONLY to `POST /1c_exchange`, not the whole app, with `limit:
 * FILE_CHUNK_LIMIT` as its hard ceiling -- the same constant
 * `exchange.controller.ts` advertises as `file_limit` on `mode=init`.
 */
@Module({
  controllers: [ExchangeController],
  providers: [
    ExchangeSessionService,
    JournalService,
    ExchangeChunkLimitMiddleware,
    ExchangeRawBodyMiddleware,
  ],
})
export class ExchangeModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer
      .apply(ensureContentType, ExchangeChunkLimitMiddleware, ExchangeRawBodyMiddleware)
      .forRoutes({ path: EXCHANGE_ROUTE, method: RequestMethod.POST });
  }
}
