import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
  Req,
  UnauthorizedException,
  UseGuards,
} from "@nestjs/common";
import { ApiCookieAuth, ApiOperation, ApiParam, ApiResponse, ApiTags } from "@nestjs/swagger";
import {
  platformUuidSchema,
  receivingCsvPreviewInputSchema,
  receivingCsvApplyInputSchema,
  receivingCsvApplyResponseSchema,
  receivingCsvPreviewSchema,
} from "@markiro/platform-contracts";
import { ApiZodBody, ApiZodResponse } from "../lib/openapi";
import {
  csvPreviewUnavailable,
  type receivingCsvPreviewResponse,
} from "../modules/traceability/receiving/us-receiving-csv-preview";
import { csvApplyUnavailable } from "../modules/traceability/receiving/us-receiving-csv-receipt";
import { usMasterDataErrorSchema } from "./us-master-data-openapi";
import { UsSessionGuard, type UsRequest } from "./us-profile.controller";
import { UsRuntime } from "./us-runtime";

/** Explicit projection: stored bytes and the original raw header never leave the server. */
function previewResponse(saved: ReturnType<typeof receivingCsvPreviewResponse>) {
  const { content } = saved;
  const response = receivingCsvPreviewSchema.safeParse({
    responseVersion: 1,
    id: saved.id,
    templateVersion: saved.templateVersion,
    fileName: saved.fileName,
    byteSize: saved.byteSize,
    fileSha256: saved.fileSha256,
    rowCount: saved.rowCount,
    header: saved.header,
    resolution: saved.resolution,
    proposedDraft: saved.proposedDraft,
    previewDigest: saved.previewDigest,
    createdBy: saved.createdBy,
    createdAt: saved.createdAt,
    expiresAt: saved.expiresAt,
    fileError: content.ok ? null : content.error,
    rows: content.ok
      ? content.rows.map((row) => ({
          rowNumber: row.rowNumber,
          lineNumber: row.lineNumber,
          cells: row.cells,
          issues: row.validation.ok ? [] : row.validation.issues,
          normalizations: row.validation.ok ? row.validation.normalizations : [],
        }))
      : [],
  });
  if (!response.success) throw csvPreviewUnavailable();
  return response.data;
}

@Controller("traceability/receiving/imports")
@UseGuards(UsSessionGuard)
@ApiTags("us-traceability-receiving")
@ApiCookieAuth("markiro-us.session_token")
@ApiResponse({
  status: 400,
  description:
    "Invalid UUID, strict JSON input or canonical base64; decoded CSV is limited to 256 KiB.",
  schema: usMasterDataErrorSchema,
})
@ApiResponse({
  status: 401,
  description: "A verified US session is required.",
  schema: usMasterDataErrorSchema,
})
@ApiResponse({
  status: 403,
  description:
    "Current receiving WRITE capability (including saved GET and replay), MFA, US profile, Host and mutation Origin are required.",
  schema: usMasterDataErrorSchema,
})
@ApiResponse({
  status: 404,
  description: "receiving_csv_preview_not_found: no saved preview in this tenant.",
  schema: usMasterDataErrorSchema,
})
@ApiResponse({
  status: 409,
  description:
    "receiving_csv_preview_not_applicable, receiving_csv_preview_conflict, receiving_csv_preview_expired, receiving_csv_preview_stale or receiving_operation_conflict; nothing is partially applied.",
  schema: usMasterDataErrorSchema,
})
@ApiResponse({
  status: 413,
  description:
    "Only preview POST accepts 512 KiB JSON. Apply and other import requests remain limited to 16 KiB.",
  schema: usMasterDataErrorSchema,
})
@ApiResponse({
  status: 415,
  description: "Uncompressed application/json is required for writes.",
  schema: usMasterDataErrorSchema,
})
@ApiResponse({
  status: 503,
  description:
    "US database/profile or saved CSV evidence is unavailable. No automatic repair or retry.",
  schema: usMasterDataErrorSchema,
})
export class UsReceivingCsvController {
  constructor(@Inject(UsRuntime) private readonly runtime: UsRuntime) {}

  @Post("preview")
  @ApiOperation({
    summary: "Save a Receiving CSV preview without creating an event",
    description:
      "One v1 file, 1–100 rows. Returns raw cells, row errors, normalizations and a normalized header/proposal; raw header and file bytes stay stored privately. Invalid CSV yields saved findings, not a partial draft. Preview expires for first application after 24 hours.",
  })
  @ApiZodBody(receivingCsvPreviewInputSchema)
  @ApiZodResponse({ status: 201, schema: receivingCsvPreviewSchema })
  create(@Req() request: UsRequest, @Body() body: unknown) {
    const principal = this.principal(request);
    const requestId = this.requestId(request);
    return this.runtime.databaseOperation(async () =>
      previewResponse(
        await this.runtime.receivingCsv.createPreview(
          principal.tenantId,
          principal.userId,
          body,
          requestId,
        ),
      ),
    );
  }

  @Get(":id")
  @ApiOperation({
    summary: "Read saved Receiving CSV evidence",
    description:
      "Requires current WRITE capability. Returns saved findings even after expiry; never re-resolves references against today's catalog.",
  })
  @ApiParam({ name: "id", schema: { type: "string", format: "uuid" } })
  @ApiZodResponse({ status: 200, schema: receivingCsvPreviewSchema })
  get(@Req() request: UsRequest, @Param("id") id: unknown) {
    const principal = this.principal(request);
    return this.runtime.databaseOperation(async () =>
      previewResponse(
        await this.runtime.receivingCsv.getPreview(principal.tenantId, principal.userId, id),
      ),
    );
  }

  @Post(":id/apply")
  @HttpCode(200)
  @ApiOperation({
    summary: "Apply saved CSV once to a new original Receiving draft",
    description:
      "Current request correlation is separate from the immutable original receipt. Another key on an applied preview returns the same original outcome, not a new delivery; equal-content alias previews may return another original importId. Always GET /traceability/receiving/{receipt.eventId} after acknowledgement. Never automatically resubmit creation. Does not finalize, assign lots or perform QA.",
  })
  @ApiParam({ name: "id", schema: { type: "string", format: "uuid" } })
  @ApiZodBody(receivingCsvApplyInputSchema)
  @ApiZodResponse({ status: 200, schema: receivingCsvApplyResponseSchema })
  apply(@Req() request: UsRequest, @Param("id") id: unknown, @Body() body: unknown) {
    const principal = this.principal(request);
    const requestId = this.requestId(request);
    const captured = structuredClone(body);
    return this.runtime.databaseOperation(async () => {
      // The store reloads current capability before input parsing and historical replay.
      const receipt = await this.runtime.receivingCsv.applyPreview(
        principal.tenantId,
        principal.userId,
        id,
        captured,
        requestId,
      );
      const response = receivingCsvApplyResponseSchema.safeParse({
        responseVersion: 1,
        request: {
          importId: platformUuidSchema.parse(id),
          ...receivingCsvApplyInputSchema.parse(captured),
        },
        receipt,
      });
      if (!response.success) throw csvApplyUnavailable();
      return response.data;
    });
  }

  private principal(request: UsRequest) {
    if (!request.usPrincipal) throw new UnauthorizedException("us_session_required");
    return request.usPrincipal;
  }
  private requestId(request: UsRequest) {
    if (!request.usRequestId) throw new UnauthorizedException("us_request_required");
    return request.usRequestId;
  }
}
