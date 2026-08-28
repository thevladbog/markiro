import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  Req,
  UploadedFile,
  UseFilters,
  UseInterceptors,
} from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import { ApiBody, ApiConsumes } from "@nestjs/swagger";
import { memoryStorage } from "multer";
import {
  billingActUploadTooLargeErrorSchema,
  platformCommercialContracts,
} from "@markiro/platform-contracts";
import { RequirePlatformCapabilities } from "../../platform-auth/platform-access-policy";
import type { RequestWithPlatformPrincipal } from "../../platform-auth/platform-auth.guard";
import {
  PlatformApiProtectedCreated,
  PlatformApiProtectedOk,
} from "../../platform-http/platform-openapi";
import { parsePlatformResponse } from "../../platform-http/platform-response";
import { ZodValidationPipe } from "../../zod.pipe";
import {
  billingActCancelSchema,
  billingActCreateSchema,
  billingActIdSchema,
  billingActIssueSchema,
  billingActListQuerySchema,
  type BillingActCancelDto,
  type BillingActCreateDto,
  type BillingActIssueDto,
  type BillingActListQueryDto,
} from "./dto";
import { BillingActsService } from "./billing-acts.service";
import { BillingAttachmentUploadFilter } from "../tenant-billing/billing-attachment-upload.filter";

@Controller("platform/billing/acts")
export class BillingActsController {
  constructor(private readonly acts: BillingActsService) {}

  @Get()
  @PlatformApiProtectedOk({
    query: platformCommercialContracts.billingActs.list.query,
    response: platformCommercialContracts.billingActs.list.response,
  })
  @RequirePlatformCapabilities("billing.read")
  async list(
    @Req() req: RequestWithPlatformPrincipal,
    @Query(new ZodValidationPipe(billingActListQuerySchema)) query: BillingActListQueryDto,
  ) {
    return parsePlatformResponse(
      platformCommercialContracts.billingActs.list.response,
      await this.acts.list(req.platformPrincipal!, query),
    );
  }

  @Get(":id")
  @PlatformApiProtectedOk({ response: platformCommercialContracts.billingActs.detail.response })
  @RequirePlatformCapabilities("billing.read")
  async detail(
    @Req() req: RequestWithPlatformPrincipal,
    @Param("id", new ZodValidationPipe(billingActIdSchema)) id: string,
  ) {
    return parsePlatformResponse(
      platformCommercialContracts.billingActs.detail.response,
      await this.acts.detail(req.platformPrincipal!, id),
    );
  }

  @Post()
  @PlatformApiProtectedCreated({
    body: platformCommercialContracts.billingActs.create.body,
    response: platformCommercialContracts.billingActs.create.response,
  })
  @RequirePlatformCapabilities("billing.write")
  async create(
    @Req() req: RequestWithPlatformPrincipal,
    @Body(new ZodValidationPipe(billingActCreateSchema)) body: BillingActCreateDto,
  ) {
    return parsePlatformResponse(
      platformCommercialContracts.billingActs.create.response,
      await this.acts.create(req.platformPrincipal!, body),
    );
  }

  @Post(":id/issue")
  @UseInterceptors(
    FileInterceptor("file", {
      storage: memoryStorage(),
      limits: { fileSize: 5 * 1024 * 1024, files: 1, fields: 1, parts: 2 },
    }),
  )
  @UseFilters(BillingAttachmentUploadFilter)
  @ApiConsumes("multipart/form-data")
  @ApiBody({
    schema: {
      type: "object",
      additionalProperties: false,
      required: ["idempotencyKey", "file"],
      properties: {
        idempotencyKey: { type: "string", format: "uuid" },
        file: { type: "string", format: "binary" },
      },
    },
  })
  @PlatformApiProtectedCreated({
    response: platformCommercialContracts.billingActs.issue.response,
    errors: [{ status: 413, schema: billingActUploadTooLargeErrorSchema }],
  })
  @RequirePlatformCapabilities("billing.write")
  async issue(
    @Req() req: RequestWithPlatformPrincipal,
    @Param("id", new ZodValidationPipe(billingActIdSchema)) id: string,
    @Body(new ZodValidationPipe(billingActIssueSchema)) body: BillingActIssueDto,
    @UploadedFile() file?: Express.Multer.File,
  ) {
    if (!file) throw new BadRequestException({ code: "billing_act_pdf_required" });
    return parsePlatformResponse(
      platformCommercialContracts.billingActs.issue.response,
      await this.acts.issue(req.platformPrincipal!, id, body, file),
    );
  }

  @Post(":id/cancel")
  @PlatformApiProtectedCreated({
    body: platformCommercialContracts.billingActs.cancel.body,
    response: platformCommercialContracts.billingActs.cancel.response,
  })
  @RequirePlatformCapabilities("billing.write")
  async cancel(
    @Req() req: RequestWithPlatformPrincipal,
    @Param("id", new ZodValidationPipe(billingActIdSchema)) id: string,
    @Body(new ZodValidationPipe(billingActCancelSchema)) body: BillingActCancelDto,
  ) {
    return parsePlatformResponse(
      platformCommercialContracts.billingActs.cancel.response,
      await this.acts.cancel(req.platformPrincipal!, id, body),
    );
  }
}
