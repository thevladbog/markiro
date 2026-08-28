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
import {
  ApiBody,
  ApiConsumes,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiResponse,
  ApiTags,
} from "@nestjs/swagger";
import { CABINET_CAPABILITY } from "@markiro/domain";
import type { Response } from "express";
import { AllowStationOrPermissions, RequirePermissions } from "../../authorization/access-policy";
import { AuthorizationGuard } from "../../authorization/authorization.guard";
import {
  ApiCabinetAuth,
  ApiCabinetOrStationAuth,
  ApiHttpErrors,
  ApiZodBody,
  ApiZodQuery,
  ApiZodValidationError,
} from "../../lib/openapi";
import {
  AllowSubscriptionReadOnly,
  RequireSubscriptionWrite,
} from "../../subscriptions/subscription-access-policy";
import { SubscriptionAccessGuard } from "../../subscriptions/subscription-access.guard";
import { TenantGuard, type RequestWithTenant } from "../../tenancy/tenant.guard";
import { ZodValidationPipe } from "../../zod.pipe";
import { ObjectStorageService } from "../storage/object-storage.service";
import { sendPrivateImage } from "../storage/private-image-response";
import {
  createProductSchema,
  gtinCheckResponseOpenApiSchema,
  gtinCheckSchema,
  listProductsOpenApiSchema,
  listProductsQuerySchema,
  productOpenApiSchema,
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
  @ApiOperation({ summary: "List products" })
  @ApiZodQuery(listProductsQuerySchema)
  @ApiOkResponse({ schema: listProductsOpenApiSchema })
  @ApiZodValidationError()
  @ApiHttpErrors(401, 403)
  @ApiCabinetOrStationAuth()
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
  @ApiOperation({
    summary: "Check GTIN ownership",
    description:
      "Normalizes the GTIN, then reports whether it matches the tenant's own GS1 prefixes, a counterparty's prefixes (first match wins), or is unknown. An unparseable GTIN yields a 400 with code GTIN_INVALID.",
  })
  @ApiZodBody(gtinCheckSchema)
  @ApiOkResponse({ schema: gtinCheckResponseOpenApiSchema })
  @ApiZodValidationError()
  @ApiHttpErrors(401, 403)
  @ApiCabinetOrStationAuth()
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
  @ApiOperation({ summary: "Get a product" })
  @ApiParam({ name: "id", schema: { type: "string", format: "uuid" } })
  @ApiOkResponse({ schema: productOpenApiSchema })
  @ApiHttpErrors(401, 403, 404)
  @ApiCabinetAuth()
  async getProduct(@Req() req: RequestWithTenant, @Param("id") id: string): Promise<ProductDto> {
    return this.productsService.getProduct(req.tenantId!, id);
  }

  @Post()
  @RequireSubscriptionWrite()
  @RequirePermissions(CABINET_CAPABILITY.OPERATIONS_WRITE)
  @ApiOperation({
    summary: "Create a product",
    description:
      "`status` is server-computed: active when productGroup, boxCapacity, and palletCapacity are all set, draft otherwise.",
  })
  @ApiZodBody(createProductSchema)
  @ApiCreatedResponse({ schema: productOpenApiSchema })
  @ApiZodValidationError()
  @ApiHttpErrors(401, 403, 409)
  @ApiCabinetAuth()
  async createProduct(
    @Req() req: RequestWithTenant,
    @Body(new ZodValidationPipe(createProductSchema)) body: CreateProductDto,
  ): Promise<ProductDto> {
    return this.productsService.createProduct(req.tenantId!, body);
  }

  @Patch(":id")
  @RequireSubscriptionWrite()
  @RequirePermissions(CABINET_CAPABILITY.OPERATIONS_WRITE)
  @ApiOperation({
    summary: "Update a product",
    description:
      "Partial update: untouched fields are preserved, explicit null clears a nullable field. `status` is recomputed from the merged values.",
  })
  @ApiParam({ name: "id", schema: { type: "string", format: "uuid" } })
  @ApiZodBody(updateProductSchema)
  @ApiOkResponse({ schema: productOpenApiSchema })
  @ApiZodValidationError()
  @ApiHttpErrors(401, 403, 404, 409)
  @ApiCabinetAuth()
  async updateProduct(
    @Req() req: RequestWithTenant,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(updateProductSchema)) body: UpdateProductDto,
  ): Promise<ProductDto> {
    return this.productsService.updateProduct(req.tenantId!, id, body);
  }

  @Post(":id/image")
  @ApiOperation({
    summary: "Upload a product image",
    description:
      "Replaces the product's image. Accepts one source file of at most 5 MiB; the server re-encodes it to WebP. A missing, oversized, or undecodable file yields a 400.",
  })
  @ApiParam({ name: "id", schema: { type: "string", format: "uuid" } })
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
  @ApiCreatedResponse({ schema: productOpenApiSchema })
  @ApiHttpErrors(400, 401, 403, 404, 503)
  @ApiCabinetAuth()
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
  @ApiOperation({ summary: "Delete a product image" })
  @ApiParam({ name: "id", schema: { type: "string", format: "uuid" } })
  @ApiResponse({
    status: 204,
    description: "Image removed (a no-op when the product has no image).",
  })
  @ApiHttpErrors(401, 403, 404)
  @ApiCabinetAuth()
  async deleteImage(@Req() req: RequestWithTenant, @Param("id") id: string): Promise<void> {
    return this.productsService.deleteImage(req.tenantId!, req.userId!, id);
  }

  @Get(":id/image/:checksum")
  @RequirePermissions(CABINET_CAPABILITY.OPERATIONS_READ)
  @ApiOperation({
    summary: "Download a product image",
    description: "Streams the product's current WebP image through the API origin.",
  })
  @ApiParam({ name: "id", schema: { type: "string", format: "uuid" } })
  @ApiParam({
    name: "checksum",
    schema: { type: "string" },
    description: "Content checksum of the current image (see `image.checksum`).",
  })
  @ApiResponse({
    status: 200,
    description: "The current product image.",
    content: { "image/webp": { schema: { type: "string", format: "binary" } } },
  })
  @ApiHttpErrors(401, 403, 404)
  @ApiCabinetAuth()
  async readImage(
    @Req() req: RequestWithTenant,
    @Param("id") id: string,
    @Param("checksum") checksum: string,
    @Res() response: Response,
  ): Promise<void> {
    const objectKey = await this.productsService.getCurrentImageRead(req.tenantId!, id, checksum);
    await sendPrivateImage(this.storage, objectKey, checksum, response);
  }

  @Delete(":id")
  @HttpCode(204)
  @RequireSubscriptionWrite()
  @RequirePermissions(CABINET_CAPABILITY.OPERATIONS_WRITE)
  @ApiOperation({ summary: "Delete a product" })
  @ApiParam({ name: "id", schema: { type: "string", format: "uuid" } })
  @ApiResponse({ status: 204, description: "Product deleted." })
  @ApiHttpErrors(401, 403, 404, 409)
  @ApiCabinetAuth()
  async deleteProduct(@Req() req: RequestWithTenant, @Param("id") id: string): Promise<void> {
    return this.productsService.deleteProduct(req.tenantId!, id);
  }
}
