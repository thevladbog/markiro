import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
  Req,
  Res,
  UploadedFile,
  UseGuards,
  UseFilters,
  UseInterceptors,
} from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import { memoryStorage } from "multer";
import { ApiBody, ApiConsumes, ApiTags } from "@nestjs/swagger";
import { CABINET_CAPABILITY } from "@markiro/domain";
import type { Response } from "express";
import { AllowStationOrPermissions, RequirePermissions } from "../../authorization/access-policy";
import { AuthorizationGuard } from "../../authorization/authorization.guard";
import {
  AllowSubscriptionReadOnly,
  RequireSubscriptionWrite,
} from "../../subscriptions/subscription-access-policy";
import { SubscriptionAccessGuard } from "../../subscriptions/subscription-access.guard";
import { TenantGuard, type RequestWithTenant } from "../../tenancy/tenant.guard";
import { ZodValidationPipe } from "../../zod.pipe";
import { ObjectStorageService } from "../storage/object-storage.service";
import {
  createProductSchema,
  gtinCheckSchema,
  listProductsQuerySchema,
  updateProductSchema,
  type CreateProductDto,
  type GtinCheckDto,
  type GtinCheckResponseDto,
  type ListProductsQueryDto,
  type ListProductsResponseDto,
  type ProductDto,
  type UpdateProductDto,
} from "./dto";
import { ProductsService } from "./products.service";
import { ProductImageUploadFilter } from "./product-image-upload.filter";

@ApiTags("products")
@Controller("products")
@UseGuards(TenantGuard, AuthorizationGuard, SubscriptionAccessGuard)
@AllowSubscriptionReadOnly("read")
export class ProductsController {
  constructor(
    private readonly productsService: ProductsService,
    private readonly storage: ObjectStorageService,
  ) {}

  @Get()
  @AllowStationOrPermissions(CABINET_CAPABILITY.OPERATIONS_READ)
  async listProducts(
    @Req() req: RequestWithTenant,
    @Query(new ZodValidationPipe(listProductsQuerySchema)) query: ListProductsQueryDto,
  ): Promise<ListProductsResponseDto> {
    return this.productsService.listProducts(req.tenantId!, query);
  }

  @Post("gtin-check")
  @HttpCode(HttpStatus.OK)
  @AllowSubscriptionReadOnly("read")
  @AllowStationOrPermissions(CABINET_CAPABILITY.OPERATIONS_READ)
  async checkGtinOwner(
    @Req() req: RequestWithTenant,
    @Body(new ZodValidationPipe(gtinCheckSchema)) body: GtinCheckDto,
  ): Promise<GtinCheckResponseDto> {
    return this.productsService.checkGtinOwner(req.tenantId!, body.gtin);
  }

  // Cabinet-only: not one of the station's two routes (list, gtin-check)
  // above. The station resolves a scanned GTIN via search on the list
  // endpoint, so it never needs get-by-id or any of the catalog mutations.
  @Get(":id")
  @RequirePermissions(CABINET_CAPABILITY.OPERATIONS_READ)
  async getProduct(@Req() req: RequestWithTenant, @Param("id") id: string): Promise<ProductDto> {
    return this.productsService.getProduct(req.tenantId!, id);
  }

  @Post()
  @RequireSubscriptionWrite()
  @RequirePermissions(CABINET_CAPABILITY.OPERATIONS_WRITE)
  async createProduct(
    @Req() req: RequestWithTenant,
    @Body(new ZodValidationPipe(createProductSchema)) body: CreateProductDto,
  ): Promise<ProductDto> {
    return this.productsService.createProduct(req.tenantId!, body);
  }

  @Patch(":id")
  @RequireSubscriptionWrite()
  @RequirePermissions(CABINET_CAPABILITY.OPERATIONS_WRITE)
  async updateProduct(
    @Req() req: RequestWithTenant,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(updateProductSchema)) body: UpdateProductDto,
  ): Promise<ProductDto> {
    return this.productsService.updateProduct(req.tenantId!, id, body);
  }

  @Post(":id/image")
  @ApiConsumes("multipart/form-data")
  @ApiBody({
    schema: {
      type: "object",
      required: ["image"],
      properties: { image: { type: "string", format: "binary" } },
    },
  })
  @UseInterceptors(
    FileInterceptor("image", {
      storage: memoryStorage(),
      limits: { fileSize: 5 * 1024 * 1024, files: 1 },
    }),
  )
  @UseFilters(ProductImageUploadFilter)
  @RequireSubscriptionWrite()
  @RequirePermissions(CABINET_CAPABILITY.OPERATIONS_WRITE)
  async uploadImage(
    @Req() req: RequestWithTenant,
    @Param("id") id: string,
    @UploadedFile() file?: Express.Multer.File,
  ): Promise<ProductDto> {
    if (!file) {
      return this.productsService
        .recordImageUploadFailure(req.tenantId!, req.userId!, id, "missing_image")
        .then(() => {
          throw new BadRequestException("Product image file is required");
        });
    }
    return this.productsService.uploadImage(req.tenantId!, req.userId!, id, file.buffer);
  }

  @Delete(":id/image")
  @HttpCode(204)
  @RequireSubscriptionWrite()
  @RequirePermissions(CABINET_CAPABILITY.OPERATIONS_WRITE)
  async deleteImage(@Req() req: RequestWithTenant, @Param("id") id: string): Promise<void> {
    return this.productsService.deleteImage(req.tenantId!, req.userId!, id);
  }

  @Get(":id/image/:checksum")
  @RequirePermissions(CABINET_CAPABILITY.OPERATIONS_READ)
  async readImage(
    @Req() req: RequestWithTenant,
    @Param("id") id: string,
    @Param("checksum") checksum: string,
    @Res() response: Response,
  ): Promise<void> {
    const objectKey = await this.productsService.getCurrentImageRead(req.tenantId!, id, checksum);
    response.redirect(HttpStatus.FOUND, await this.storage.presignRead(objectKey, 300));
  }

  @Delete(":id")
  @HttpCode(204)
  @RequireSubscriptionWrite()
  @RequirePermissions(CABINET_CAPABILITY.OPERATIONS_WRITE)
  async deleteProduct(@Req() req: RequestWithTenant, @Param("id") id: string): Promise<void> {
    return this.productsService.deleteProduct(req.tenantId!, id);
  }
}
