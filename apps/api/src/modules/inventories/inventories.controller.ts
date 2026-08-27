import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Req,
  Res,
  UnprocessableEntityException,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import {
  ApiBody,
  ApiConsumes,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiParam,
  ApiProduces,
  ApiQuery,
  ApiTags,
  ApiUnprocessableEntityResponse,
} from "@nestjs/swagger";
import type { Response } from "express";
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
  createInventoryDocumentRunOpenApiSchema,
  createInventoryDocumentRunSchema,
  retryInventoryDocumentRunOpenApiSchema,
  retryInventoryDocumentRunSchema,
  createInventoryCorrectionOpenApiSchema,
  createInventoryCorrectionSchema,
  discardInventoryLateEventsOpenApiSchema,
  discardInventoryLateEventsSchema,
  fixInventorySnapshotOpenApiSchema,
  fixInventorySnapshotSchema,
  INVENTORY_DISCREPANCY_CATEGORIES,
  INVENTORY_EVIDENCE_CLASSIFICATIONS,
  INVENTORY_EVIDENCE_KINDS,
  inventoryDetailOpenApiSchema,
  inventoryIdSchema,
  inventoryImportOpenApiSchema,
  inventoryDocumentDownloadOpenApiSchema,
  inventoryDocumentRunOpenApiSchema,
  inventoryDocumentRunsOpenApiSchema,
  inventoryImportStatusSchema,
  inventoryLateEventsDiscardOpenApiSchema,
  inventoryLateEventReplayOpenApiSchema,
  inventoryOpenApiSchema,
  inventoryCorrectionOpenApiSchema,
  closeInventoryOpenApiSchema,
  closeInventorySchema,
  completeInventoryOpenApiSchema,
  completeInventorySchema,
  emergencyCloseInventoryOpenApiSchema,
  emergencyCloseInventorySchema,
  inventoryCloseBlockedOpenApiSchema,
  inventoryCloseOpenApiSchema,
  inventoryClosePreviewOpenApiSchema,
  inventoryCompleteOpenApiSchema,
  inventoryCompletionUnavailableOpenApiSchema,
  inventoryProgressOpenApiSchema,
  inventoryReopenOpenApiSchema,
  inventorySnapshotOpenApiSchema,
  listInventoryDiscrepanciesOpenApiSchema,
  listInventoryDiscrepanciesQuerySchema,
  listInventoryEvidenceOpenApiSchema,
  listInventoryEvidenceQuerySchema,
  listInventoryLateEventsOpenApiSchema,
  listInventoryLateEventsQuerySchema,
  listInventoriesOpenApiSchema,
  updateInventoryOpenApiSchema,
  updateInventorySchema,
  reopenInventoryOpenApiSchema,
  reopenInventorySchema,
  replayInventoryLateEventSchema,
  type CloseInventoryDto,
  type CompleteInventoryDto,
  type CreateInventoryDto,
  type CreateInventoryDocumentRunDto,
  type CreateInventoryCorrectionDto,
  type DiscardInventoryLateEventsDto,
  type FixInventorySnapshotDto,
  type InventoryDto,
  type InventoryDocumentDownloadDto,
  type InventoryDocumentRunDto,
  type InventoryDocumentRunsResponseDto,
  type RetryInventoryDocumentRunDto,
  type InventoryCorrectionDto,
  type EmergencyCloseInventoryDto,
  type InventoryCloseDto,
  type InventoryClosePreviewDto,
  type InventoryCompleteDto,
  type InventoryDetailDto,
  type InventoryImportDto,
  type InventoryLateEventsDiscardDto,
  type InventoryLateEventReplayDto,
  type InventoryProgressDto,
  type InventoryReopenDto,
  type ListInventoryDiscrepanciesQueryDto,
  type ListInventoryDiscrepanciesResponseDto,
  type ListInventoryEvidenceQueryDto,
  type ListInventoryEvidenceResponseDto,
  type ListInventoryLateEventsQueryDto,
  type ListInventoryLateEventsResponseDto,
  type ListInventoriesResponseDto,
  type InventorySnapshotDto,
  type UpdateInventoryDto,
  type ReopenInventoryDto,
  type ReplayInventoryLateEventDto,
} from "./dto";
import { InventoriesService } from "./inventories.service";
import { InventoryLifecycleService } from "./inventory-lifecycle.service";
import { InventoryReconciliationService } from "./inventory-reconciliation.service";
import { InventoryCorrectionsService } from "./inventory-corrections.service";
import { InventoryCloseService } from "./inventory-close.service";
import { InventoryDocumentsService } from "./inventory-documents.service";
import { renderInventoryTaskFormHtml } from "./inventory-task-form";
import {
  stationInventoryEventBatchResponseOpenApiSchema,
  stationInventoryManifestOpenApiSchema,
  type StationInventoryManifest,
} from "./station-inventory.dto";

@ApiTags("inventories")
@Controller("inventories")
@UseGuards(TenantGuard, AuthorizationGuard, SubscriptionAccessGuard)
@AllowSubscriptionReadOnly("read")
export class InventoriesController {
  constructor(
    private readonly inventories: InventoriesService,
    private readonly lifecycle: InventoryLifecycleService,
    private readonly reconciliation: InventoryReconciliationService,
    private readonly corrections: InventoryCorrectionsService,
    private readonly closeService: InventoryCloseService,
    private readonly documents: InventoryDocumentsService,
  ) {}

  @Get()
  @RequirePermissions(CABINET_CAPABILITY.OPERATIONS_READ)
  @ApiOkResponse({ schema: listInventoriesOpenApiSchema })
  list(@Req() req: RequestWithTenant): Promise<ListInventoriesResponseDto> {
    return this.inventories.list(req.tenantId!);
  }

  @Get(":id/progress")
  @RequirePermissions(CABINET_CAPABILITY.OPERATIONS_READ)
  @ApiParam({ name: "id", schema: { type: "string", format: "uuid" } })
  @ApiOkResponse({ schema: inventoryProgressOpenApiSchema })
  progress(
    @Req() req: RequestWithTenant,
    @Param("id", new ZodValidationPipe(inventoryIdSchema)) id: string,
  ): Promise<InventoryProgressDto> {
    return this.reconciliation.getProgress(req.tenantId!, id);
  }

  @Get(":id/close-preview")
  @RequirePermissions(CABINET_CAPABILITY.OPERATIONS_READ)
  @ApiParam({ name: "id", schema: { type: "string", format: "uuid" } })
  @ApiOkResponse({ schema: inventoryClosePreviewOpenApiSchema })
  closePreview(
    @Req() req: RequestWithTenant,
    @Param("id", new ZodValidationPipe(inventoryIdSchema)) id: string,
  ): Promise<InventoryClosePreviewDto> {
    return this.closeService.preview(req.tenantId!, id);
  }

  @Get(":id/task-form")
  @RequirePermissions(CABINET_CAPABILITY.OPERATIONS_READ)
  @ApiParam({ name: "id", schema: { type: "string", format: "uuid" } })
  @ApiProduces("text/html")
  @ApiOkResponse({ schema: { type: "string" } })
  async taskForm(
    @Req() req: RequestWithTenant,
    @Param("id", new ZodValidationPipe(inventoryIdSchema)) id: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<string> {
    const data = await this.inventories.taskFormData(req.tenantId!, id);
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("Cache-Control", "private, no-store");
    return renderInventoryTaskFormHtml(data);
  }

  @Get(":id/discrepancies")
  @RequirePermissions(CABINET_CAPABILITY.OPERATIONS_READ)
  @ApiParam({ name: "id", schema: { type: "string", format: "uuid" } })
  @ApiQuery({ name: "category", required: false, enum: INVENTORY_DISCREPANCY_CATEGORIES })
  @ApiQuery({ name: "page", required: false, schema: { type: "integer", minimum: 1, default: 1 } })
  @ApiQuery({
    name: "pageSize",
    required: false,
    schema: { type: "integer", minimum: 1, maximum: 100, default: 50 },
  })
  @ApiOkResponse({ schema: listInventoryDiscrepanciesOpenApiSchema })
  discrepancies(
    @Req() req: RequestWithTenant,
    @Param("id", new ZodValidationPipe(inventoryIdSchema)) id: string,
    @Query(new ZodValidationPipe(listInventoryDiscrepanciesQuerySchema))
    query: ListInventoryDiscrepanciesQueryDto,
  ): Promise<ListInventoryDiscrepanciesResponseDto> {
    return this.reconciliation.listDiscrepancies(req.tenantId!, id, query);
  }

  @Get(":id/evidence")
  @RequirePermissions(CABINET_CAPABILITY.OPERATIONS_READ)
  @ApiParam({ name: "id", schema: { type: "string", format: "uuid" } })
  @ApiQuery({ name: "search", required: false, schema: { type: "string", maxLength: 128 } })
  @ApiQuery({ name: "kind", required: false, enum: INVENTORY_EVIDENCE_KINDS })
  @ApiQuery({
    name: "classification",
    required: false,
    enum: INVENTORY_EVIDENCE_CLASSIFICATIONS,
  })
  @ApiQuery({ name: "page", required: false, schema: { type: "integer", minimum: 1, default: 1 } })
  @ApiQuery({
    name: "pageSize",
    required: false,
    schema: { type: "integer", minimum: 1, maximum: 100, default: 50 },
  })
  @ApiOkResponse({ schema: listInventoryEvidenceOpenApiSchema })
  evidence(
    @Req() req: RequestWithTenant,
    @Param("id", new ZodValidationPipe(inventoryIdSchema)) id: string,
    @Query(new ZodValidationPipe(listInventoryEvidenceQuerySchema))
    query: ListInventoryEvidenceQueryDto,
  ): Promise<ListInventoryEvidenceResponseDto> {
    return this.reconciliation.listEvidence(req.tenantId!, id, query);
  }

  @Get(":id/late-events")
  @RequirePermissions(CABINET_CAPABILITY.OPERATIONS_READ)
  @ApiParam({ name: "id", schema: { type: "string", format: "uuid" } })
  @ApiQuery({ name: "page", required: false, schema: { type: "integer", minimum: 1, default: 1 } })
  @ApiQuery({
    name: "pageSize",
    required: false,
    schema: { type: "integer", minimum: 1, maximum: 100, default: 50 },
  })
  @ApiOkResponse({ schema: listInventoryLateEventsOpenApiSchema })
  lateEvents(
    @Req() req: RequestWithTenant,
    @Param("id", new ZodValidationPipe(inventoryIdSchema)) id: string,
    @Query(new ZodValidationPipe(listInventoryLateEventsQuerySchema))
    query: ListInventoryLateEventsQueryDto,
  ): Promise<ListInventoryLateEventsResponseDto> {
    return this.closeService.listLateEvents(req.tenantId!, id, query);
  }

  @Get(":id/document-runs")
  @RequirePermissions(CABINET_CAPABILITY.OPERATIONS_READ)
  @ApiParam({ name: "id", schema: { type: "string", format: "uuid" } })
  @ApiOkResponse({ schema: inventoryDocumentRunsOpenApiSchema })
  documentRuns(
    @Req() req: RequestWithTenant,
    @Param("id", new ZodValidationPipe(inventoryIdSchema)) id: string,
  ): Promise<InventoryDocumentRunsResponseDto> {
    return this.documents.list(req.tenantId!, id);
  }

  @Post(":id/document-runs")
  @RequirePermissions(CABINET_CAPABILITY.OPERATIONS_WRITE)
  @RequireSubscriptionWrite()
  @ApiParam({ name: "id", schema: { type: "string", format: "uuid" } })
  @ApiBody({ schema: createInventoryDocumentRunOpenApiSchema })
  @ApiCreatedResponse({ schema: inventoryDocumentRunOpenApiSchema })
  createDocumentRun(
    @Req() req: RequestWithTenant,
    @Param("id", new ZodValidationPipe(inventoryIdSchema)) id: string,
    @Body(new ZodValidationPipe(createInventoryDocumentRunSchema))
    body: CreateInventoryDocumentRunDto,
  ): Promise<InventoryDocumentRunDto> {
    return this.documents.create(req.tenantId!, req.userId!, id, body);
  }

  @Post(":id/late-events/discard")
  @RequirePermissions(CABINET_CAPABILITY.OPERATIONS_WRITE)
  @RequireSubscriptionWrite()
  @ApiParam({ name: "id", schema: { type: "string", format: "uuid" } })
  @ApiBody({ schema: discardInventoryLateEventsOpenApiSchema })
  @ApiCreatedResponse({ schema: inventoryLateEventsDiscardOpenApiSchema })
  discardLateEvents(
    @Req() req: RequestWithTenant,
    @Param("id", new ZodValidationPipe(inventoryIdSchema)) id: string,
    @Body(new ZodValidationPipe(discardInventoryLateEventsSchema))
    body: DiscardInventoryLateEventsDto,
  ): Promise<InventoryLateEventsDiscardDto> {
    return this.closeService.discardLateEvents(req.tenantId!, req.userId!, id, body);
  }

  @Post(":id/late-events/:lateEventId/replay")
  @RequirePermissions(CABINET_CAPABILITY.OPERATIONS_WRITE)
  @RequireSubscriptionWrite()
  @ApiParam({ name: "id", schema: { type: "string", format: "uuid" } })
  @ApiParam({ name: "lateEventId", schema: { type: "string", format: "uuid" } })
  @ApiBody({ schema: reopenInventoryOpenApiSchema })
  @ApiCreatedResponse({
    schema: inventoryLateEventReplayOpenApiSchema(stationInventoryEventBatchResponseOpenApiSchema),
  })
  replayLateEvent(
    @Req() req: RequestWithTenant,
    @Param("id", new ZodValidationPipe(inventoryIdSchema)) id: string,
    @Param("lateEventId", new ZodValidationPipe(inventoryIdSchema)) lateEventId: string,
    @Body(new ZodValidationPipe(replayInventoryLateEventSchema)) _body: ReplayInventoryLateEventDto,
  ): Promise<InventoryLateEventReplayDto> {
    return this.closeService.replayLateEvent(req.tenantId!, req.userId!, id, lateEventId);
  }

  @Post(":id/close")
  @RequirePermissions(CABINET_CAPABILITY.OPERATIONS_WRITE)
  @RequireSubscriptionWrite()
  @ApiParam({ name: "id", schema: { type: "string", format: "uuid" } })
  @ApiBody({ schema: closeInventoryOpenApiSchema })
  @ApiCreatedResponse({ schema: inventoryCloseOpenApiSchema })
  @ApiConflictResponse({ schema: inventoryCloseBlockedOpenApiSchema })
  close(
    @Req() req: RequestWithTenant,
    @Param("id", new ZodValidationPipe(inventoryIdSchema)) id: string,
    @Body(new ZodValidationPipe(closeInventorySchema)) _body: CloseInventoryDto,
  ): Promise<InventoryCloseDto> {
    return this.closeService.close(req.tenantId!, req.userId!, id);
  }

  @Post(":id/emergency-close")
  @RequirePermissions(CABINET_CAPABILITY.OPERATIONS_WRITE)
  @RequireSubscriptionWrite()
  @ApiParam({ name: "id", schema: { type: "string", format: "uuid" } })
  @ApiBody({ schema: emergencyCloseInventoryOpenApiSchema })
  @ApiCreatedResponse({ schema: inventoryCloseOpenApiSchema })
  emergencyClose(
    @Req() req: RequestWithTenant,
    @Param("id", new ZodValidationPipe(inventoryIdSchema)) id: string,
    @Body(new ZodValidationPipe(emergencyCloseInventorySchema))
    body: EmergencyCloseInventoryDto,
  ): Promise<InventoryCloseDto> {
    return this.closeService.emergencyClose(req.tenantId!, req.userId!, id, body);
  }

  @Post(":id/reopen")
  @RequirePermissions(CABINET_CAPABILITY.OPERATIONS_WRITE)
  @RequireSubscriptionWrite()
  @ApiParam({ name: "id", schema: { type: "string", format: "uuid" } })
  @ApiBody({ schema: reopenInventoryOpenApiSchema })
  @ApiCreatedResponse({ schema: inventoryReopenOpenApiSchema })
  reopen(
    @Req() req: RequestWithTenant,
    @Param("id", new ZodValidationPipe(inventoryIdSchema)) id: string,
    @Body(new ZodValidationPipe(reopenInventorySchema)) _body: ReopenInventoryDto,
  ): Promise<InventoryReopenDto> {
    return this.closeService.reopen(req.tenantId!, req.userId!, id);
  }

  @Post(":id/complete")
  @RequirePermissions(CABINET_CAPABILITY.OPERATIONS_WRITE)
  @RequireSubscriptionWrite()
  @ApiParam({ name: "id", schema: { type: "string", format: "uuid" } })
  @ApiBody({ schema: completeInventoryOpenApiSchema })
  @ApiCreatedResponse({ schema: inventoryCompleteOpenApiSchema })
  @ApiConflictResponse({ schema: inventoryCompletionUnavailableOpenApiSchema })
  complete(
    @Req() req: RequestWithTenant,
    @Param("id", new ZodValidationPipe(inventoryIdSchema)) id: string,
    @Body(new ZodValidationPipe(completeInventorySchema)) body: CompleteInventoryDto,
  ): Promise<InventoryCompleteDto> {
    return this.closeService.complete(req.tenantId!, req.userId!, id, body);
  }

  @Post(":id/corrections")
  @RequirePermissions(CABINET_CAPABILITY.OPERATIONS_WRITE)
  @RequireSubscriptionWrite()
  @ApiParam({ name: "id", schema: { type: "string", format: "uuid" } })
  @ApiBody({ schema: createInventoryCorrectionOpenApiSchema })
  @ApiCreatedResponse({ schema: inventoryCorrectionOpenApiSchema })
  correct(
    @Req() req: RequestWithTenant,
    @Param("id", new ZodValidationPipe(inventoryIdSchema)) id: string,
    @Body(new ZodValidationPipe(createInventoryCorrectionSchema))
    body: CreateInventoryCorrectionDto,
  ): Promise<InventoryCorrectionDto> {
    return this.corrections.correct(req.tenantId!, req.userId!, id, body);
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
  @ApiOkResponse({ schema: inventoryDetailOpenApiSchema })
  get(
    @Req() req: RequestWithTenant,
    @Param("id", new ZodValidationPipe(inventoryIdSchema)) id: string,
  ): Promise<InventoryDetailDto> {
    return this.inventories.getDetail(req.tenantId!, id);
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

  @Post(":id/start")
  @RequirePermissions(CABINET_CAPABILITY.OPERATIONS_WRITE)
  @RequireSubscriptionWrite()
  @ApiParam({ name: "id", schema: { type: "string", format: "uuid" } })
  @ApiCreatedResponse({ schema: stationInventoryManifestOpenApiSchema })
  start(
    @Req() req: RequestWithTenant,
    @Param("id", new ZodValidationPipe(inventoryIdSchema)) id: string,
  ): Promise<StationInventoryManifest> {
    return this.lifecycle.start(req.tenantId!, req.userId!, id);
  }
}

@ApiTags("inventory-documents")
@Controller("inventory-document-runs")
@UseGuards(TenantGuard, AuthorizationGuard, SubscriptionAccessGuard)
@AllowSubscriptionReadOnly("read")
export class InventoryDocumentRunsController {
  constructor(private readonly documents: InventoryDocumentsService) {}

  @Post(":runId/retry")
  @RequirePermissions(CABINET_CAPABILITY.OPERATIONS_WRITE)
  @RequireSubscriptionWrite()
  @ApiParam({ name: "runId", schema: { type: "string", format: "uuid" } })
  @ApiBody({ schema: retryInventoryDocumentRunOpenApiSchema })
  @ApiCreatedResponse({ schema: inventoryDocumentRunOpenApiSchema })
  retry(
    @Req() req: RequestWithTenant,
    @Param("runId", new ZodValidationPipe(inventoryIdSchema)) runId: string,
    @Body(new ZodValidationPipe(retryInventoryDocumentRunSchema))
    _body: RetryInventoryDocumentRunDto,
  ): Promise<InventoryDocumentRunDto> {
    return this.documents.retry(req.tenantId!, req.userId!, runId);
  }

  @Get(":runId/artifacts/:artifactId/download")
  @RequirePermissions(CABINET_CAPABILITY.OPERATIONS_READ)
  @ApiParam({ name: "runId", schema: { type: "string", format: "uuid" } })
  @ApiParam({ name: "artifactId", schema: { type: "string", format: "uuid" } })
  @ApiOkResponse({ schema: inventoryDocumentDownloadOpenApiSchema })
  downloadArtifact(
    @Req() req: RequestWithTenant,
    @Param("runId", new ZodValidationPipe(inventoryIdSchema)) runId: string,
    @Param("artifactId", new ZodValidationPipe(inventoryIdSchema)) artifactId: string,
  ): Promise<InventoryDocumentDownloadDto> {
    return this.documents.downloadArtifact(req.tenantId!, req.userId!, runId, artifactId);
  }

  @Get(":runId/download")
  @RequirePermissions(CABINET_CAPABILITY.OPERATIONS_READ)
  @ApiParam({ name: "runId", schema: { type: "string", format: "uuid" } })
  @ApiOkResponse({ schema: inventoryDocumentDownloadOpenApiSchema })
  downloadZip(
    @Req() req: RequestWithTenant,
    @Param("runId", new ZodValidationPipe(inventoryIdSchema)) runId: string,
  ): Promise<InventoryDocumentDownloadDto> {
    return this.documents.downloadZip(req.tenantId!, req.userId!, runId);
  }
}
