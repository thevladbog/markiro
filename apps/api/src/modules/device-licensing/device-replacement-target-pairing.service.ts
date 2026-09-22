import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { and, eq, isNull } from "drizzle-orm";
import { schema, type Db } from "@markiro/db";
import {
  deviceReplacementRecoveryCodeRequestSchema,
  deviceReplacementRecoveryCodeResponseSchema,
  platformUuidSchema,
  type DeviceReplacementRecoveryCodeRequest,
} from "@markiro/platform-contracts";
import { DB } from "../../auth/auth.module";
import { EntitlementsService } from "../../subscriptions/entitlements.service";
import { PlatformAuditService } from "../../platform-auth/platform-audit.service";
import { lockGrantFacts } from "../device-grants/grant-admission";
import {
  requireDeviceLicensingActor,
  type DeviceLicensingActor,
} from "./device-licensing-authority";
import { replacementPreparationProjection } from "./device-replacement-readiness-projection";
import { replacementDigest } from "./device-replacement-facts";
import {
  assertReservationOpen,
  workingAssignment,
} from "../../subscriptions/working-device-assignments";
import { hashPairingCode } from "../../pickup/device-token";
import { loadEnv } from "../../env";
import { mintPairingCode, PAIRING_TTL_MS } from "../device-pairing/pairing-policy";

const conflict = () => new ConflictException({ code: "device_replacement_request_conflict" });
/** Platform issuance keeps its own actor boundary; cabinet uses the established station route. */
@Injectable()
export class DeviceReplacementTargetPairingService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly entitlements: EntitlementsService,
    private readonly audit: PlatformAuditService,
  ) {}
  async issueCode(
    tenantId: string,
    preparationId: string,
    input: DeviceReplacementRecoveryCodeRequest,
    actor: DeviceLicensingActor,
  ) {
    const parsed = deviceReplacementRecoveryCodeRequestSchema.safeParse(input);
    if (!parsed.success || !platformUuidSchema.safeParse(preparationId).success)
      throw new BadRequestException();
    const body = parsed.data;
    return this.db.transaction(async (tx) => {
      await lockGrantFacts(tx, tenantId, this.entitlements);
      const authority = await requireDeviceLicensingActor(tx, tenantId, actor, true);
      if (actor.domain !== "platform") throw new BadRequestException();
      await this.entitlements.assertWriteAccess(tenantId, tx, new Date());
      const [preparation] = await tx
        .select()
        .from(schema.workingDeviceReplacementPreparations)
        .where(
          and(
            eq(schema.workingDeviceReplacementPreparations.tenantId, tenantId),
            eq(schema.workingDeviceReplacementPreparations.id, preparationId),
          ),
        );
      if (!preparation) throw new NotFoundException();
      const [execution] = await tx
        .select()
        .from(schema.workingDeviceReplacementExecutions)
        .where(
          and(
            eq(schema.workingDeviceReplacementExecutions.tenantId, tenantId),
            eq(schema.workingDeviceReplacementExecutions.preparationId, preparationId),
          ),
        )
        .for("update");
      if (
        preparation.state !== "completed" ||
        execution?.state !== "completed" ||
        execution.step !== "transferred" ||
        !execution.credentialRevokedAt ||
        !execution.targetDeviceId ||
        execution.revision !== body.expectedRevision
      )
        throw conflict();
      const [prior] = await tx
        .select({ id: schema.workingDeviceEvents.id })
        .from(schema.workingDeviceEvents)
        .where(
          and(
            eq(schema.workingDeviceEvents.tenantId, tenantId),
            eq(schema.workingDeviceEvents.requestId, body.requestId),
          ),
        );
      if (prior) throw conflict(); // Plaintext is never replayed; a fresh issuance retires the previous code.
      const [target] = await tx
        .select()
        .from(schema.stationDevices)
        .where(
          and(
            eq(schema.stationDevices.tenantId, tenantId),
            eq(schema.stationDevices.id, execution.targetDeviceId),
          ),
        )
        .for("update");
      const assignment = await workingAssignment(tx, tenantId, execution.targetDeviceId);
      assertReservationOpen(assignment);
      if (!target || target.revokedAt || target.apiKeyId || assignment?.state !== "reserved")
        throw conflict();
      const before = await replacementPreparationProjection(tx, preparation);
      const now = new Date(),
        expiresAt = new Date(now.getTime() + PAIRING_TTL_MS);
      await tx
        .update(schema.stationPairingCodes)
        .set({ usedAt: now })
        .where(
          and(
            eq(schema.stationPairingCodes.tenantId, tenantId),
            eq(schema.stationPairingCodes.stationDeviceId, target.id),
            isNull(schema.stationPairingCodes.usedAt),
          ),
        );
      let secret: { id: string; code: string } | undefined;
      for (let attempt = 0; attempt < 5; attempt++) {
        const code = mintPairingCode();
        const [inserted] = await tx
          .insert(schema.stationPairingCodes)
          .values({
            tenantId,
            stationDeviceId: target.id,
            purpose: "normal",
            codeHash: hashPairingCode(code, loadEnv().PAIRING_CODE_PEPPER),
            expiresAt,
            issuedByUserId: authority.id,
          })
          .onConflictDoNothing()
          .returning({ id: schema.stationPairingCodes.id });
        if (inserted) {
          secret = { id: inserted.id, code };
          break;
        }
      }
      if (!secret) throw new Error("Could not mint target pairing code");
      await tx
        .update(schema.workingDeviceReplacementExecutions)
        .set({ revision: execution.revision + 1 })
        .where(
          and(
            eq(schema.workingDeviceReplacementExecutions.tenantId, tenantId),
            eq(schema.workingDeviceReplacementExecutions.id, execution.id),
          ),
        );
      const projection = await replacementPreparationProjection(tx, preparation);
      const receipt = { requestId: body.requestId, preparation: projection };
      const binding = {
        operation: "issue_replacement_target_code",
        preparationId,
        executionId: execution.id,
        targetDeviceId: target.id,
        targetKind: target.kind,
        targetEpoch: target.credentialEpoch,
        purpose: "normal",
        pairingCodeId: secret.id,
      };
      await tx.insert(schema.workingDeviceEvents).values({
        tenantId,
        deviceId: target.id,
        actorDomain: "platform",
        actorId: authority.id,
        action: "observed",
        requestId: body.requestId,
        requestHash: replacementDigest({ ...binding, ...body }),
        before,
        after: binding,
        response: receipt,
      });
      await this.audit.record(tx, {
        actorPlatformUserId: authority.id,
        actorRole: authority.role,
        tenantId,
        action: "device.replacement.target_code_issued",
        outcome: "success",
        targetType: "device_replacement",
        targetId: preparationId,
        requestId: body.requestId,
        reason: null,
        before: { executionRevision: execution.revision },
        after: binding,
      });
      return deviceReplacementRecoveryCodeResponseSchema.parse({
        ...receipt,
        code: secret.code,
        expiresAt: expiresAt.toISOString(),
      });
    });
  }
}
