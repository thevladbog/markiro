import "reflect-metadata";
import { describe, expect, it } from "vitest";
import { ApiKeysController } from "../src/modules/api-keys/api-keys.controller";
import { ConflictsController } from "../src/modules/conflicts/conflicts.controller";
import { CounterpartiesController } from "../src/modules/counterparties/counterparties.controller";
import { EmployeesController } from "../src/modules/employees/employees.controller";
import {
  IntegrationsController,
  ProductExternalLinkController,
} from "../src/modules/integrations/integrations.controller";
import { KioskController } from "../src/modules/kiosk/kiosk.controller";
import { KiosksController } from "../src/modules/kiosks/kiosks.controller";
import { LabelTemplatesController } from "../src/modules/label-templates/label-templates.controller";
import { LinesController } from "../src/modules/lines/lines.controller";
import { OperatorsController } from "../src/modules/operators/operators.controller";
import { OrgProfileController } from "../src/modules/org-profile/org-profile.controller";
import { PickupOrdersController } from "../src/modules/pickup-orders/pickup-orders.controller";
import { PickupReasonsController } from "../src/modules/pickup-reasons/pickup-reasons.controller";
import { PickupRejectionsController } from "../src/modules/pickup-rejections/pickup-rejections.controller";
import { ProductsController } from "../src/modules/products/products.controller";
import { ShiftsController } from "../src/modules/shifts/shifts.controller";
import { StationDevicesController } from "../src/modules/station-devices/station-devices.controller";
import { StationScansController } from "../src/modules/station-scans/station-scans.controller";
import { TeamController } from "../src/modules/team/team.controller";

const ROUTE_SUBSCRIPTION_ACCESS_POLICY = Symbol.for("markiro.subscription-access-policy");

type ExpectedPolicy =
  | { mode: "write" }
  | { mode: "feature"; entitlement: "labelEditor" | "publicApi" | "pallets" }
  | { mode: "recovery"; kind: "station" | "kiosk" | "shift" }
  | { mode: "read_only_allowed"; reason: "export" | "read" | "security" };

function policy(controller: object, handler: string): unknown {
  const method = Object.getOwnPropertyDescriptor(controller, handler)?.value as object | undefined;
  return method ? Reflect.getMetadata(ROUTE_SUBSCRIPTION_ACCESS_POLICY, method) : undefined;
}

describe("subscription route classification", () => {
  it.each([
    [
      LabelTemplatesController.prototype,
      "createLabelTemplate",
      { mode: "feature", entitlement: "labelEditor" },
    ],
    [
      LabelTemplatesController.prototype,
      "updateLabelTemplate",
      { mode: "feature", entitlement: "labelEditor" },
    ],
    [
      LabelTemplatesController.prototype,
      "deleteLabelTemplate",
      { mode: "feature", entitlement: "labelEditor" },
    ],
    [ApiKeysController.prototype, "create", { mode: "feature", entitlement: "publicApi" }],
    [ShiftsController.prototype, "createShift", { mode: "write" }],
    [ShiftsController.prototype, "updateShift", { mode: "write" }],
    [ShiftsController.prototype, "deleteShift", { mode: "write" }],
    [ShiftsController.prototype, "openShift", { mode: "write" }],
    [ShiftsController.prototype, "closeShift", { mode: "recovery", kind: "shift" }],
    [StationScansController.prototype, "ingest", { mode: "recovery", kind: "station" }],
    [KioskController.prototype, "createOrder", { mode: "recovery", kind: "kiosk" }],
    [PickupOrdersController.prototype, "resolve", { mode: "write" }],
    [PickupOrdersController.prototype, "cancel", { mode: "write" }],
    [StationDevicesController.prototype, "create", { mode: "write" }],
    [StationDevicesController.prototype, "update", { mode: "write" }],
    [
      StationDevicesController.prototype,
      "revoke",
      { mode: "read_only_allowed", reason: "security" },
    ],
    [StationDevicesController.prototype, "issuePairingCode", { mode: "write" }],
    [KiosksController.prototype, "createKiosk", { mode: "write" }],
    [KiosksController.prototype, "updateKiosk", { mode: "write" }],
    [KiosksController.prototype, "archiveKiosk", { mode: "read_only_allowed", reason: "security" }],
    [KiosksController.prototype, "unbindKiosk", { mode: "read_only_allowed", reason: "security" }],
    [KiosksController.prototype, "setProducts", { mode: "write" }],
    [KiosksController.prototype, "enroll", { mode: "write" }],
    [KiosksController.prototype, "issuePairingCode", { mode: "write" }],
    [ApiKeysController.prototype, "revoke", { mode: "read_only_allowed", reason: "security" }],
    [PickupOrdersController.prototype, "export", { mode: "read_only_allowed", reason: "export" }],
    [ConflictsController.prototype, "reviewConflict", { mode: "write" }],
    [CounterpartiesController.prototype, "createCounterparty", { mode: "write" }],
    [CounterpartiesController.prototype, "updateCounterparty", { mode: "write" }],
    [CounterpartiesController.prototype, "deleteCounterparty", { mode: "write" }],
    [CounterpartiesController.prototype, "putSscc", { mode: "write" }],
    [EmployeesController.prototype, "createEmployee", { mode: "write" }],
    [EmployeesController.prototype, "updateEmployee", { mode: "write" }],
    [EmployeesController.prototype, "archiveEmployee", { mode: "write" }],
    [EmployeesController.prototype, "issueBadge", { mode: "write" }],
    [
      EmployeesController.prototype,
      "revokeBadge",
      { mode: "read_only_allowed", reason: "security" },
    ],
    [IntegrationsController.prototype, "update", { mode: "write" }],
    [IntegrationsController.prototype, "issueCredentials", { mode: "write" }],
    [IntegrationsController.prototype, "linkCandidate", { mode: "write" }],
    [IntegrationsController.prototype, "hideCandidate", { mode: "write" }],
    [IntegrationsController.prototype, "unhideCandidate", { mode: "write" }],
    [ProductExternalLinkController.prototype, "unlink", { mode: "write" }],
    [LinesController.prototype, "createLine", { mode: "write" }],
    [LinesController.prototype, "updateLine", { mode: "write" }],
    [LinesController.prototype, "deleteLine", { mode: "write" }],
    [OperatorsController.prototype, "grantAccess", { mode: "write" }],
    [OperatorsController.prototype, "updateAccess", { mode: "write" }],
    [
      OperatorsController.prototype,
      "revokeAccess",
      { mode: "read_only_allowed", reason: "security" },
    ],
    [OrgProfileController.prototype, "putProfile", { mode: "write" }],
    [OrgProfileController.prototype, "putSscc", { mode: "write" }],
    [PickupReasonsController.prototype, "createReason", { mode: "write" }],
    [PickupReasonsController.prototype, "updateReason", { mode: "write" }],
    [PickupReasonsController.prototype, "archiveReason", { mode: "write" }],
    [PickupRejectionsController.prototype, "acknowledge", { mode: "write" }],
    [ProductsController.prototype, "checkGtinOwner", { mode: "read_only_allowed", reason: "read" }],
    [ProductsController.prototype, "createProduct", { mode: "write" }],
    [ProductsController.prototype, "updateProduct", { mode: "write" }],
    [ProductsController.prototype, "deleteProduct", { mode: "write" }],
    [TeamController.prototype, "createInvitation", { mode: "write" }],
    [TeamController.prototype, "resendInvitation", { mode: "write" }],
    [
      TeamController.prototype,
      "cancelInvitation",
      { mode: "read_only_allowed", reason: "security" },
    ],
    [TeamController.prototype, "updateMember", { mode: "write" }],
    [TeamController.prototype, "linkEmployee", { mode: "write" }],
    [TeamController.prototype, "unlinkEmployee", { mode: "write" }],
    [TeamController.prototype, "removeMember", { mode: "read_only_allowed", reason: "security" }],
  ] satisfies Array<[object, string, ExpectedPolicy]>)(
    "classifies %s.%s explicitly",
    (controller, handler, expected) => {
      expect(policy(controller, handler)).toEqual(expected);
    },
  );

  it.each([
    [LabelTemplatesController.prototype, "listLabelTemplates"],
    [LabelTemplatesController.prototype, "getLabelTemplate"],
    [ApiKeysController.prototype, "list"],
    [KioskController.prototype, "bootstrap"],
  ])(
    "does not turn approved read, export, or security route %s.%s into a subscription write",
    (controller, handler) => {
      expect(policy(controller, handler)).toBeUndefined();
    },
  );
});
