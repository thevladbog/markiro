import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
  Put,
  Query,
  Req,
  UnauthorizedException,
  UseGuards,
} from "@nestjs/common";
import { ApiCookieAuth, ApiOperation, ApiParam, ApiResponse, ApiTags } from "@nestjs/swagger";
import {
  createReceivingDraftSchema,
  listReceivingLiveRecordsQuerySchema,
  receivingLiveRecordListSchema,
  receivingLiveRecordSchema,
  receivingFinalizeResultSchema,
  finalizeReceivingCommandSchema,
  receivingCreateResultSchema,
  receivingReadinessQuerySchema,
  receivingRevisionReadinessSchema,
  receivingSaveResultSchema,
  receivingLifecycleErrorSchema,
  saveReceivingCommandSchema,
  amendReceivingSchema,
  voidReceivingSchema,
  receivingOperationReceiptV2Schema,
  receivingRevisionListQuerySchema,
  receivingRevisionListSchema,
} from "@markiro/platform-contracts";
import { ApiZodBody, ApiZodQuery, ApiZodResponse } from "../lib/openapi";
import { usMasterDataBadRequestSchema, usMasterDataErrorSchema } from "./us-master-data-openapi";
import { UsRuntime } from "./us-runtime";
import { UsSessionGuard, type UsRequest } from "./us-profile.controller";

@Controller("traceability/receiving")
@UseGuards(UsSessionGuard)
@ApiTags("us-traceability-receiving")
@ApiCookieAuth("markiro-us.session_token")
@ApiResponse({
  status: 400,
  description: "Malformed JSON, UUID or strict receiving draft input.",
  schema: usMasterDataBadRequestSchema,
})
@ApiResponse({
  status: 401,
  description: "A verified US session is required.",
  schema: usMasterDataErrorSchema,
})
@ApiResponse({
  status: 403,
  description: "Current US capability, profile, MFA, Host and mutation Origin are required.",
  schema: usMasterDataErrorSchema,
})
@ApiResponse({
  status: 404,
  description:
    "receiving_draft_not_found or receiving_reference_not_found: the selected record is absent from this tenant.",
  schema: usMasterDataErrorSchema,
})
@ApiResponse({
  status: 409,
  description:
    "receiving_draft_conflict: stale saved version; receiving_operation_conflict: rebound key; receiving_already_finalized: immutable lifecycle; receiving_readiness_changed: recheck references; receiving_lot_conflict: identity race; event_incomplete: typed readiness issues; receiving_reference_inactive: inactive draft reference.",
  schema: usMasterDataErrorSchema,
})
@ApiResponse({
  status: 413,
  description:
    "Create and full draft replacement JSON are bounded at 256 KiB; lifecycle commands and other requests remain bounded at 16 KiB.",
  schema: usMasterDataErrorSchema,
})
@ApiResponse({
  status: 415,
  description: "Uncompressed application/json is required for writes.",
  schema: usMasterDataErrorSchema,
})
@ApiResponse({
  status: 503,
  description: "US profile or database is unavailable; no automatic repair runs.",
  schema: usMasterDataErrorSchema,
})
export class UsReceivingController {
  constructor(@Inject(UsRuntime) private readonly runtime: UsRuntime) {}

  @Get()
  @ApiOperation({
    summary: "List current Receiving records or explicit history",
    description:
      "Requires current US read capability. Defaults to history=current; history=all includes superseded and void records. Four lifecycle statuses, bounded summaries and child counts only; archived references retain saved IDs.",
  })
  @ApiZodQuery(listReceivingLiveRecordsQuerySchema)
  @ApiZodResponse({ status: 200, schema: receivingLiveRecordListSchema })
  list(@Req() request: UsRequest, @Query() query: unknown) {
    const principal = this.principal(request);
    return this.runtime.databaseOperation(() =>
      this.runtime.receiving.listLiveRecords(principal.tenantId, principal.userId, query),
    );
  }

  @Post()
  @ApiOperation({
    summary: "Create an incomplete receiving draft",
    description:
      "Requires receiving write capability and operationKey. Returns a versioned acknowledgement; an identical authorized retry preserves its exact historical response, including legacy formats. Always GET the current record after success. Does not finalize, assign lots, affect inventory or freeze snapshots.",
  })
  @ApiZodBody(createReceivingDraftSchema)
  @ApiZodResponse({ status: 201, schema: receivingCreateResultSchema })
  create(@Req() request: UsRequest, @Body() body: unknown) {
    const principal = this.principal(request);
    const requestId = this.requestId(request);
    return this.runtime.databaseOperation(() =>
      this.runtime.receiving.createDraftCommand(
        principal.tenantId,
        principal.userId,
        body,
        requestId,
      ),
    );
  }

  @Get(":id")
  @ApiOperation({
    summary: "Read current Receiving lifecycle with saved or frozen content",
    description:
      "Requires current US read capability; returns a live versioned envelope, separate from historical command acknowledgements. Frozen snapshots v1/v2/v3 remain unchanged, including amended and void records.",
  })
  @ApiParam({ name: "id", schema: { type: "string", format: "uuid" } })
  @ApiZodResponse({ status: 200, schema: receivingLiveRecordSchema })
  get(@Req() request: UsRequest, @Param("id") id: unknown) {
    const principal = this.principal(request);
    return this.runtime.databaseOperation(() =>
      this.runtime.receiving.getLiveRecord(principal.tenantId, principal.userId, id),
    );
  }

  @Put(":id")
  @ApiOperation({
    summary: "Replace a receiving draft atomically",
    description:
      "Original inputs require receiving write capability; explicit v2 amendment inputs require current QA capability and expectedLifecycleVersion. Both require operationKey and expectedDraftVersion. A changed save increments draftVersion only, never revision. A current unchanged save neither increments nor audits. Rows and document links are full ordered replacements. Returns a historical acknowledgement, not current state; follow with GET even after an exact retry.",
  })
  @ApiParam({ name: "id", schema: { type: "string", format: "uuid" } })
  @ApiZodBody(saveReceivingCommandSchema)
  @ApiZodResponse({ status: 200, schema: receivingSaveResultSchema })
  @ApiZodResponse({ status: 409, schema: receivingLifecycleErrorSchema })
  save(@Req() request: UsRequest, @Param("id") id: unknown, @Body() body: unknown) {
    const principal = this.principal(request);
    const requestId = this.requestId(request);
    return this.runtime.databaseOperation(async () =>
      // Select the trust boundary, not a successfully parsed fallback. Each command
      // reloads capability before strict input validation and historical replay.
      typeof body === "object" && body !== null && "commandVersion" in body
        ? this.runtime.receiving.saveAmendment(
            principal.tenantId,
            principal.userId,
            id,
            body,
            requestId,
          )
        : this.runtime.receiving.saveOriginalDraftCommand(
            principal.tenantId,
            principal.userId,
            id,
            body,
            requestId,
          ),
    );
  }

  @Get(":id/readiness")
  @ApiOperation({
    summary: "Check current saved receiving data readiness",
    description:
      "Requires current US read capability and the saved expectedDraftVersion. Reads the draft and current tenant references in one consistent transaction. Returns v4 readiness bound to the saved draft and current root/predecessor lifecycle. Reports data issues without saving validation state, auditing, assigning lots, locking sources or finalizing. Complete is data readiness only.",
  })
  @ApiParam({ name: "id", schema: { type: "string", format: "uuid" } })
  @ApiZodQuery(receivingReadinessQuerySchema)
  @ApiZodResponse({ status: 200, schema: receivingRevisionReadinessSchema })
  readiness(@Req() request: UsRequest, @Param("id") id: unknown, @Query() query: unknown) {
    const principal = this.principal(request);
    return this.runtime.databaseOperation(() =>
      this.runtime.receiving.checkRevisionReadiness(
        principal.tenantId,
        principal.userId,
        id,
        query,
      ),
    );
  }

  @Post(":id/finalize")
  @HttpCode(200)
  @ApiOperation({
    summary: "Finalize a saved original or amendment Receiving draft",
    description:
      "Requires current QA capability, saved version, readiness digest and receipt-specific exempt reviews. Explicit v2 commands also bind the lifecycle version and predecessor. Atomic lots, source latches, frozen snapshot and audit; exact authorized retries return the original historical acknowledgement, including legacy frozen versions. New results freeze v3; always GET current state after success. Legacy inputs cannot finalize amendments. Limited to 16 KiB JSON.",
  })
  @ApiParam({ name: "id", schema: { type: "string", format: "uuid" } })
  @ApiZodBody(finalizeReceivingCommandSchema)
  @ApiZodResponse({ status: 200, schema: receivingFinalizeResultSchema })
  @ApiZodResponse({ status: 409, schema: receivingLifecycleErrorSchema })
  finalize(@Req() request: UsRequest, @Param("id") id: unknown, @Body() body: unknown) {
    const principal = this.principal(request);
    const requestId = this.requestId(request);
    return this.runtime.databaseOperation(() =>
      this.runtime.receiving.finalizeCommand(
        principal.tenantId,
        principal.userId,
        id,
        body,
        requestId,
      ),
    );
  }

  @Post(":id/amend")
  @ApiOperation({
    summary: "Start a correction of the current finalized Receiving revision",
    description:
      "Requires current QA capability, operationKey, expectedLifecycleVersion and reason. Creates one pending amendment with retained lot bindings; the current receipt remains effective. First success and exact authorized historical replay both return 201. Always GET the returned eventId for current state. Limited to 16 KiB JSON.",
  })
  @ApiParam({ name: "id", schema: { type: "string", format: "uuid" } })
  @ApiZodBody(amendReceivingSchema)
  @ApiZodResponse({ status: 201, schema: receivingOperationReceiptV2Schema })
  @ApiZodResponse({ status: 409, schema: receivingLifecycleErrorSchema })
  amend(@Req() request: UsRequest, @Param("id") id: unknown, @Body() body: unknown) {
    const principal = this.principal(request);
    const requestId = this.requestId(request);
    return this.runtime.databaseOperation(() =>
      this.runtime.receiving.amend(principal.tenantId, principal.userId, id, body, requestId),
    );
  }

  @Post(":id/void")
  @HttpCode(200)
  @ApiOperation({
    summary: "Void a Receiving draft or current finalized revision",
    description:
      "Requires current QA capability, operationKey, reason and expected lifecycle/draft versions; expectedDraftVersion is null for a finalized receipt. Preserves saved or frozen content and all lot business fields. A current receipt with a pending amendment cannot be voided. Exact authorized retries return the historical acknowledgement; always GET current state afterward. Limited to 16 KiB JSON.",
  })
  @ApiParam({ name: "id", schema: { type: "string", format: "uuid" } })
  @ApiZodBody(voidReceivingSchema)
  @ApiZodResponse({ status: 200, schema: receivingOperationReceiptV2Schema })
  @ApiZodResponse({ status: 409, schema: receivingLifecycleErrorSchema })
  void(@Req() request: UsRequest, @Param("id") id: unknown, @Body() body: unknown) {
    const principal = this.principal(request);
    const requestId = this.requestId(request);
    return this.runtime.databaseOperation(() =>
      this.runtime.receiving.void(principal.tenantId, principal.userId, id, body, requestId),
    );
  }

  @Get(":id/revisions")
  @ApiOperation({
    summary: "Read bounded Receiving revision history from any revision UUID",
    description:
      "Requires current US read capability. Includes abandoned drafts and superseded/void revisions in ascending revision order, with the current lifecycle version. Does not fetch every frozen payload or write audit records.",
  })
  @ApiParam({ name: "id", schema: { type: "string", format: "uuid" } })
  @ApiZodQuery(receivingRevisionListQuerySchema)
  @ApiZodResponse({ status: 200, schema: receivingRevisionListSchema })
  revisions(@Req() request: UsRequest, @Param("id") id: unknown, @Query() query: unknown) {
    const principal = this.principal(request);
    return this.runtime.databaseOperation(() =>
      this.runtime.receiving.listRevisions(principal.tenantId, principal.userId, id, query),
    );
  }

  private principal(request: UsRequest) {
    if (!request.usPrincipal) throw new UnauthorizedException("us_session_required");
    return request.usPrincipal;
  }

  private requestId(request: UsRequest) {
    if (!request.usRequestId) throw new UnauthorizedException("us_request_context_required");
    return request.usRequestId;
  }
}
