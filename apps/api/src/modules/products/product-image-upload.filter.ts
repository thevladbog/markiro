import { Catch, type ArgumentsHost, type ExceptionFilter } from "@nestjs/common";
import { MulterError } from "multer";
import type { Response } from "express";
import type { RequestWithTenant } from "../../tenancy/tenant.guard";
import { ProductsService } from "./products.service";

@Catch(MulterError)
export class ProductImageUploadFilter implements ExceptionFilter<MulterError> {
  constructor(private readonly products: ProductsService) {}

  async catch(error: MulterError, host: ArgumentsHost): Promise<void> {
    const context = host.switchToHttp();
    const request = context.getRequest<RequestWithTenant & { params: { id: string } }>();
    const response = context.getResponse<Response>();

    if (error.code === "LIMIT_FILE_SIZE") {
      await this.products.recordImageUploadFailure(
        request.tenantId!,
        request.userId!,
        request.params.id,
        "source_too_large",
      );
      response.status(400).json({
        message: "Product image exceeds the 5 MiB source limit",
        error: "Bad Request",
        statusCode: 400,
      });
      return;
    }

    response.status(400).json({ message: error.message, error: "Bad Request", statusCode: 400 });
  }
}
