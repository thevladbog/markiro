import {
  Catch,
  PayloadTooLargeException,
  type ArgumentsHost,
  type ExceptionFilter,
} from "@nestjs/common";
import type { Response } from "express";
import { MulterError } from "multer";

@Catch(MulterError, PayloadTooLargeException)
export class BillingAttachmentUploadFilter implements ExceptionFilter<
  MulterError | PayloadTooLargeException
> {
  catch(error: MulterError | PayloadTooLargeException, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();
    const message =
      error instanceof PayloadTooLargeException || error.code === "LIMIT_FILE_SIZE"
        ? "Billing attachment exceeds the 5 MiB limit"
        : error.message;
    response.status(400).json({ message, error: "Bad Request", statusCode: 400 });
  }
}
