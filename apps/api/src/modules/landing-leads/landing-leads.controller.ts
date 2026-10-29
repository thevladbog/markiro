import {
  ArgumentsHost,
  Body,
  Catch,
  Controller,
  HttpCode,
  HttpException,
  HttpStatus,
  Ip,
  Logger,
  Post,
  UseFilters,
  UseGuards,
  type ExceptionFilter,
} from "@nestjs/common";
import { ApiOperation, ApiResponse, ApiTags } from "@nestjs/swagger";
import { LANDING_LEAD_PUBLIC_ERROR_CODES } from "@markiro/platform-contracts";
import type { Response } from "express";
import { ApiZodBody } from "../../lib/openapi";
import { ZodValidationPipe } from "../../zod.pipe";
import {
  demoRequestAcceptedOpenApiSchema,
  demoRequestErrorOpenApiSchema,
} from "../demo-requests/demo-request.schema";
import { DemoRequestSubmissionGuard } from "../demo-requests/demo-request-submission.guard";
import { landingLeadBodySchema, type LandingLeadDto } from "./landing-lead.schema";
import { LandingLeadService } from "./landing-lead.service";

type PublicErrorCode = (typeof LANDING_LEAD_PUBLIC_ERROR_CODES)[number];

/** Reduces every error to `{ code }`, exactly like the demo form (spec §15.3). */
@Catch(HttpException)
export class LandingLeadPublicErrorFilter implements ExceptionFilter<HttpException> {
  readonly #logger = new Logger("LandingLeadTelemetry");

  catch(exception: HttpException, host: ArgumentsHost): void {
    const candidate = exception.getResponse();
    const code: PublicErrorCode =
      typeof candidate === "object" &&
      candidate !== null &&
      "code" in candidate &&
      typeof candidate.code === "string" &&
      (LANDING_LEAD_PUBLIC_ERROR_CODES as readonly string[]).includes(candidate.code)
        ? (candidate.code as PublicErrorCode)
        : "invalid_request";
    try {
      this.#logger.log(
        JSON.stringify({
          event: "landing_lead_request_final",
          status: exception.getStatus(),
          code,
        }),
      );
    } catch {
      // Telemetry never alters the public response.
    }
    host.switchToHttp().getResponse<Response>().status(exception.getStatus()).json({ code });
  }
}

@ApiTags("landing-leads")
@Controller("landing-leads")
@UseFilters(LandingLeadPublicErrorFilter)
@UseGuards(DemoRequestSubmissionGuard)
export class LandingLeadsController {
  readonly #logger = new Logger("LandingLeadTelemetry");

  constructor(private readonly service: LandingLeadService) {}

  @Post()
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({
    summary: "Submit a landing download or invoice request",
    description:
      "Public landing form intake — no authentication. `intent` is `download` (the /skachat/ form) " +
      "or `invoice` (the /stoimost/ invoice form, which also requires `inn` and `tariffCode`). " +
      "`website` is a honeypot and must stay empty, `consentVersion` must match the published " +
      "consent document. Rate limits apply before storage. A retried " +
      "`requestId` is accepted again without a second lead event or e-mail. Every error is " +
      "reduced to a single `{ code }` body.",
  })
  @ApiZodBody(landingLeadBodySchema)
  @ApiResponse({ status: 202, schema: demoRequestAcceptedOpenApiSchema })
  @ApiResponse({
    status: 400,
    schema: demoRequestErrorOpenApiSchema("invalid_request"),
  })
  @ApiResponse({ status: 404, schema: demoRequestErrorOpenApiSchema("submission_disabled") })
  @ApiResponse({ status: 429, schema: demoRequestErrorOpenApiSchema("rate_limited") })
  @ApiResponse({
    status: 503,
    schema: demoRequestErrorOpenApiSchema("submission_unavailable"),
  })
  async submit(
    @Body(new ZodValidationPipe(landingLeadBodySchema)) body: LandingLeadDto,
    @Ip() source: string,
  ): Promise<{ accepted: true; requestId: string }> {
    const result = await this.service.submit(body, source);
    this.#logger.log(
      JSON.stringify({
        event: "landing_lead_request_final",
        status: 202,
        code: "accepted",
        intent: body.intent,
        sourcePath: body.sourcePath,
      }),
    );
    return result;
  }
}
