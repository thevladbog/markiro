/** Native offline grants v1. Every timestamp is integer Unix milliseconds. */
export type DeviceKind = "station" | "handheld" | "kiosk";
export type GrantCapability = "shift.start.v1" | "inventory.start.v1" | "pickup.start.v1";
export type GrantEventType =
  | "shift.scan.v1"
  | "shift.box.close.v1"
  | "shift.pallet.close.v1"
  | "shift.label.prepare.v1"
  | "shift.close.v1"
  | "inventory.scan.v1"
  | "inventory.repack.v1"
  | "inventory.box.close.v1"
  | "inventory.close.v1"
  | "pickup.complete.v1";
export interface GrantOwner {
  tenantId: string;
  deviceId: string;
  kind: DeviceKind;
  credentialEpoch: number;
}
export interface GrantBase extends GrantOwner {
  version: 1;
  issuer: string;
  grantId: string;
  entitlementRevision: string;
  policyRevision: string;
  issuedAt: number;
  notBefore: number;
}
export interface DeviceGrant extends GrantBase {
  kindOfGrant: "device";
  startNotAfter: number;
  capabilities: GrantCapability[];
}
export interface BudgetLine {
  id: string;
  unit: "event" | "unit" | "container";
  maximum: number;
}
export interface TaskGrant extends GrantBase {
  kindOfGrant: "task";
  taskKind: "shift" | "inventory" | "pickup";
  taskId: string;
  snapshotDigest: string;
  completeNotAfter: number;
  eventTypes: GrantEventType[];
  budget: BudgetLine[];
}
export type OfflineGrant = DeviceGrant | TaskGrant;
export interface GrantTaskSnapshot {
  taskKind: "shift" | "inventory" | "pickup";
  taskId: string;
  snapshotDigest: string;
  /** Hash these exact UTF-8 bytes; do not reserialize across runtimes. */
  canonical: string;
}
export interface GrantEnvelope {
  protocol: "offline-grants-v1";
  serverTime: number;
  owner: GrantOwner;
  mode: "observe" | "strict";
  /** Original compact JWS strings, never reserialized. */
  grants: string[];
  taskSnapshots: GrantTaskSnapshot[];
}
export type GrantIssueResult =
  | { status: "issued"; envelope: GrantEnvelope }
  | {
      status: "denied";
      reason:
        | "policy_not_configured"
        | "not_entitled"
        | "facts_unknown"
        | "task_not_frozen"
        | "bounds_required";
    };
