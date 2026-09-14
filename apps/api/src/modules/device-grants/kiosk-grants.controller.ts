import { GrantEvidenceNativeService } from "./grant-evidence-native.service";
import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Post,
  Req,
  UnauthorizedException,
  UseGuards,
} from "@nestjs/common";
import { ApiOkResponse, ApiOperation, ApiTags } from "@nestjs/swagger";
import { and, eq } from "drizzle-orm";
import { schema } from "@markiro/db";
import {
  grantEvidenceEnvelopeSchema,
  grantEvidenceReceiptSchema,
  type GrantEvidenceEnvelope,
  deviceGrantRequestSchema,
  taskGrantRequestSchema,
  grantIssueResultSchema,
  grantKeysetResultSchema,
  grantConfigurationSchema,
  grantClientReadinessRequestSchema,
  grantClientReadinessResponseSchema,
  kioskGrantReservationRequestSchema,
  kioskGrantReservationResultSchema,
  type DeviceGrantRequest,
  type TaskGrantRequest,
  type KioskGrantReservationRequest,
  type GrantClientReadinessRequest,
} from "@markiro/platform-contracts";
import { KioskDeviceGuard, type RequestWithKiosk } from "../../tenancy/kiosk-device.guard";
import { hashDeviceToken } from "../../pickup/device-token";
import { SubscriptionAccessGuard } from "../../subscriptions/subscription-access.guard";
import {
  AllowSubscriptionReadOnly,
  AllowSubscriptionRecovery,
  RequireSubscriptionWrite,
} from "../../subscriptions/subscription-access-policy";
import { ApiHttpErrors, ApiKioskAuth, ApiZodBody, zodApiSchema } from "../../lib/openapi";
import { ZodValidationPipe } from "../../zod.pipe";
import { PickupOrdersService } from "../pickup-orders/pickup-orders.service";
import { createOrderAdmissionSchema } from "../pickup-orders/dto";
import { GrantIssuerService } from "./grant-issuer.service";
import { freezeGrantTask } from "./frozen-task";
import type { GrantCredentialIdentity } from "./credential-epoch";
import { GrantClientReadinessService } from "./grant-client-readiness.service";
function identity(req: RequestWithKiosk): GrantCredentialIdentity {
  const token = req.headers["x-kiosk-token"];
  if (!req.tenantId || !req.kioskId || typeof token !== "string") throw new UnauthorizedException();
  return {
    tenantId: req.tenantId,
    deviceId: req.kioskId,
    kind: "kiosk",
    tokenHash: hashDeviceToken(token),
  };
}
@ApiTags("kiosk")
@Controller("kiosk/grants/v1")
@UseGuards(KioskDeviceGuard, SubscriptionAccessGuard)
@ApiKioskAuth()
export class KioskGrantsController {
  constructor(
    private readonly issuer: GrantIssuerService,
    private readonly pickup: PickupOrdersService,
    private readonly evidence: GrantEvidenceNativeService,
    private readonly readinessService: GrantClientReadinessService,
  ) {}
  @ApiOperation({ summary: "Issue a signed offline device grant" })
  @Post("device")
  @HttpCode(200)
  @RequireSubscriptionWrite()
  @ApiZodBody(deviceGrantRequestSchema)
  @ApiOkResponse({ schema: zodApiSchema(grantIssueResultSchema) })
  @ApiHttpErrors(400, 401, 403, 409, 429)
  device(
    @Req() req: RequestWithKiosk,
    @Body(new ZodValidationPipe(deviceGrantRequestSchema)) body: DeviceGrantRequest,
  ) {
    return this.issuer.issueDevice(identity(req), body.requestId);
  }
  @ApiOperation({ summary: "Issue a signed grant for an authenticated frozen task" })
  @Post("tasks")
  @HttpCode(200)
  @RequireSubscriptionWrite()
  @ApiZodBody(taskGrantRequestSchema)
  @ApiOkResponse({ schema: zodApiSchema(grantIssueResultSchema) })
  @ApiHttpErrors(400, 401, 403, 409, 429)
  tasks(
    @Req() req: RequestWithKiosk,
    @Body(new ZodValidationPipe(taskGrantRequestSchema)) body: TaskGrantRequest,
  ) {
    return this.issuer.issueTask(
      identity(req),
      { taskKind: body.taskKind, taskId: body.taskId },
      body.requestId,
    );
  }
  @ApiOperation({ summary: "Refresh authenticated offline grant configuration" })
  @Post("configuration")
  @HttpCode(200)
  @AllowSubscriptionReadOnly("read")
  @ApiZodBody(deviceGrantRequestSchema)
  @ApiOkResponse({ schema: zodApiSchema(grantConfigurationSchema) })
  @ApiHttpErrors(400, 401, 403, 429)
  configuration(
    @Req() req: RequestWithKiosk,
    @Body(new ZodValidationPipe(deviceGrantRequestSchema)) _body: DeviceGrantRequest,
  ) {
    return this.issuer.configuration(identity(req));
  }
  @ApiOperation({ summary: "Report a durable offline grant installation" })
  @Post("readiness")
  @HttpCode(200)
  @AllowSubscriptionReadOnly("read")
  @ApiZodBody(grantClientReadinessRequestSchema)
  @ApiOkResponse({ schema: zodApiSchema(grantClientReadinessResponseSchema) })
  @ApiHttpErrors(400, 401, 403, 409, 429)
  readiness(
    @Req() req: RequestWithKiosk,
    @Body(new ZodValidationPipe(grantClientReadinessRequestSchema))
    body: GrantClientReadinessRequest,
  ) {
    return this.readinessService.report(identity(req), body);
  }
  @ApiOperation({ summary: "Read the authenticated offline grant verifier keyset" })
  @Get("keyset")
  @AllowSubscriptionReadOnly("read")
  @ApiOkResponse({ schema: zodApiSchema(grantKeysetResultSchema) })
  @ApiHttpErrors(401, 403, 429)
  keyset(@Req() req: RequestWithKiosk) {
    return this.issuer.keyset(identity(req));
  }
  @ApiOperation({ summary: "Attest and freeze a kiosk reservation for offline grants" })
  @Post("reservations")
  @HttpCode(200)
  @RequireSubscriptionWrite()
  @ApiZodBody(kioskGrantReservationRequestSchema)
  @ApiOkResponse({ schema: zodApiSchema(kioskGrantReservationResultSchema) })
  @ApiHttpErrors(400, 401, 403, 409, 429)
  reservations(
    @Req() req: RequestWithKiosk,
    @Body(new ZodValidationPipe(kioskGrantReservationRequestSchema))
    body: KioskGrantReservationRequest,
  ) {
    const parsed = createOrderAdmissionSchema.safeParse(body.order);
    if (!parsed.success)
      throw new BadRequestException(
        parsed.error.issues.map((issue) => ({
          path: issue.path.join("."),
          message: issue.message,
        })),
      );
    const order = parsed.data;
    return this.issuer.reserve(identity(req), body.requestId, async (tx, owner, policy) => {
      const admission = await this.pickup.attestKioskOrder(
        owner.tenantId,
        owner.deviceId,
        order,
        owner,
        tx,
      );
      const [reservation] = await tx
        .select({ id: schema.kioskOrderAdmissions.id })
        .from(schema.kioskOrderAdmissions)
        .where(
          and(
            eq(schema.kioskOrderAdmissions.tenantId, owner.tenantId),
            eq(schema.kioskOrderAdmissions.kioskId, owner.deviceId),
            eq(schema.kioskOrderAdmissions.deviceSeq, order.deviceSeq),
          ),
        );
      if (!reservation) throw new Error("Reservation was not persisted");
      const frozen = await freezeGrantTask(
        tx,
        owner,
        { taskKind: "pickup", taskId: reservation.id },
        policy,
      );
      if (frozen.status === "denied") return frozen;
      return {
        status: "reserved" as const,
        protocol: "offline-grants-v1" as const,
        admission,
        task: {
          taskKind: "pickup" as const,
          taskId: reservation.id,
          snapshotDigest: frozen.task.snapshotDigest,
        },
      };
    });
  }
  @Post("evidence/orders")
  @HttpCode(200)
  @AllowSubscriptionRecovery("kiosk")
  @ApiOperation({ summary: "Retain negotiated pickup evidence and return durable reconciliation" })
  @ApiZodBody(grantEvidenceEnvelopeSchema)
  @ApiOkResponse({ schema: zodApiSchema(grantEvidenceReceiptSchema) })
  @ApiHttpErrors(400, 401, 403, 409, 413, 429)
  evidenceOrder(
    @Req() req: RequestWithKiosk & { rawBody?: Buffer },
    @Body(new ZodValidationPipe(grantEvidenceEnvelopeSchema)) body: GrantEvidenceEnvelope,
  ) {
    return this.evidence.kioskOrder(identity(req), body, req.rawBody);
  }
}
