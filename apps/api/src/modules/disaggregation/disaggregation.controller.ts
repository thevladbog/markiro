import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Req,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import { memoryStorage } from "multer";
import { ApiConsumes, ApiTags } from "@nestjs/swagger";
import { CABINET_CAPABILITY } from "@markiro/domain";
import { RequirePermissions } from "../../authorization/access-policy";
import { AuthorizationGuard } from "../../authorization/authorization.guard";
import {
  AllowSubscriptionReadOnly,
  RequireSubscriptionWrite,
} from "../../subscriptions/subscription-access-policy";
import { SubscriptionAccessGuard } from "../../subscriptions/subscription-access.guard";
import { TenantGuard, type RequestWithTenant } from "../../tenancy/tenant.guard";
import { ZodValidationPipe } from "../../zod.pipe";
import {
  addLinesSchema,
  createDocumentSchema,
  listDocumentsQuerySchema,
  updateDocumentSchema,
  type AddLinesDto,
  type CreateDocumentDto,
  type ListDocumentsQueryDto,
  type UpdateDocumentDto,
} from "./dto";
import { DisaggregationService } from "./disaggregation.service";
import { parseSsccImport } from "./import-parser";

@ApiTags("disaggregation")
@Controller("disaggregation")
@UseGuards(TenantGuard, AuthorizationGuard, SubscriptionAccessGuard)
@AllowSubscriptionReadOnly("read")
export class DisaggregationController {
  constructor(private readonly service: DisaggregationService) {}

  @Get()
  @RequirePermissions(CABINET_CAPABILITY.OPERATIONS_READ)
  list(
    @Req() req: RequestWithTenant,
    @Query(new ZodValidationPipe(listDocumentsQuerySchema)) query: ListDocumentsQueryDto,
  ) {
    return this.service.listDocuments(req.tenantId!, query);
  }

  @Post()
  @RequireSubscriptionWrite()
  @RequirePermissions(CABINET_CAPABILITY.OPERATIONS_WRITE)
  create(
    @Req() req: RequestWithTenant,
    @Body(new ZodValidationPipe(createDocumentSchema)) body: CreateDocumentDto,
  ) {
    return this.service.createDocument(req.tenantId!, req.userId!, body);
  }

  @Get(":id")
  @RequirePermissions(CABINET_CAPABILITY.OPERATIONS_READ)
  get(@Req() req: RequestWithTenant, @Param("id", new ParseUUIDPipe()) id: string) {
    return this.service.getDocument(req.tenantId!, id);
  }

  @Patch(":id")
  @RequireSubscriptionWrite()
  @RequirePermissions(CABINET_CAPABILITY.OPERATIONS_WRITE)
  update(
    @Req() req: RequestWithTenant,
    @Param("id", new ParseUUIDPipe()) id: string,
    @Body(new ZodValidationPipe(updateDocumentSchema)) body: UpdateDocumentDto,
  ) {
    return this.service.updateDocument(req.tenantId!, id, body);
  }

  @Post(":id/cancel")
  @HttpCode(200)
  @RequireSubscriptionWrite()
  @RequirePermissions(CABINET_CAPABILITY.OPERATIONS_WRITE)
  cancel(@Req() req: RequestWithTenant, @Param("id", new ParseUUIDPipe()) id: string) {
    return this.service.cancelDocument(req.tenantId!, id);
  }

  @Post(":id/lines")
  @RequireSubscriptionWrite()
  @RequirePermissions(CABINET_CAPABILITY.OPERATIONS_WRITE)
  addLines(
    @Req() req: RequestWithTenant,
    @Param("id", new ParseUUIDPipe()) id: string,
    @Body(new ZodValidationPipe(addLinesSchema)) body: AddLinesDto,
  ) {
    return this.service.addLines(req.tenantId!, id, body.ssccs);
  }

  @Post(":id/import")
  @HttpCode(201)
  @RequireSubscriptionWrite()
  @RequirePermissions(CABINET_CAPABILITY.OPERATIONS_WRITE)
  @UseInterceptors(
    FileInterceptor("file", { storage: memoryStorage(), limits: { fileSize: 1024 * 1024, files: 1 } }),
  )
  @ApiConsumes("multipart/form-data")
  async importLines(
    @Req() req: RequestWithTenant,
    @Param("id", new ParseUUIDPipe()) id: string,
    @UploadedFile() file: Express.Multer.File | undefined,
  ) {
    if (!file) throw new BadRequestException({ code: "file_required" });
    const tokens = parseSsccImport(file.buffer.toString("utf8"));
    if (tokens.length === 0) throw new BadRequestException({ code: "file_empty" });
    return this.service.importLines(req.tenantId!, id, tokens);
  }

  @Delete(":id/lines/:lineId")
  @HttpCode(204)
  @RequireSubscriptionWrite()
  @RequirePermissions(CABINET_CAPABILITY.OPERATIONS_WRITE)
  removeLine(
    @Req() req: RequestWithTenant,
    @Param("id", new ParseUUIDPipe()) id: string,
    @Param("lineId", new ParseUUIDPipe()) lineId: string,
  ) {
    return this.service.removeLine(req.tenantId!, id, lineId);
  }
}
