import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
  Query,
  Req,
  UploadedFile,
  UseInterceptors,
} from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import { ApiOperation, ApiTags } from "@nestjs/swagger";
import { platformAgreementContracts } from "@markiro/platform-contracts";
import type { z } from "zod";

import { RequirePlatformCapabilities } from "../../platform-auth/platform-access-policy";
import type { RequestWithPlatformPrincipal } from "../../platform-auth/platform-auth.guard";
import {
  PlatformApiProtectedCreated,
  PlatformApiProtectedOk,
} from "../../platform-http/platform-openapi";
import { parsePlatformResponse } from "../../platform-http/platform-response";
import { ZodValidationPipe } from "../../zod.pipe";
import { AgreementDocumentsService, MAX_ATTACHMENT_BYTES } from "./agreement-documents.service";
import { PlatformAgreementsService } from "./platform-agreements.service";

const contracts = platformAgreementContracts;
const idPipe = new ZodValidationPipe(contracts.detail.params);

type CreateBody = z.infer<typeof contracts.create.body>;
type UpdateBody = z.infer<typeof contracts.update.body>;
type TransitionBody = z.infer<typeof contracts.transition.body>;
type LinkBody = z.infer<typeof contracts.linkTenant.body>;
type ListQuery = z.infer<typeof contracts.list.query>;

@ApiTags("platform-agreements")
@Controller("platform/agreements")
export class PlatformAgreementsController {
  constructor(
    private readonly agreements: PlatformAgreementsService,
    private readonly documents: AgreementDocumentsService,
  ) {}

  @Get()
  @ApiOperation({ summary: "List client agreements" })
  @PlatformApiProtectedOk({ response: contracts.list.response, query: contracts.list.query })
  @RequirePlatformCapabilities("agreements.read")
  async list(@Query(new ZodValidationPipe(contracts.list.query)) query: ListQuery) {
    return parsePlatformResponse(contracts.list.response, await this.agreements.list(query));
  }

  @Get(":id")
  @ApiOperation({ summary: "Get a client agreement" })
  @PlatformApiProtectedOk({ response: contracts.detail.response })
  @RequirePlatformCapabilities("agreements.read")
  async detail(@Param("id", idPipe) id: string) {
    return parsePlatformResponse(contracts.detail.response, await this.agreements.detail(id));
  }

  @Get(":id/tenant-candidates")
  @ApiOperation({ summary: "Suggest tenants matching the agreement INN" })
  @PlatformApiProtectedOk({ response: contracts.tenantCandidates.response })
  @RequirePlatformCapabilities("agreements.read")
  async tenantCandidates(@Param("id", idPipe) id: string) {
    return parsePlatformResponse(
      contracts.tenantCandidates.response,
      await this.agreements.tenantCandidates(id),
    );
  }

  @Post()
  @ApiOperation({ summary: "Create a client agreement" })
  @PlatformApiProtectedCreated({
    body: contracts.create.body,
    response: contracts.create.response,
  })
  @RequirePlatformCapabilities("agreements.write")
  async create(
    @Req() req: RequestWithPlatformPrincipal,
    @Body(new ZodValidationPipe(contracts.create.body)) body: CreateBody,
  ) {
    return parsePlatformResponse(
      contracts.create.response,
      await this.agreements.create(req.platformPrincipal!, body),
    );
  }

  @Post(":id")
  @HttpCode(200)
  @ApiOperation({ summary: "Update an editable agreement" })
  @PlatformApiProtectedOk({ body: contracts.update.body, response: contracts.update.response })
  @RequirePlatformCapabilities("agreements.write")
  async update(
    @Req() req: RequestWithPlatformPrincipal,
    @Param("id", idPipe) id: string,
    @Body(new ZodValidationPipe(contracts.update.body)) body: UpdateBody,
  ) {
    return parsePlatformResponse(
      contracts.update.response,
      await this.agreements.update(req.platformPrincipal!, id, body),
    );
  }

  @Post(":id/transition")
  @HttpCode(200)
  @ApiOperation({ summary: "Move an agreement to another status" })
  @PlatformApiProtectedOk({
    body: contracts.transition.body,
    response: contracts.transition.response,
  })
  @RequirePlatformCapabilities("agreements.write")
  async transition(
    @Req() req: RequestWithPlatformPrincipal,
    @Param("id", idPipe) id: string,
    @Body(new ZodValidationPipe(contracts.transition.body)) body: TransitionBody,
  ) {
    return parsePlatformResponse(
      contracts.transition.response,
      await this.agreements.transition(
        req.platformPrincipal!,
        id,
        body.status,
        body.terminationReason,
      ),
    );
  }

  @Post(":id/tenant")
  @HttpCode(200)
  @ApiOperation({ summary: "Link an agreement to a tenant" })
  @PlatformApiProtectedOk({
    body: contracts.linkTenant.body,
    response: contracts.linkTenant.response,
  })
  @RequirePlatformCapabilities("agreements.write")
  async linkTenant(
    @Req() req: RequestWithPlatformPrincipal,
    @Param("id", idPipe) id: string,
    @Body(new ZodValidationPipe(contracts.linkTenant.body)) body: LinkBody,
  ) {
    return parsePlatformResponse(
      contracts.linkTenant.response,
      await this.agreements.linkTenant(req.platformPrincipal!, id, body.tenantId),
    );
  }

  @Delete(":id/tenant")
  @HttpCode(200)
  @ApiOperation({ summary: "Unlink an agreement from its tenant" })
  @PlatformApiProtectedOk({ response: contracts.unlinkTenant.response })
  @RequirePlatformCapabilities("agreements.write")
  async unlinkTenant(@Req() req: RequestWithPlatformPrincipal, @Param("id", idPipe) id: string) {
    return parsePlatformResponse(
      contracts.unlinkTenant.response,
      await this.agreements.unlinkTenant(req.platformPrincipal!, id),
    );
  }

  @Post(":id/documents/draft")
  @HttpCode(200)
  @ApiOperation({ summary: "Render the agreement draft as DOCX" })
  @PlatformApiProtectedOk({ response: contracts.documents.render.response })
  @RequirePlatformCapabilities("agreements.write")
  async renderDraft(@Req() req: RequestWithPlatformPrincipal, @Param("id", idPipe) id: string) {
    const agreement = await this.agreements.requireAgreement(id);
    return parsePlatformResponse(contracts.documents.render.response, {
      document: await this.documents.renderDraft(req.platformPrincipal!, agreement),
    });
  }

  @Post(":id/documents/:documentId/download")
  @HttpCode(200)
  @ApiOperation({ summary: "Get a short-lived download URL for an agreement document" })
  @PlatformApiProtectedOk({ response: contracts.documents.download.response })
  @RequirePlatformCapabilities("agreements.read")
  async download(@Param("id", idPipe) id: string, @Param("documentId", idPipe) documentId: string) {
    return parsePlatformResponse(
      contracts.documents.download.response,
      await this.documents.download(id, documentId),
    );
  }

  @Post(":id/attachments")
  @UseInterceptors(FileInterceptor("file", { limits: { fileSize: MAX_ATTACHMENT_BYTES } }))
  @ApiOperation({ summary: "Attach a signed copy or a related file" })
  @PlatformApiProtectedCreated({ response: contracts.attachments.upload.response })
  @RequirePlatformCapabilities("agreements.write")
  async uploadAttachment(
    @Req() req: RequestWithPlatformPrincipal,
    @Param("id", idPipe) id: string,
    @UploadedFile() file?: { originalname: string; mimetype: string; buffer: Buffer },
  ) {
    if (!file) throw new BadRequestException("Attachment file is required");
    const agreement = await this.agreements.requireAgreement(id);
    return parsePlatformResponse(contracts.attachments.upload.response, {
      document: await this.documents.uploadAttachment(req.platformPrincipal!, agreement, file),
    });
  }

  @Delete(":id/attachments/:documentId")
  @HttpCode(200)
  @ApiOperation({ summary: "Delete an uploaded attachment" })
  @PlatformApiProtectedOk({ response: contracts.attachments.delete.response })
  @RequirePlatformCapabilities("agreements.write")
  async deleteAttachment(
    @Req() req: RequestWithPlatformPrincipal,
    @Param("id", idPipe) id: string,
    @Param("documentId", idPipe) documentId: string,
  ) {
    return parsePlatformResponse(
      contracts.attachments.delete.response,
      await this.documents.deleteAttachment(req.platformPrincipal!, id, documentId),
    );
  }
}
