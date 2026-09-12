import { SetMetadata } from "@nestjs/common";
import type { FeatureEntitlementKey } from "./entitlements.types";

export const ROUTE_SUBSCRIPTION_ACCESS_POLICY = Symbol.for("markiro.subscription-access-policy");

export type SubscriptionRecoveryKind = "station" | "kiosk" | "shift";
export type SubscriptionLicensingOperation =
  | "inspect"
  | "cancel_reservation"
  | "replacement_preview"
  | "replacement_confirm"
  | "replacement_cancel"
  | "retention_preview"
  | "retention_confirm";

export type SubscriptionAccessPolicy =
  | { mode: "write" }
  | { mode: "feature"; entitlement: FeatureEntitlementKey }
  | { mode: "recovery"; kind: SubscriptionRecoveryKind }
  | { mode: "licensing"; operation: SubscriptionLicensingOperation }
  | { mode: "read_only_allowed"; reason: "export" | "read" | "security" };

export const RequireSubscriptionWrite = () =>
  SetMetadata(ROUTE_SUBSCRIPTION_ACCESS_POLICY, {
    mode: "write",
  } satisfies SubscriptionAccessPolicy);

export const RequireFeature = (entitlement: FeatureEntitlementKey) =>
  SetMetadata(ROUTE_SUBSCRIPTION_ACCESS_POLICY, {
    mode: "feature",
    entitlement,
  } satisfies SubscriptionAccessPolicy);

export const AllowSubscriptionRecovery = (kind: SubscriptionRecoveryKind) =>
  SetMetadata(ROUTE_SUBSCRIPTION_ACCESS_POLICY, {
    mode: "recovery",
    kind,
  } satisfies SubscriptionAccessPolicy);

export const AllowSubscriptionLicensing = (operation: SubscriptionLicensingOperation) =>
  SetMetadata(ROUTE_SUBSCRIPTION_ACCESS_POLICY, {
    mode: "licensing",
    operation,
  } satisfies SubscriptionAccessPolicy);

export const AllowSubscriptionReadOnly = (reason: "export" | "read" | "security") =>
  SetMetadata(ROUTE_SUBSCRIPTION_ACCESS_POLICY, {
    mode: "read_only_allowed",
    reason,
  } satisfies SubscriptionAccessPolicy);
