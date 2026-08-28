import {
  Catch,
  PayloadTooLargeException,
  type ArgumentsHost,
  type ExceptionFilter,
} from "@nestjs/common";
import { randomUUID } from "node:crypto";
import type { Request, Response } from "express";
import { MulterError } from "multer";
import {
  currentPlatformRequestId,
  isPlatformRequestPath,
} from "../../platform-http/platform-request-context.middleware";

@Catch(MulterError, PayloadTooLargeException)
export class BillingAttachmentUploadFilter implements ExceptionFilter<
  MulterError | PayloadTooLargeException
> {
  catch(error: MulterError | PayloadTooLargeException, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();
    const request = host.switchToHttp().getRequest<Request>();
    const tooLarge = error instanceof PayloadTooLargeException || error.code === "LIMIT_FILE_SIZE";
    if (isPlatformRequestPath(request.path)) {
      const requestId = currentPlatformRequestId(request) ?? randomUUID();
      const status = tooLarge ? 413 : 400;
      response.status(status).json({
        code: tooLarge ? "billing_act_pdf_too_large" : "billing_act_upload_invalid",
        message: tooLarge ? "Billing act PDF exceeds the 5 MiB limit" : error.message,
        requestId,
      });
      return;
    }
    const message = tooLarge ? "Billing attachment exceeds the 5 MiB limit" : error.message;
    response.status(400).json({ message, error: "Bad Request", statusCode: 400 });
  }
}
