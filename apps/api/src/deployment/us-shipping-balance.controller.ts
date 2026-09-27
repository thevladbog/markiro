import {
  Controller,
  Get,
  Inject,
  Param,
  Query,
  Req,
  UnauthorizedException,
  UseGuards,
} from "@nestjs/common";
import { ApiCookieAuth, ApiOperation, ApiParam, ApiResponse, ApiTags } from "@nestjs/swagger";
import {
  platformUuidSchema,
  shippingBalanceResponseSchema,
  shippingHttpErrorSchema,
} from "@markiro/platform-contracts";
import { z } from "zod";
import { ApiZodQuery, ApiZodResponse } from "../lib/openapi";
import { usMasterDataBadRequestSchema, usMasterDataErrorSchema } from "./us-master-data-openapi";
import { UsRuntime } from "./us-runtime";
import { UsSessionGuard, type UsRequest } from "./us-profile.controller";

const version = z
  .string()
  .regex(/^[1-9]\d{0,9}$/)
  .transform(Number)
  .pipe(z.number().int().min(1).max(2147483647));
const httpQuery = z
  .object({
    contextDraftId: platformUuidSchema.optional(),
    expectedDraftVersion: version.optional(),
  })
  .strict()
  .refine(
    (value) => (value.contextDraftId === undefined) === (value.expectedDraftVersion === undefined),
  );

@Controller("traceability/lots")
@UseGuards(UsSessionGuard)
@ApiTags("us-traceability-shipping")
@ApiCookieAuth("markiro-us.session_token")
@ApiResponse({
  status: 400,
  description: "Invalid lot ID or strict query.",
  schema: usMasterDataBadRequestSchema,
})
@ApiResponse({
  status: 401,
  description: "Verified US session required.",
  schema: usMasterDataErrorSchema,
})
@ApiResponse({
  status: 403,
  description: "Current US read membership and profile required.",
  schema: usMasterDataErrorSchema,
})
@ApiResponse({
  status: 404,
  description: "Lot or contextual draft not found in tenant.",
  schema: usMasterDataErrorSchema,
})
@ApiResponse({
  status: 503,
  description: "US storage unavailable.",
  schema: usMasterDataErrorSchema,
})
export class UsShippingBalanceController {
  constructor(@Inject(UsRuntime) private readonly runtime: UsRuntime) {}

  @Get(":id/shipping-balance")
  @ApiOperation({
    summary: "Read current recorded lot balance or replacement Shipping draft preview",
  })
  @ApiParam({ name: "id", schema: { type: "string", format: "uuid" } })
  @ApiZodQuery(httpQuery)
  @ApiZodResponse({ status: 200, schema: shippingBalanceResponseSchema })
  @ApiZodResponse({ status: 409, schema: shippingHttpErrorSchema })
  read(@Req() request: UsRequest, @Param("id") id: unknown, @Query() query: unknown) {
    const principal = request.usPrincipal;
    if (!principal) throw new UnauthorizedException("us_session_required");
    const parsed = httpQuery.safeParse(query);
    // The store owns business validation and authorization; keep HTTP numeric parsing exact.
    const input = parsed.success ? parsed.data : query;
    return this.runtime.databaseOperation(() =>
      this.runtime.shipping.getLotShippingBalance(principal.tenantId, principal.userId, id, input),
    );
  }
}
