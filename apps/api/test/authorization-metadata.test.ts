import type { Type } from "@nestjs/common";
import { GUARDS_METADATA, PATH_METADATA } from "@nestjs/common/constants";
import { Reflector } from "@nestjs/core";
import { describe, expect, it } from "vitest";
import {
  ROUTE_ACCESS_POLICY,
  type RouteAccessPolicy,
} from "../src/authorization/access-policy";
import { AuthorizationGuard } from "../src/authorization/authorization.guard";
import { BoxExceptionsController } from "../src/modules/box-exceptions/box-exceptions.controller";
import { BoxesController } from "../src/modules/boxes/boxes.controller";
import { ConflictsController } from "../src/modules/conflicts/conflicts.controller";
import { CounterpartiesController } from "../src/modules/counterparties/counterparties.controller";
import { EmployeesController } from "../src/modules/employees/employees.controller";
import { LabelTemplatesController } from "../src/modules/label-templates/label-templates.controller";
import { LinesController } from "../src/modules/lines/lines.controller";
import { OperatorsController } from "../src/modules/operators/operators.controller";
import { StationOperatorsController } from "../src/modules/operators/station-operators.controller";
import { PickupOrdersController } from "../src/modules/pickup-orders/pickup-orders.controller";
import { PickupReasonsController } from "../src/modules/pickup-reasons/pickup-reasons.controller";
import { PickupRejectionsController } from "../src/modules/pickup-rejections/pickup-rejections.controller";
import { ProductsController } from "../src/modules/products/products.controller";
import { ShiftsController } from "../src/modules/shifts/shifts.controller";
import { StationScansController } from "../src/modules/station-scans/station-scans.controller";
import { StationOnlyGuard } from "../src/tenancy/station-only.guard";
import { TenantGuard } from "../src/tenancy/tenant.guard";

type ControllerClass = {
  name: string;
  prototype: object;
};

const readPolicy = {
  mode: "cabinet",
  capabilities: ["operations.read"],
} satisfies RouteAccessPolicy;
const writePolicy = {
  mode: "cabinet",
  capabilities: ["operations.write"],
} satisfies RouteAccessPolicy;
const sharedReadPolicy = {
  mode: "station-or-cabinet",
  capabilities: ["operations.read"],
} satisfies RouteAccessPolicy;
const sharedWritePolicy = {
  mode: "station-or-cabinet",
  capabilities: ["operations.write"],
} satisfies RouteAccessPolicy;

const OPERATIONAL_CONTROLLERS: readonly [
  ControllerClass,
  Readonly<Record<string, RouteAccessPolicy>>,
][] = [
  [BoxesController, { listBoxes: readPolicy }],
  [BoxExceptionsController, { listBoxExceptions: readPolicy }],
  [
    EmployeesController,
    {
      listEmployees: readPolicy,
      createEmployee: writePolicy,
      updateEmployee: writePolicy,
      archiveEmployee: writePolicy,
      issueBadge: writePolicy,
      revokeBadge: writePolicy,
    },
  ],
  [
    PickupReasonsController,
    {
      listReasons: readPolicy,
      createReason: writePolicy,
      updateReason: writePolicy,
      archiveReason: writePolicy,
    },
  ],
  [
    LinesController,
    {
      listLines: readPolicy,
      getLine: readPolicy,
      createLine: writePolicy,
      updateLine: writePolicy,
      deleteLine: writePolicy,
    },
  ],
  [
    CounterpartiesController,
    {
      listCounterparties: readPolicy,
      getCounterparty: readPolicy,
      createCounterparty: writePolicy,
      updateCounterparty: writePolicy,
      deleteCounterparty: writePolicy,
      getSscc: readPolicy,
      putSscc: writePolicy,
    },
  ],
  [
    LabelTemplatesController,
    {
      listLabelTemplates: readPolicy,
      getLabelTemplate: readPolicy,
      createLabelTemplate: writePolicy,
      updateLabelTemplate: writePolicy,
      deleteLabelTemplate: writePolicy,
    },
  ],
  [ConflictsController, { listConflicts: readPolicy, reviewConflict: writePolicy }],
  [
    OperatorsController,
    {
      listOperators: readPolicy,
      grantAccess: writePolicy,
      updateAccess: writePolicy,
      revokeAccess: writePolicy,
    },
  ],
  [PickupRejectionsController, { list: readPolicy, acknowledge: writePolicy }],
  [
    PickupOrdersController,
    {
      list: readPolicy,
      detail: readPolicy,
      slip: readPolicy,
      resolve: writePolicy,
      cancel: writePolicy,
      export: writePolicy,
    },
  ],
  [
    ProductsController,
    {
      listProducts: sharedReadPolicy,
      checkGtinOwner: sharedReadPolicy,
      getProduct: readPolicy,
      createProduct: writePolicy,
      updateProduct: writePolicy,
      deleteProduct: writePolicy,
    },
  ],
  [
    ShiftsController,
    {
      listShifts: sharedReadPolicy,
      getShift: readPolicy,
      createShift: sharedWritePolicy,
      updateShift: writePolicy,
      deleteShift: writePolicy,
      closeShift: writePolicy,
      openShift: sharedWritePolicy,
      getBundle: sharedReadPolicy,
    },
  ],
];

const STATION_ONLY_CONTROLLERS: readonly [ControllerClass, readonly string[]][] = [
  [StationOperatorsController, ["listRoster"]],
  [StationScansController, ["ingest"]],
];

const reflector = new Reflector();

function routeMethods(controller: ControllerClass): string[] {
  const prototype = controller.prototype as Record<string, (...args: never[]) => unknown>;
  return Object.getOwnPropertyNames(prototype).filter((methodName) => {
    if (methodName === "constructor") return false;
    return Reflect.getMetadata(PATH_METADATA, prototype[methodName]!) !== undefined;
  });
}

describe("operational route authorization metadata", () => {
  it.each(OPERATIONAL_CONTROLLERS)(
    "%s declares the exact policy for every route",
    (controller, expectedPolicies) => {
      const classGuards = Reflect.getMetadata(GUARDS_METADATA, controller) ?? [];
      expect(classGuards).toContain(TenantGuard);
      expect(classGuards).toContain(AuthorizationGuard);

      const methodNames = routeMethods(controller);
      expect(methodNames.sort()).toEqual(Object.keys(expectedPolicies).sort());

      const prototype = controller.prototype as Record<
        string,
        (...args: never[]) => unknown
      >;
      for (const methodName of methodNames) {
        const handler = prototype[methodName]!;
        const methodGuards = Reflect.getMetadata(GUARDS_METADATA, handler) ?? [];
        const guardNames = [...classGuards, ...methodGuards].map(
          (guard: { name?: string }) => guard.name,
        );
        expect(guardNames, `${controller.name}.${methodName}`).not.toContain("SessionOnlyGuard");

        const policy = reflector.getAllAndOverride<RouteAccessPolicy>(ROUTE_ACCESS_POLICY, [
          handler,
          controller as unknown as Type<unknown>,
        ]);
        expect(policy, `${controller.name}.${methodName}`).toEqual(expectedPolicies[methodName]);
      }
    },
  );

  it.each(STATION_ONLY_CONTROLLERS)(
    "%s is station-only and enumerates every machine route",
    (controller, expectedMethods) => {
      const classGuards = Reflect.getMetadata(GUARDS_METADATA, controller) ?? [];
      expect(classGuards).toContain(TenantGuard);
      expect(classGuards).toContain(StationOnlyGuard);
      expect(classGuards).not.toContain(AuthorizationGuard);
      expect(routeMethods(controller).sort()).toEqual([...expectedMethods].sort());
    },
  );
});
