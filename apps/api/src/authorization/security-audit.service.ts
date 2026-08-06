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
}
