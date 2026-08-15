import {
  ArgumentsHost,
  Body,
  Catch,
  Controller,
  HttpCode,
  HttpException,
  HttpStatus,
  Ip,
  Post,
  Req,
  UseFilters,
  UseGuards,
  type ExceptionFilter,
} from "@nestjs/common";
import type { Response } from "express";
import { ZodValidationPipe } from "../../zod.pipe";
import { demoRequestSchema, type DemoRequestDto } from "./demo-request.schema";
import { DemoRequestService } from "./demo-request.service";
import { DemoRequestSubmissionGuard } from "./demo-request-submission.guard";
import {
  DEMO_REQUEST_TELEMETRY_CONTEXT,
  DemoRequestTelemetry,
  recordDemoRequestTelemetry,
  type DemoRequestTelemetryRequest,
} from "./demo-request.telemetry";

const PUBLIC_ERROR_STATUS = {
  invalid_request: 400,
  captcha_invalid: 400,
  captcha_unavailable: 503,
  rate_limited: 429,
  submission_disabled: 404,
  submission_unavailable: 503,
} as const;

type PublicErrorCode = keyof typeof PUBLIC_ERROR_STATUS;

@Catch(HttpException)
export class DemoRequestPublicErrorFilter implements ExceptionFilter<HttpException> {
  constructor(private readonly telemetry: DemoRequestTelemetry) {}

  catch(exception: HttpException, host: ArgumentsHost): void {
    const candidate = exception.getResponse();
    const code: PublicErrorCode =
      typeof candidate === "object" &&
      candidate !== null &&
      "code" in candidate &&
      typeof candidate.code === "string" &&
      Object.hasOwn(PUBLIC_ERROR_STATUS, candidate.code)
        ? (candidate.code as PublicErrorCode)
        : "invalid_request";
    const context = host.switchToHttp();
    const request = context.getRequest<DemoRequestTelemetryRequest>();
    const safeContext = request[DEMO_REQUEST_TELEMETRY_CONTEXT];
    recordDemoRequestTelemetry(this.telemetry, {
      event: "landing_demo_request_final",
      status: PUBLIC_ERROR_STATUS[code],
      code,
      locale: safeContext?.locale ?? "unknown",
      sourcePath: safeContext?.sourcePath ?? "unknown",
    });
    context.getResponse<Response>().status(exception.getStatus()).json({ code });
  }
}

@Controller("demo-requests")
@UseFilters(DemoRequestPublicErrorFilter)
@UseGuards(DemoRequestSubmissionGuard)
export class DemoRequestsController {
  constructor(
    private readonly service: DemoRequestService,
    private readonly telemetry: DemoRequestTelemetry,
  ) {}

  @Post()
  @HttpCode(HttpStatus.ACCEPTED)
  async submit(
    @Body(new ZodValidationPipe(demoRequestSchema)) body: DemoRequestDto,
    @Ip() source: string,
    @Req() request: DemoRequestTelemetryRequest,
  ): Promise<{ accepted: true; requestId: string }> {
    request[DEMO_REQUEST_TELEMETRY_CONTEXT] = {
      locale: body.locale,
      sourcePath: body.sourcePath,
    };
    const result = await this.service.submit(body, source);
    recordDemoRequestTelemetry(this.telemetry, {
      event: "landing_demo_request_final",
      status: 202,
      code: "accepted",
      locale: body.locale,
      sourcePath: body.sourcePath,
    });
    return result;
  }
}
