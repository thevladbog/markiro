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
  UseFilters,
  UseGuards,
  type ExceptionFilter,
} from "@nestjs/common";
import type { Response } from "express";
import { ZodValidationPipe } from "../../zod.pipe";
import { demoRequestSchema, type DemoRequestDto } from "./demo-request.schema";
import { DemoRequestService } from "./demo-request.service";
import { DemoRequestSubmissionGuard } from "./demo-request-submission.guard";

const PUBLIC_ERROR_CODES = new Set([
  "invalid_request",
  "captcha_invalid",
  "captcha_unavailable",
  "rate_limited",
  "submission_disabled",
  "submission_unavailable",
]);

@Catch(HttpException)
class DemoRequestPublicErrorFilter implements ExceptionFilter<HttpException> {
  catch(exception: HttpException, host: ArgumentsHost): void {
    const candidate = exception.getResponse();
    const code =
      typeof candidate === "object" &&
      candidate !== null &&
      "code" in candidate &&
      typeof candidate.code === "string" &&
      PUBLIC_ERROR_CODES.has(candidate.code)
        ? candidate.code
        : "invalid_request";
    host.switchToHttp().getResponse<Response>().status(exception.getStatus()).json({ code });
  }
}

@Controller("demo-requests")
@UseFilters(new DemoRequestPublicErrorFilter())
@UseGuards(DemoRequestSubmissionGuard)
export class DemoRequestsController {
  constructor(private readonly service: DemoRequestService) {}

  @Post()
  @HttpCode(HttpStatus.ACCEPTED)
  submit(
    @Body(new ZodValidationPipe(demoRequestSchema)) body: DemoRequestDto,
    @Ip() source: string,
  ) {
    return this.service.submit(body, source);
  }
}
