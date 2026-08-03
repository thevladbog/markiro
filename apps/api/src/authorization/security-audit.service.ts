import { Injectable, Logger } from "@nestjs/common";
import type { CabinetCapability } from "@markiro/domain";

interface AuthorizationDeniedEvent {
  tenantId: string | null;
  userId: string | null;
  reason: string;
  required: readonly CabinetCapability[];
}

interface CredentialMutationEvent {
  tenantId: string;
  userId: string;
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
        reason: event.reason,
        required: event.required,
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
      }),
    );
  }
}
