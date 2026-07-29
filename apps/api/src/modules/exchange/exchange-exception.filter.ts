import { Catch, Logger, type ArgumentsHost, type ExceptionFilter } from "@nestjs/common";
import type { Request, Response } from "express";
import type { IntegrationChannelType } from "../integrations/channel-registry";
import { JournalService } from "../integrations/journal.service";

/**
 * Attached to `req` by `ExchangeController` the moment a request's tenant
 * becomes known -- a resolved session (`get`/`post`), or, for `checkauth`,
 * a matched credential row before its session has even opened. Lets
 * `ExchangeExceptionFilter` below journal an unhandled failure against the
 * right tenant even though it runs OUTSIDE the handler that discovered that
 * tenant. Left `undefined` wherever tenant genuinely isn't resolvable yet
 * (e.g. a throw during `resolveSession` itself, or before `checkauth`'s row
 * lookup) -- the same boundary the controller's own deliberate failure
 * branches already draw (see e.g. the "no tenant to journal against"
 * comment on `checkauth`'s invalid-credentials branch).
 */
export interface ExchangeJournalContext {
  tenantId: string;
  channelType: IntegrationChannelType;
  sessionId: string | null;
}

export interface ExchangeRequest extends Request {
  exchangeContext?: ExchangeJournalContext;
}

/**
 * Catches anything `ExchangeController`'s handlers don't -- a DB outage
 * mid-`sessions.open`, `journal.append` itself failing, a lost race on
 * `exchange_uploads_part_uq`, a failed `sessions.resolve`, or literally
 * anything else nobody enumerated in advance. The controller's class-level
 * comment states the contract this filter exists to hold even when
 * everything else has gone wrong: every response is `failure\n<message>` at
 * status 200 -- on EVERY branch, including ones nobody anticipated. Without
 * this filter, Nest's default exception handling would turn an unexpected
 * throw into a JSON body and a non-200 status, which is exactly the "network
 * error" 1С shows the operator on the wire while hiding the one line that
 * would have told them what actually broke.
 *
 * `@Catch()` with no argument -- catches everything, `HttpException` or
 * plain `Error` alike, not just a chosen subset: a route with an
 * unconditional 200-text contract cannot afford to special-case which
 * exception types it bothers to convert.
 *
 * Never rethrows, no matter what: a throw out of `catch()` itself (e.g.
 * `journal.append` below failing because the same outage that produced
 * `exception` in the first place is still ongoing) would hand the request
 * straight back to Nest's default handler -- reopening exactly the hole this
 * filter exists to close. The journal write is therefore its own try/catch,
 * logged and discarded rather than left to escape.
 */
@Catch()
export class ExchangeExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(ExchangeExceptionFilter.name);

  constructor(private readonly journal: JournalService) {}

  async catch(exception: unknown, host: ArgumentsHost): Promise<void> {
    const ctx = host.switchToHttp();
    const res = ctx.getResponse<Response>();
    const req = ctx.getRequest<ExchangeRequest>();
    const detail = exception instanceof Error ? exception.message : String(exception);

    this.logger.error(
      `unhandled exception on /1c_exchange: ${detail}`,
      exception instanceof Error ? exception.stack : undefined,
    );

    const known = req.exchangeContext;
    if (known) {
      try {
        await this.journal.append({
          tenantId: known.tenantId,
          channelType: known.channelType,
          sessionId: known.sessionId,
          direction: "in",
          outcome: "error",
          grain: "session",
          message: `внутренняя ошибка: ${detail}`,
        });
      } catch (journalError) {
        this.logger.error(
          `failed to journal an unhandled /1c_exchange exception: ${
            journalError instanceof Error ? journalError.message : String(journalError)
          }`,
        );
      }
    }

    // Defensive only: Nest invokes a filter precisely because no response was
    // sent yet for this exception, and every response this controller writes
    // is a single synchronous `res.send()` at the very end of a handler --
    // there is no code path that partially writes a response and then
    // throws. Kept so this filter can never itself produce the
    // "headers already sent" crash on some future handler shape.
    if (res.headersSent) return;

    // Review fix: this final send used to sit outside any try/catch. Nest's
    // `ExceptionsHandler.invokeCustomFilters` calls a custom filter's
    // `catch()` and neither awaits nor attaches a rejection handler to what
    // it returns, so a throw escaping this `async` method -- from THIS send,
    // same as from `journal.append` above -- is a genuine, nobody-watching
    // rejection, not merely a bypass of Nest's default handling the way an
    // uncaught controller exception is. Same discipline as the
    // `journal.append` try/catch above: the one thing this filter, of all
    // places, must never do is let its OWN attempt at recovery throw
    // somewhere unobserved.
    try {
      res.status(200).type("text/plain").send("failure\ninternal error");
    } catch (sendError) {
      this.logger.error(
        `failed to send the /1c_exchange failure response itself: ${
          sendError instanceof Error ? sendError.message : String(sendError)
        }`,
      );
    }
  }
}
