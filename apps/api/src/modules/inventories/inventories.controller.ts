import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Req,
  UnprocessableEntityException,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import {
  ApiBody,
  ApiConsumes,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiParam,
  ApiTags,
  ApiUnprocessableEntityResponse,
} from "@nestjs/swagger";
import { memoryStorage } from "multer";

import {
  CABINET_CAPABILITY,
  INVENTORY_CHZ_STATUSES,
  type InventoryChzStatus,
} from "@markiro/domain";

import { RequirePermissions } from "../../authorization/access-policy";
import { AuthorizationGuard } from "../../authorization/authorization.guard";
import {
  AllowSubscriptionReadOnly,
  RequireSubscriptionWrite,
} from "../../subscriptions/subscription-access-policy";
import { SubscriptionAccessGuard } from "../../subscriptions/subscription-access.guard";
import { TenantGuard, type RequestWithTenant } from "../../tenancy/tenant.guard";
import { ZodValidationPipe } from "../../zod.pipe";
import { CHZ_MAX_COMPRESSED_BYTES } from "./chz-tabular-reader";
import {
  createInventoryOpenApiSchema,
  createInventorySchema,
  fixInventorySnapshotOpenApiSchema,
  fixInventorySnapshotSchema,
  inventoryIdSchema,
  inventoryImportOpenApiSchema,
  inventoryImportStatusSchema,
  inventoryOpenApiSchema,
  inventorySnapshotOpenApiSchema,
  listInventoriesOpenApiSchema,
  updateInventoryOpenApiSchema,
  updateInventorySchema,
  type CreateInventoryDto,
  type FixInventorySnapshotDto,
  type InventoryDto,
  type InventoryImportDto,
  type ListInventoriesResponseDto,
  type InventorySnapshotDto,
  type UpdateInventoryDto,
} from "./dto";
import { InventoriesService } from "./inventories.service";

@ApiTags("inventories")
@Controller("inventories")
@UseGuards(TenantGuard, AuthorizationGuard, SubscriptionAccessGuard)
@AllowSubscriptionReadOnly("read")
export class InventoriesController {
  constructor(private readonly inventories: InventoriesService) {}

  @Get()
  @RequirePermissions(CABINET_CAPABILITY.OPERATIONS_READ)
  @ApiOkResponse({ schema: listInventoriesOpenApiSchema })
  list(@Req() req: RequestWithTenant): Promise<ListInventoriesResponseDto> {
    return this.inventories.list(req.tenantId!);
  }

  @Post()
  @RequirePermissions(CABINET_CAPABILITY.OPERATIONS_WRITE)
  @RequireSubscriptionWrite()
  @ApiBody({ schema: createInventoryOpenApiSchema })
  @ApiCreatedResponse({ schema: inventoryOpenApiSchema })
  create(
    @Req() req: RequestWithTenant,
    @Body(new ZodValidationPipe(createInventorySchema)) body: CreateInventoryDto,
  ): Promise<InventoryDto> {
    return this.inventories.create(req.tenantId!, req.userId!, body);
  }

  @Get(":id")
  @RequirePermissions(CABINET_CAPABILITY.OPERATIONS_READ)
  @ApiParam({ name: "id", schema: { type: "string", format: "uuid" } })
  @ApiOkResponse({ schema: inventoryOpenApiSchema })
  get(
    @Req() req: RequestWithTenant,
    @Param("id", new ZodValidationPipe(inventoryIdSchema)) id: string,
  ): Promise<InventoryDto> {
    return this.inventories.get(req.tenantId!, id);
  }

  @Patch(":id")
  @RequirePermissions(CABINET_CAPABILITY.OPERATIONS_WRITE)
  @RequireSubscriptionWrite()
  @ApiParam({ name: "id", schema: { type: "string", format: "uuid" } })
  @ApiBody({ schema: updateInventoryOpenApiSchema })
  @ApiOkResponse({ schema: inventoryOpenApiSchema })
  update(
    @Req() req: RequestWithTenant,
    @Param("id", new ZodValidationPipe(inventoryIdSchema)) id: string,
    @Body(new ZodValidationPipe(updateInventorySchema)) body: UpdateInventoryDto,
  ): Promise<InventoryDto> {
    return this.inventories.update(req.tenantId!, req.userId!, id, body);
  }

  @Post(":id/imports/:status")
  @RequirePermissions(CABINET_CAPABILITY.OPERATIONS_WRITE)
  @RequireSubscriptionWrite()
  @UseInterceptors(
    FileInterceptor("file", {
      storage: memoryStorage(),
      limits: {
        fileSize: CHZ_MAX_COMPRESSED_BYTES,
        files: 1,
        fields: 0,
        fieldSize: 0,
        // Busboy emits `partsLimit` when its boundary counter reaches the
        // configured value, so 2 admits the first actual part and rejects a second.
        parts: 2,
      },
    }),
  )
  @ApiConsumes("multipart/form-data")
  @ApiParam({ name: "id", schema: { type: "string", format: "uuid" } })
  @ApiParam({ name: "status", enum: INVENTORY_CHZ_STATUSES })
  @ApiBody({
    schema: {
      type: "object",
      additionalProperties: false,
      required: ["file"],
      properties: { file: { type: "string", format: "binary" } },
    },
  })
  @ApiCreatedResponse({ schema: inventoryImportOpenApiSchema })
  @ApiUnprocessableEntityResponse({ schema: inventoryImportOpenApiSchema })
  async importEvidence(
    @Req() req: RequestWithTenant,
    @Param("id", new ZodValidationPipe(inventoryIdSchema)) id: string,
    @Param("status", new ZodValidationPipe(inventoryImportStatusSchema))
    status: InventoryChzStatus,
    @UploadedFile() file: Express.Multer.File | undefined,
  ): Promise<InventoryImportDto> {
    if (!file) throw new BadRequestException({ code: "INVENTORY_IMPORT_FILE_REQUIRED" });
    const result = await this.inventories.importEvidence(req.tenantId!, req.userId!, id, status, {
      originalName: file.originalname,
      mimeType: file.mimetype,
      bytes: file.buffer,
    });
    if (result.result === "failed") throw new UnprocessableEntityException(result);
    return result;
  }

  @Post(":id/snapshots")
  @RequirePermissions(CABINET_CAPABILITY.OPERATIONS_WRITE)
  @RequireSubscriptionWrite()
  @ApiParam({ name: "id", schema: { type: "string", format: "uuid" } })
  @ApiBody({ schema: fixInventorySnapshotOpenApiSchema })
  @ApiCreatedResponse({ schema: inventorySnapshotOpenApiSchema })
  fixSnapshot(
    @Req() req: RequestWithTenant,
    @Param("id", new ZodValidationPipe(inventoryIdSchema)) id: string,
    @Body(new ZodValidationPipe(fixInventorySnapshotSchema)) body: FixInventorySnapshotDto,
  ): Promise<InventorySnapshotDto> {
    return this.inventories.fixSnapshot(req.tenantId!, req.userId!, id, body);
  }
}
