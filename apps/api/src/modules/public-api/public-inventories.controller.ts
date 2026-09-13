import { ApiParam } from "@nestjs/swagger";
import { INVENTORY_CHZ_STATUSES } from "@markiro/domain";
import { createHash } from "node:crypto";
import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  Req,
  UnprocessableEntityException,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import { ApiBody, ApiConsumes, ApiOperation, ApiTags } from "@nestjs/swagger";
import { memoryStorage } from "multer";
import type { InventoryChzStatus } from "@markiro/domain";
import {
  publicInventoriesSchema,
  publicInventorySchema,
  publicImportSchema,
  publicSnapshotSchema,
  publicInventoryStartSchema,
  publicInventoryProgressSchema,
  publicInventoryResultsSchema,
} from "@markiro/platform-contracts";
import { ApiHttpErrors, ApiZodBody, ApiZodQuery, ApiZodResponse } from "../../lib/openapi";
import { ZodValidationPipe } from "../../zod.pipe";
import {
  createInventorySchema,
  fixInventorySnapshotSchema,
  inventoryIdSchema,
  inventoryImportStatusSchema,
  type CreateInventoryDto,
  type FixInventorySnapshotDto,
} from "../inventories/dto";
import { CHZ_MAX_INPUT_BYTES } from "../inventories/chz-tabular-reader";
import { InventoriesService } from "../inventories/inventories.service";
import { InventoryLifecycleService } from "../inventories/inventory-lifecycle.service";
import { PublicApiGuard, RequirePublicApiScope } from "./public-api.guard";
import {
  ApiPublicAuth,
  PublicIdempotencyKey,
  idempotencyKeySchema,
  ApiIdempotencyKey,
  publicPrincipal,
  publicProjection,
  emptyPublicBodySchema,
  publicResultsQuerySchema,
  type PublicResultsQuery,
} from "./public-api.dto";
import { PublicApiReadService } from "./public-api-read.service";
import { PublicApiRequestService } from "./public-api-request.service";
import type { RequestWithPublicApiPrincipal } from "./public-api.types";
@ApiTags("public-v1")
@ApiPublicAuth()
@Controller("public/v1/inventories")
@UseGuards(PublicApiGuard)
export class PublicInventoriesController {
  constructor(
    private readonly reads: PublicApiReadService,
    private readonly requests: PublicApiRequestService,
    private readonly inventories: InventoriesService,
    private readonly lifecycle: InventoryLifecycleService,
  ) {}
  @Get()
  @RequirePublicApiScope("inventory.read")
  @ApiOperation({ summary: "List tenant inventories" })
  @ApiZodResponse({ status: 200, schema: publicInventoriesSchema })
  @ApiHttpErrors(401, 403, 429, 503)
  list(@Req() req: RequestWithPublicApiPrincipal) {
    return this.reads.list(publicPrincipal(req));
  }
  @Get(":id")
  @ApiParam({ name: "id", schema: { type: "string", format: "uuid" } })
  @RequirePublicApiScope("inventory.read")
  @ApiOperation({ summary: "Get inventory preparation and lifecycle status" })
  @ApiZodResponse({ status: 200, schema: publicInventorySchema })
  @ApiHttpErrors(400, 401, 403, 404, 429, 503)
  get(
    @Req() req: RequestWithPublicApiPrincipal,
    @Param("id", new ZodValidationPipe(inventoryIdSchema)) id: string,
  ) {
    return this.reads.get(publicPrincipal(req), id);
  }
  @Get(":id/progress")
  @ApiParam({ name: "id", schema: { type: "string", format: "uuid" } })
  @RequirePublicApiScope("inventory.read")
  @ApiOperation({ summary: "Get inventory progress counts" })
  @ApiZodResponse({ status: 200, schema: publicInventoryProgressSchema })
  @ApiHttpErrors(400, 401, 403, 404, 409, 429, 503)
  progress(
    @Req() req: RequestWithPublicApiPrincipal,
    @Param("id", new ZodValidationPipe(inventoryIdSchema)) id: string,
  ) {
    return this.reads.progress(publicPrincipal(req), id);
  }
  @Get(":id/results")
  @ApiParam({ name: "id", schema: { type: "string", format: "uuid" } })
  @RequirePublicApiScope("inventory.read")
  @ApiOperation({
    summary: "Read paginated inventory scan results",
    description:
      "Live evidence ordered by the inventory owner. Continue with the same classification and limit; results may change during factory work.",
  })
  @ApiZodQuery(publicResultsQuerySchema)
  @ApiZodResponse({ status: 200, schema: publicInventoryResultsSchema })
  @ApiHttpErrors(400, 401, 403, 404, 409, 429, 503)
  results(
    @Req() req: RequestWithPublicApiPrincipal,
    @Param("id", new ZodValidationPipe(inventoryIdSchema)) id: string,
    @Query(new ZodValidationPipe(publicResultsQuerySchema)) query: PublicResultsQuery,
  ) {
    return this.reads.results(publicPrincipal(req), id, query);
  }
  @Post()
  @RequirePublicApiScope("inventory.prepare")
  @ApiOperation({ summary: "Create an inventory preparation task" })
  @ApiIdempotencyKey()
  @ApiZodBody(createInventorySchema)
  @ApiZodResponse({ status: 201, schema: publicInventorySchema })
  @ApiHttpErrors(400, 401, 403, 404, 409, 422, 429, 503)
  async create(
    @Req() req: RequestWithPublicApiPrincipal,
    @PublicIdempotencyKey(new ZodValidationPipe(idempotencyKeySchema)) key: string,
    @Body(new ZodValidationPipe(createInventorySchema)) input: CreateInventoryDto,
  ) {
    const principal = publicPrincipal(req);
    const ctx = await this.requests.prepare(principal, "inventory.create", key, input);
    return publicProjection(
      publicInventorySchema,
      await this.inventories.create(principal.tenantId, ctx.actor, input, ctx),
    );
  }
  @Post(":id/imports/:status")
  @ApiParam({ name: "status", enum: INVENTORY_CHZ_STATUSES })
  @ApiParam({ name: "id", schema: { type: "string", format: "uuid" } })
  @RequirePublicApiScope("inventory.prepare")
  @ApiOperation({ summary: "Import a CHZ source file for one status" })
  @ApiIdempotencyKey()
  @UseInterceptors(
    FileInterceptor("file", {
      storage: memoryStorage(),
      defParamCharset: "utf8",
      limits: { fileSize: CHZ_MAX_INPUT_BYTES, files: 1, fields: 0, fieldSize: 0, parts: 2 },
    }),
  )
  @ApiConsumes("multipart/form-data")
  @ApiBody({
    schema: {
      type: "object",
      additionalProperties: false,
      required: ["file"],
      properties: { file: { type: "string", format: "binary" } },
    },
  })
  @ApiZodResponse({ status: 201, schema: publicImportSchema })
  @ApiZodResponse({ status: 422, schema: publicImportSchema })
  @ApiHttpErrors(400, 401, 403, 404, 409, 413, 429, 503)
  async importEvidence(
    @Req() req: RequestWithPublicApiPrincipal,
    @Param("id", new ZodValidationPipe(inventoryIdSchema)) id: string,
    @Param("status", new ZodValidationPipe(inventoryImportStatusSchema)) status: InventoryChzStatus,
    @PublicIdempotencyKey(new ZodValidationPipe(idempotencyKeySchema)) key: string,
    @UploadedFile() file: Express.Multer.File | undefined,
  ) {
    if (!file) throw new BadRequestException({ code: "INVENTORY_IMPORT_FILE_REQUIRED" });
    const principal = publicPrincipal(req);
    const input = { originalName: file.originalname, mimeType: file.mimetype, bytes: file.buffer };
    const ctx = await this.requests.prepare(principal, "inventory.import", key, {
      inventoryId: id,
      declaredStatus: status,
      originalName: input.originalName,
      mimeType: input.mimeType,
      sha256: createHash("sha256").update(input.bytes).digest("hex"),
    });
    const result = publicProjection(
      publicImportSchema,
      await this.inventories.importEvidence(
        principal.tenantId,
        ctx.actor,
        id,
        status,
        input,
        undefined,
        ctx,
      ),
    );
    if (result.result === "failed") throw new UnprocessableEntityException(result);
    return result;
  }
  @Post(":id/snapshots")
  @ApiParam({ name: "id", schema: { type: "string", format: "uuid" } })
  @RequirePublicApiScope("inventory.prepare")
  @ApiOperation({ summary: "Freeze explicitly selected source imports" })
  @ApiIdempotencyKey()
  @ApiZodBody(fixInventorySnapshotSchema)
  @ApiZodResponse({ status: 201, schema: publicSnapshotSchema })
  @ApiHttpErrors(400, 401, 403, 404, 409, 422, 429, 503)
  async snapshot(
    @Req() req: RequestWithPublicApiPrincipal,
    @Param("id", new ZodValidationPipe(inventoryIdSchema)) id: string,
    @PublicIdempotencyKey(new ZodValidationPipe(idempotencyKeySchema)) key: string,
    @Body(new ZodValidationPipe(fixInventorySnapshotSchema)) input: FixInventorySnapshotDto,
  ) {
    const principal = publicPrincipal(req);
    const ctx = await this.requests.prepare(principal, "inventory.snapshot", key, {
      inventoryId: id,
      imports: input.imports,
    });
    return publicProjection(
      publicSnapshotSchema,
      await this.inventories.fixSnapshot(principal.tenantId, ctx.actor, id, input, ctx),
    );
  }
  @Post(":id/start")
  @ApiParam({ name: "id", schema: { type: "string", format: "uuid" } })
  @RequirePublicApiScope("inventory.start")
  @ApiOperation({ summary: "Start the prepared inventory for native factory execution" })
  @ApiIdempotencyKey()
  @ApiZodBody(emptyPublicBodySchema)
  @ApiZodResponse({ status: 201, schema: publicInventoryStartSchema })
  @ApiHttpErrors(400, 401, 403, 404, 409, 422, 429, 503)
  async start(
    @Req() req: RequestWithPublicApiPrincipal,
    @Param("id", new ZodValidationPipe(inventoryIdSchema)) id: string,
    @PublicIdempotencyKey(new ZodValidationPipe(idempotencyKeySchema)) key: string,
    @Body(new ZodValidationPipe(emptyPublicBodySchema)) _body: Record<string, never>,
  ) {
    const principal = publicPrincipal(req);
    const ctx = await this.requests.prepare(principal, "inventory.start", key, { inventoryId: id });
    const manifest = await this.lifecycle.start(principal.tenantId, ctx.actor, id, ctx);
    return publicInventoryStartSchema.parse({
      inventoryId: manifest.inventoryId,
      snapshotId: manifest.snapshotId,
      status: "running",
    });
  }
}
