import { ConflictException, InternalServerErrorException } from "@nestjs/common";
import type { QuantitativeEntitlementKey } from "./entitlements.types";

export class SubscriptionLimitReachedException extends ConflictException {
  constructor(entitlement: QuantitativeEntitlementKey, used: number, limit: number) {
    super({ code: "subscription_limit_reached", entitlement, used, limit });
  }
}

export class SubscriptionUnmanagedException extends ConflictException {
  constructor() {
    super({ code: "subscription_unmanaged" });
  }
}

export class SubscriptionEntitlementsInvalidException extends InternalServerErrorException {
  constructor() {
    super({ code: "subscription_entitlements_invalid" });
  }
}
