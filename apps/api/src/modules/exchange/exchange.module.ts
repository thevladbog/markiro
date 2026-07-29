import {
  Injectable,
  Module,
  RequestMethod,
  type MiddlewareConsumer,
  type NestMiddleware,
  type NestModule,
} from "@nestjs/common";
import express from "express";
import type { NextFunction, Request, Response } from "express";
import { JournalService } from "../integrations/journal.service";
import { ExchangeController } from "./exchange.controller";
import {
  ExchangeSessionService,
  extractExchangeCookie,
  FILE_CHUNK_LIMIT,
} from "./exchange-session.service";

const EXCHANGE_ROUTE = "1c_exchange";

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
 * `failure\n...` (200), not the generic error `express.raw`'s internal
 * `limit` would throw (a 413, exactly the 4xx this whole controller exists to
 * never produce). `Content-Length` is absent under chunked
 * transfer-encoding; that rarer case falls through to `express.raw`'s own
 * `limit` below as a backstop -- still bounded, just with a plainer error.
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
 * Home of the CommerceML "Обмен с сайтом" transport. The global
 * `express.json()` (mounted in main.ts, after this module's middleware is
 * registered during `app.init()`) would corrupt the raw bytes of a `mode=file`
 * chunk if it ever tried to parse them -- it doesn't, here, because it only
 * touches request bodies whose Content-Type says `application/json`, and
 * `ensureContentType` below never sets that. `express.raw` is bound ONLY to
 * `POST /1c_exchange`, not the whole app, with `limit: FILE_CHUNK_LIMIT` as
 * its hard ceiling -- the same constant `exchange.controller.ts` advertises
 * as `file_limit` on `mode=init`.
 */
@Module({
  controllers: [ExchangeController],
  providers: [ExchangeSessionService, JournalService, ExchangeChunkLimitMiddleware],
})
export class ExchangeModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer
      .apply(
        ensureContentType,
        ExchangeChunkLimitMiddleware,
        express.raw({ type: "*/*", limit: FILE_CHUNK_LIMIT }),
      )
      .forRoutes({ path: EXCHANGE_ROUTE, method: RequestMethod.POST });
  }
}
