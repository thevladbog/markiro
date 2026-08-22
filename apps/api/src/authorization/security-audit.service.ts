import { Injectable, Logger } from "@nestjs/common";
import type { CabinetCapability } from "@markiro/domain";

interface AuthorizationDeniedEvent {
  tenantId: string | null;
  userId: string | null;
  action: string;
  reason: string;
  required: readonly CabinetCapability[];
  outcome: "denied";
}

interface CredentialMutationEvent {
  tenantId: string;
  userId: string;
  action: string;
  resourceId: string | null;
  outcome: "succeeded" | "failed";
}

interface DeviceCredentialMutationEvent {
  tenantId: string | null;
  actorType: "unauthenticated_device" | "kiosk_device" | "system";
  actorId: string | null;
  action: string;
  resourceId: string | null;
  outcome: "succeeded" | "failed";
}

interface SensitiveReadEvent {
  tenantId: string;
  userId: string | null;
  action: string;
  resourceId: string | null;
}

@Injectable()
export class SecurityAuditService {
  private readonly logger = new Logger("SecurityAudit");

  authorizationDenied(event: AuthorizationDeniedEvent): void {
    this.logger.log(
      JSON.stringify({
        tenantId: event.tenantId,
        userId: event.userId,
        action: event.action,
        reason: event.reason,
        required: event.required,
        outcome: event.outcome,
      }),
    );
  }

  credentialMutation(event: CredentialMutationEvent): void {
    this.logger.log(
      JSON.stringify({
        tenantId: event.tenantId,
        userId: event.userId,
        action: event.action,
        resourceId: event.resourceId,
        outcome: event.outcome,
      }),
    );
  }

  deviceCredentialMutation(event: DeviceCredentialMutationEvent): void {
    this.logger.log(
      JSON.stringify({
        tenantId: event.tenantId,
        actorType: event.actorType,
        actorId: event.actorId,
        action: event.action,
        resourceId: event.resourceId,
        outcome: event.outcome,
      }),
    );
  }

  /**
   * A successful read of data whose exposure matters (raw KM payloads for
   * the box sell-codes screen): logged with the same structured shape as
   * mutations so the audit trail answers "who saw box X's codes and when".
   */
  sensitiveRead(event: SensitiveReadEvent): void {
    this.logger.log(
      JSON.stringify({
        tenantId: event.tenantId,
        userId: event.userId,
        action: event.action,
        resourceId: event.resourceId,
        outcome: "succeeded",
      }),
    );
  }
}
